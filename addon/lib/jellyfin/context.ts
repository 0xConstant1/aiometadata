import consola from 'consola';
import { readTokenSession } from './tokens';
import { scopeConfigToProfile } from './profiles';
import { normaliseJellyfinId } from './idsCodec';
import { LRUCache } from 'lru-cache';

const database: any = require('../database');
const redis: any = require('../redisClient');
const { envInt } = require('../../utils/envNumber');

const seenRecently = new LRUCache<string, true>({ max: 10000, ttl: 60 * 60 * 1000 });

// One hash rather than a key each: reading these back was a keyspace scan,
// whose cost is every key on the server and not the few hundred that match.
const SEEN_KEY = 'jf:seen';

// A configuration a client signed in to recently; background work is spent on those alone.
function markSeen(userUUID: string): void {
  if (!redis || seenRecently.has(userUUID)) return;
  seenRecently.set(userUUID, true);
  const ttl = envInt('JELLYFIN_ACTIVE_DAYS', 7, 1) * 24 * 60 * 60;
  redis.multi()
    .hsetex(SEEN_KEY, 'EX', ttl, 'FIELDS', 1, userUUID, '1')
    .expire(SEEN_KEY, ttl, 'NX')
    .expire(SEEN_KEY, ttl, 'GT')
    .exec()
    .catch(() => undefined);
}

/** Every configuration a client signed in to within the active window. */
export async function seenConfigurations(): Promise<string[] | null> {
  if (!redis) return null;
  try {
    return await redis.hkeys(SEEN_KEY);
  } catch {
    return [];
  }
}

export async function seenRecentlyBy(userUUID: string): Promise<boolean> {
  if (seenRecently.has(userUUID)) return true;
  if (!redis) return false;
  try {
    return (await redis.hexists(SEEN_KEY, userUUID)) === 1;
  } catch {
    return false;
  }
}

const logger = consola.withTag('JellyfinAuth');

/**
 * `MediaBrowser Client="Odin", Token="abc"` and the Emby-prefixed spelling of
 * the same header both appear in the wild, alongside three plainer places a
 * client may put the token.
 */
export function parseMediaBrowserHeader(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const body = value.replace(/^(MediaBrowser|Emby)\s+/i, '');
  const out: Record<string, string> = {};
  for (const part of body.split(',')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim().toLowerCase();
    const raw = part.slice(eq + 1).trim();
    out[key] = raw.replace(/^"(.*)"$/, '$1');
  }
  return out;
}

export function extractToken(req: any): string | undefined {
  const header = parseMediaBrowserHeader(
    req.get('authorization') || req.get('x-emby-authorization')
  );
  return (
    header.token ||
    req.get('x-emby-token') ||
    req.get('x-mediabrowser-token') ||
    (typeof req.query?.api_key === 'string' ? req.query.api_key : undefined) ||
    (typeof req.query?.ApiKey === 'string' ? req.query.ApiKey : undefined) ||
    undefined
  );
}

export function clientInfo(req: any): { client: string; device: string; deviceId: string; version: string } {
  const header = parseMediaBrowserHeader(
    req.get('authorization') || req.get('x-emby-authorization')
  );
  return {
    client: header.client || 'Unknown',
    device: header.device || 'Unknown',
    deviceId: header.deviceid || 'unknown',
    version: header.version || '0.0.0',
  };
}

export function serverIdFor(userUUID: string): string {
  return normaliseJellyfinId(userUUID);
}

export async function attachJellyfinContext(req: any, _res: any, next: any): Promise<void> {
  const userUUID = req.params?.userUUID;
  req.jellyfin = { userUUID, token: extractToken(req), authenticated: false, config: null, profileId: null };

  if (!userUUID) {
    next();
    return;
  }

  const token = req.jellyfin.token;
  if (!token) {
    next();
    return;
  }

  try {
    const session = await readTokenSession(token);
    if (session && session.userUUID === userUUID) {
      req.jellyfin.authenticated = true;
      req.jellyfin.profileId = session.profileId;
      markSeen(userUUID);
    }
  } catch (error: any) {
    logger.debug(`Token resolution failed: ${error.message}`);
  }

  next();
}

/** The configuration as the signed-in profile sees it. */
export async function loadConfig(req: any): Promise<any> {
  if (req.jellyfin?.config) return req.jellyfin.config;
  const stored = await database.getUserConfig(req.jellyfin.userUUID);
  if (!stored) return null;

  const config = scopeConfigToProfile(stored, req.jellyfin.userUUID, req.jellyfin.profileId ?? null);
  config.userUUID = req.jellyfin.userUUID;
  req.jellyfin.config = config;
  return config;
}

// Artwork is anonymous in Jellyfin, because a client renders it with a plain
// image tag that cannot carry a token. Requiring one leaves every poster blank
// in the clients that do not put the key in the query.
const ANONYMOUS_PATH = /\/(Items|Users)\/[^/]+\/Images\//i;

export function requireAuth(req: any, res: any, next: any): void {
  if (req.jellyfin?.authenticated || ANONYMOUS_PATH.test(String(req.path || ''))) {
    next();
    return;
  }
  res.status(401).json({ Message: 'Unauthorized' });
}
