import bcrypt from 'bcrypt';
import { LRUCache } from 'lru-cache';
import redis from '../redisClient';
import { envInt } from '../../utils/envNumber';

export const PIN_PATTERN = /^\d{4,12}$/;
const HASH_PATTERN = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

export function isPinHash(value: unknown): value is string {
  return typeof value === 'string' && HASH_PATTERN.test(value);
}

/** `password/PIN` as one field; the whole value is tried first, so a password holding a slash still works. */
export function splitSecret(secret: string): Array<{ password: string; pin: string }> {
  const out = [{ password: secret, pin: '' }];
  const slash = secret.lastIndexOf('/');
  if (slash > 0) out.push({ password: secret.slice(0, slash), pin: secret.slice(slash + 1) });
  return out;
}

const local = new LRUCache<string, { count: number; until: number }>({ max: 10000 });

function lockoutMs(): number {
  return envInt('JELLYFIN_PIN_LOCKOUT', 900, 1) * 1000;
}

async function takeAttempt(key: string): Promise<boolean> {
  const limit = envInt('JELLYFIN_PIN_ATTEMPTS', 5, 1);
  if (redis) {
    const count = await redis.incr(`jellyfin:pin:${key}`).catch(() => null);
    if (count !== null) {
      if (count === 1) await redis.pexpire(`jellyfin:pin:${key}`, lockoutMs()).catch(() => undefined);
      return count <= limit;
    }
  }
  const now = Date.now();
  const held = local.get(key);
  const entry = held && held.until > now ? held : { count: 0, until: now + lockoutMs() };
  entry.count += 1;
  local.set(key, entry);
  return entry.count <= limit;
}

async function resetAttempts(key: string): Promise<void> {
  local.delete(key);
  if (redis) await redis.del(`jellyfin:pin:${key}`).catch(() => undefined);
}

/** Past the attempt limit even the right PIN is refused until the lockout ends. */
export async function pinOpens(userUUID: string, profile: { id: string | null; pin?: string }, pin: string): Promise<boolean> {
  if (!profile.pin) return true;
  if (!pin) return false;
  const key = `${userUUID}:${profile.id ?? ''}`;
  if (!(await takeAttempt(key))) return false;
  if (PIN_PATTERN.test(pin) && (await bcrypt.compare(pin, profile.pin))) {
    await resetAttempts(key);
    return true;
  }
  return false;
}

/**
 * Hashes each user's PIN in place before a save, keeping the stored hash when
 * the same PIN comes back. Returns the users whose PIN was set or changed.
 */
export async function securePins(config: any, previous: any): Promise<string[]> {
  const before = new Map<string, string>();
  for (const user of Array.isArray(previous?.jellyfinUsers) ? previous.jellyfinUsers : []) {
    if (typeof user?.id === 'string' && isPinHash(user.pin)) before.set(user.id, user.pin);
  }
  const changed: string[] = [];
  for (const user of Array.isArray(config?.jellyfinUsers) ? config.jellyfinUsers : []) {
    if (!user || typeof user.id !== 'string') continue;
    const old = before.get(user.id);
    const raw = typeof user.pin === 'string' ? user.pin.trim() : '';
    if (PIN_PATTERN.test(raw)) {
      user.pin = old && (await bcrypt.compare(raw, old)) ? old : await bcrypt.hash(raw, 10);
    } else if (!isPinHash(raw)) {
      delete user.pin;
    }
    if (user.pin && user.pin !== old) changed.push(user.id);
  }
  return changed;
}
