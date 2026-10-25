import consola from 'consola';
import { createHash, randomUUID } from 'crypto';
import { envInt } from '../../utils/envNumber';
import redis from '../redisClient';
import { readTokenSession } from './tokens';
import { profileKey, profileUserId } from './profiles';
import { dashedGuid } from './idsCodec';

const logger = consola.withTag('Jellyfin');

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const PATH = /^\/jellyfin\/([^/?]+)(?:\/emby)?\/socket(?:\?|$)/i;

function accept(key: string): string {
  return createHash('sha1').update(key + GUID).digest('base64');
}

function reject(socket: any, status: number, text: string): void {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

/** Text frames only. A server frame is never masked. */
function textFrame(payload: string): Buffer {
  const body = Buffer.from(payload, 'utf8');
  if (body.length > 0xffff) {
    const header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
    return Buffer.concat([header, body]);
  }
  if (body.length > 125) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  return Buffer.concat([Buffer.from([0x81, body.length]), body]);
}

/** Opcode and unmasked payload of one client frame, or null if it is partial. */
function readFrame(buffer: Buffer): { opcode: number; payload: Buffer; size: number } | null {
  if (buffer.length < 2) return null;

  const opcode = buffer[0] & 0x0f;
  const masked = (buffer[1] & 0x80) !== 0;
  let length = buffer[1] & 0x7f;
  let offset = 2;

  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }

  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  if (masked) offset += 4;
  if (buffer.length < offset + length) return null;

  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
  }

  return { opcode, payload, size: offset + length };
}

interface Listener {
  userId: string;
  send: (MessageType: string, Data?: any) => void;
}

const listeners = new Map<string, Set<Listener>>();
const pending = new Map<string, Map<string, any>>();

const CHANNEL = 'jf:userdata';
const LISTENING = 'jf:userdata:listening:';
const ORIGIN = randomUUID();
const PUSH_PART = 100;
let subscribed = false;

function deliver(scope: string, list: any[]): void {
  for (const listener of listeners.get(scope) ?? []) {
    listener.send('UserDataChanged', { UserId: listener.userId, UserDataList: list });
  }
}

function subscribe(): void {
  if (subscribed || !redis) return;
  subscribed = true;
  const subscriber = redis.duplicate();
  subscriber.on('error', (error: Error) => logger.debug(`User data subscriber: ${error.message}`));
  subscriber.on('message', (_channel: string, raw: string) => {
    try {
      const message = JSON.parse(raw);
      if (message?.o !== ORIGIN && typeof message?.s === 'string' && Array.isArray(message.l)) deliver(message.s, message.l);
    } catch {
      /* not ours */
    }
  });
  subscriber.subscribe(CHANNEL).catch((error: Error) => {
    subscribed = false;
    subscriber.disconnect();
    logger.debug(`User data subscribe failed: ${error.message}`);
  });
}

function flush(scope: string): void {
  const held = pending.get(scope);
  pending.delete(scope);
  if (!held?.size) return;
  const list = [...held.values()];
  for (let i = 0; i < list.length; i += PUSH_PART) {
    const part = list.slice(i, i + PUSH_PART);
    deliver(scope, part);
    redis?.publish(CHANNEL, JSON.stringify({ o: ORIGIN, s: scope, l: part })).catch(() => undefined);
  }
}

function pingMs(): number {
  return envInt('JELLYFIN_SOCKET_PING_MS', 30000, 1000);
}

function maxFrameBytes(): number {
  const value = Number(require('../settingsService').getSetting('JELLYFIN_SOCKET_MAX_MESSAGE_KB'));
  return (Number.isFinite(value) && value >= 1 ? Math.floor(value) : 64) * 1024;
}

function markListening(scope: string): void {
  redis?.set(`${LISTENING}${scope}`, '1', 'PX', pingMs() * 3).catch(() => undefined);
}

export async function hasListeners(userUUID: string, profile: string): Promise<boolean> {
  const scope = `${userUUID}:${profile}`;
  if (listeners.get(scope)?.size) return true;
  if (!redis) return false;
  try {
    return (await redis.exists(`${LISTENING}${scope}`)) === 1;
  } catch {
    return false;
  }
}

export function pushUserData(userUUID: string, profile: string, entries: any[]): void {
  if (!entries.length) return;
  const scope = `${userUUID}:${profile}`;
  let held = pending.get(scope);
  if (!held) {
    held = new Map();
    pending.set(scope, held);
    setTimeout(() => flush(scope), envInt('JELLYFIN_USERDATA_PUSH_DELAY_MS', 500, 0));
  }
  for (const entry of entries) held.set(entry.ItemId, entry);
}

async function historyOf(userUUID: string, profileId: string | null): Promise<string> {
  if (!profileId) return '';
  try {
    const { loadConfig } = require('./context');
    const config = await loadConfig({ jellyfin: { userUUID, profileId } });
    return config ? profileKey(config) : profileId;
  } catch {
    return profileId;
  }
}

/**
 * The official clients open this straight after signing in and log an error for
 * the lifetime of the session when it is missing. It carries `UserDataChanged`
 * for each watch state written here.
 */
function pathUser(segment: string): string {
  const { isAliasFeatureEnabled, resolveAliasSync } = require('../aliasResolver');
  const { looksLikeAlias } = require('../userAliases');
  if (!isAliasFeatureEnabled() || !looksLikeAlias(segment)) return segment;
  return resolveAliasSync(segment.toLowerCase()) ?? segment;
}

export function attachJellyfinSocket(server: any): void {
  const perUser = new Map<string, number>();
  const maxPerUser = envInt('JELLYFIN_SOCKETS_PER_USER', 16, 1);

  server.on('upgrade', async (req: any, socket: any, _head: Buffer) => {
    const url = String(req.url ?? '');
    const match = PATH.exec(url);
    if (!match) return;

    const query = new URLSearchParams(url.split('?')[1] ?? '');
    const token = query.get('api_key') ?? query.get('ApiKey') ?? undefined;
    const key = req.headers['sec-websocket-key'];

    if (!key) {
      reject(socket, 400, 'Bad Request');
      return;
    }

    let session: { userUUID: string; profileId: string | null } | null = null;
    try {
      session = await readTokenSession(token ?? undefined);
    } catch {
      reject(socket, 503, 'Service Unavailable');
      return;
    }

    const userUUID = session?.userUUID;
    if (!session || !userUUID || userUUID !== pathUser(decodeURIComponent(match[1]))) {
      reject(socket, 401, 'Unauthorized');
      return;
    }

    if ((perUser.get(userUUID) ?? 0) >= maxPerUser) {
      reject(socket, 429, 'Too Many Requests');
      return;
    }

    const scope = `${userUUID}:${await historyOf(userUUID, session.profileId)}`;
    if (socket.destroyed) return;

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept(String(key))}\r\n\r\n`
    );

    perUser.set(userUUID, (perUser.get(userUUID) ?? 0) + 1);
    socket.setTimeout(0);
    socket.setNoDelay(true);

    const send = (MessageType: string, Data: any = null) => {
      if (!socket.destroyed) socket.write(textFrame(JSON.stringify({ MessageType, MessageId: randomUUID().replace(/-/g, ''), Data })));
    };

    const listener: Listener = { userId: dashedGuid(profileUserId(userUUID, session.profileId)), send };
    let followers = listeners.get(scope);
    if (!followers) {
      followers = new Set();
      listeners.set(scope, followers);
    }
    followers.add(listener);
    subscribe();
    markListening(scope);

    send('ForceKeepAlive', 60);
    let heardAt = Date.now();
    const timer = setInterval(() => {
      if (Date.now() - heardAt > pingMs() * 3) {
        socket.destroy();
        return;
      }
      send('KeepAlive');
      if (!socket.destroyed) socket.write(Buffer.from([0x89, 0x00]));
      markListening(scope);
    }, pingMs());

    const maxPending = maxFrameBytes();
    let pending = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      heardAt = Date.now();
      pending = Buffer.concat([pending, chunk]);

      for (;;) {
        const frame = readFrame(pending);
        if (!frame) break;
        pending = pending.subarray(frame.size);

        if (frame.opcode === 0x8) {
          // Echoed so the client sees a clean close rather than a dropped one.
          socket.write(Buffer.from([0x88, 0x02, 0x03, 0xe8]));
          socket.end();
          return;
        }
        if (frame.opcode === 0x9) {
          socket.write(Buffer.from([0x8a, 0x00]));
          continue;
        }
        if (frame.opcode !== 0x1) continue;

        try {
          if (JSON.parse(frame.payload.toString('utf8'))?.MessageType === 'KeepAlive') send('KeepAlive');
        } catch {
          // A client is free to send anything; nothing here depends on it.
        }
      }
      if (pending.length > maxPending) socket.destroy();
    });

    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      clearInterval(timer);
      const held = listeners.get(scope);
      held?.delete(listener);
      if (held && held.size === 0) listeners.delete(scope);
      const left = (perUser.get(userUUID as string) ?? 1) - 1;
      if (left <= 0) perUser.delete(userUUID as string);
      else perUser.set(userUUID as string, left);
    };

    socket.on('close', release);
    socket.on('error', release);
  });

  logger.debug('Jellyfin websocket attached');
}
