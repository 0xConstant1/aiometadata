import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { deflateRawSync, inflateRawSync } from 'zlib';

// A tag is the image's address, encrypted: addresses can carry users' keys.

const KEY_FILE = path.join(process.cwd(), 'addon', 'data', 'jellyfin-image-tag.key');
const WIDE = 1;

let key: Buffer | null = null;

function tagKey(): Buffer {
  if (key) return key;
  const configured = process.env.JELLYFIN_IMAGE_TAG_KEY?.trim();
  if (configured) {
    key = createHash('sha256').update(configured).digest();
    return key;
  }
  try {
    key = Buffer.from(fs.readFileSync(KEY_FILE, 'utf8').trim(), 'base64');
    if (key.length === 32) return key;
  } catch {
    // Written below on first use.
  }
  key = randomBytes(32);
  try {
    fs.mkdirSync(path.dirname(KEY_FILE), { recursive: true });
    fs.writeFileSync(KEY_FILE, key.toString('base64'), { mode: 0o600 });
  } catch {
    // Kept in memory: tags then change once per restart.
  }
  return key;
}

export interface ImageTag {
  url: string;
  /** Landscape art standing in for a poster. */
  wide: boolean;
}

export function imageTag(url: string, opts: { wide?: boolean } = {}): string {
  const plain = Buffer.concat([Buffer.from([opts.wide ? WIDE : 0]), deflateRawSync(Buffer.from(url, 'utf8'))]);
  const iv = createHmac('sha256', tagKey()).update(plain).digest().subarray(0, 12);
  const cipher = createCipheriv('aes-256-gcm', tagKey(), iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url');
}

export function readImageTag(tag: unknown): ImageTag | null {
  if (typeof tag !== 'string' || tag.length < 40) return null;
  try {
    const raw = Buffer.from(tag, 'base64url');
    const decipher = createDecipheriv('aes-256-gcm', tagKey(), raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]);
    return { url: inflateRawSync(plain.subarray(1)).toString('utf8'), wide: (plain[0] & WIDE) === WIDE };
  } catch {
    return null;
  }
}
