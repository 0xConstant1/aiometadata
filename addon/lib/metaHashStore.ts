import consola from 'consola';

const redis: any = require('./redisClient');
const { encodeCachePayload }: any = require('./cacheCodec');

const logger = consola.withTag('Meta-Hash');

/**
 * One component bound for a title's hash. `legacyKey` is the per-component key
 * the component lived under before the hash, which is still how the cold store
 * addresses it. `encoded` carries bytes that are already encoded, so a payload
 * read back from the cold store is written as-is.
 */
export type MetaHashEntry = {
  name: string;
  field: string;
  legacyKey: string;
  componentData?: any;
  encoded?: Buffer;
};

async function encodeEntries(entries: MetaHashEntry[]): Promise<Array<Buffer | string>> {
  return Promise.all(entries.map((entry) => entry.encoded ?? encodeCachePayload(entry.componentData)));
}

// The key's own TTL only keeps it evictable under volatile-* policies (a hash
// with field TTLs alone reports -1); freshness lives on the fields. NX gives a
// new key its TTL and GT only ever extends it, so it covers the longest field.
function queueKeyExpiry(tx: any, key: string, ttl: number): void {
  tx.expire(key, ttl, 'NX');
  tx.expire(key, ttl, 'GT');
}

async function execOrWarn(tx: any, key: string): Promise<any[] | null> {
  try {
    const results = await tx.exec();
    const failed = results?.find(([error]: any) => error);
    if (failed) {
      logger.warn(`Meta hash write failed for ${key}: ${failed[0]?.message}`);
      return null;
    }
    return results;
  } catch (error: any) {
    logger.warn(`Meta hash write failed for ${key}: ${error?.message}`);
    return null;
  }
}

/** Reads the given fields and `basic`'s remaining TTL in one round trip. */
export async function readMetaHash(key: string, fields: string[]): Promise<{ values: Array<Buffer | null>; basicTtl: number }> {
  if (!redis || fields.length === 0) return { values: fields.map(() => null), basicTtl: -2 };
  const results = await redis.pipeline()
    .hmgetBuffer(key, ...fields)
    .httl(key, 'FIELDS', 1, 'basic')
    .exec();
  const [readError, values] = results[0];
  if (readError) throw readError;
  const [ttlError, ttls] = results[1];
  return { values, basicTtl: ttlError ? -2 : Number(ttls?.[0] ?? -2) };
}

/**
 * A full write: every field gets one TTL so they expire together, and
 * `hdelFields` (this profile's components the fresh meta no longer has) go in
 * the same transaction. Other profiles' fields are never named, so never touched.
 */
export async function writeMetaHashReplace({ key, entries, ttl, hdelFields = [] }: { key: string; entries: MetaHashEntry[]; ttl: number; hdelFields?: string[] }): Promise<boolean> {
  const seconds = Math.floor(ttl);
  if (!redis || entries.length === 0 || !(seconds >= 1)) return false;

  let values: Array<Buffer | string>;
  try {
    values = await encodeEntries(entries);
  } catch (error: any) {
    logger.warn(`Failed to encode meta hash ${key}: ${error?.message}`);
    return false;
  }

  const fieldValues: Array<Buffer | string> = [];
  entries.forEach((entry, index) => fieldValues.push(entry.field, values[index]));

  const tx = redis.multi();
  if (hdelFields.length > 0) tx.hdel(key, ...hdelFields);
  tx.hsetex(key, 'EX', seconds, 'FIELDS', entries.length, ...fieldValues);
  queueKeyExpiry(tx, key, seconds);
  return (await execOrWarn(tx, key)) !== null;
}

/**
 * Writes only the fields that are missing. Without `basic` in the payload the
 * TTL is capped at `basic`'s remaining TTL, so nothing filled outlives the
 * `basic` it was derived from; with `basic` absent too, nothing is written.
 * One field per HSETEX because FNX is all-or-nothing across a command's fields.
 */
export async function writeMetaHashFill({ key, entries, ttl, basicTtl }: { key: string; entries: MetaHashEntry[]; ttl: number; basicTtl: number }): Promise<number> {
  if (!redis || entries.length === 0) return 0;
  const carriesBasic = entries.some((entry) => entry.field === 'basic');
  const cap = Math.floor(carriesBasic ? ttl : Math.min(ttl, basicTtl));
  if (!(cap >= 1)) return 0;

  let values: Array<Buffer | string>;
  try {
    values = await encodeEntries(entries);
  } catch (error: any) {
    logger.warn(`Failed to encode meta hash ${key}: ${error?.message}`);
    return 0;
  }

  const tx = redis.multi();
  entries.forEach((entry, index) => tx.hsetex(key, 'FNX', 'EX', cap, 'FIELDS', 1, entry.field, values[index]));
  queueKeyExpiry(tx, key, cap);
  const results = await execOrWarn(tx, key);
  if (!results) return 0;
  return results.slice(0, entries.length).filter(([, written]: any) => written === 1).length;
}
