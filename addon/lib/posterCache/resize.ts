import { getSetting } from '../settingsService';

/** Widths an image is made at, so each one has a handful of sizes however clients ask. */
const WIDTH_STEPS = [185, 342, 500, 780, 1280];
const DEFAULT_CONCURRENCY = 2;

/** Set on an internal request to the poster cache to ask for a copy at that width step. */
export const SIZED_WIDTH = Symbol.for('aiometadata.posterCache.sizedWidth');

export interface ResizedImage {
  body: Buffer;
  contentType: string;
}

/** The cache key of an image's copy at one width step. */
export function sizedKey(key: string, width: number): string {
  return `${key}#w${width}`;
}

/** Every copy an image can have, so clearing the original clears them too. */
export function sizedKeys(key: string): string[] {
  return WIDTH_STEPS.map((width) => sizedKey(key, width));
}

/** The smallest step at least as wide as asked, or null when the client wants it larger. */
export function widthStep(requested: number): number | null {
  if (!(requested > 0)) return null;
  return WIDTH_STEPS.find((width) => width >= requested) ?? null;
}

let running = 0;
const waiting: Array<() => void> = [];

function concurrency(): number {
  const value = Number(getSetting('JELLYFIN_IMAGE_RESIZE_CONCURRENCY'));
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : DEFAULT_CONCURRENCY;
}

async function inSlot<T>(work: () => Promise<T>): Promise<T> {
  while (running >= concurrency()) await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  try {
    return await work();
  } finally {
    running--;
    waiting.shift()?.();
  }
}

/**
 * The image at most `width` wide. Art with transparency stays transparent as WebP;
 * the rest becomes JPEG. An image already that narrow, or one the smaller copy
 * would not beat, comes back as it was.
 */
export function resizeToWidth(body: Buffer, contentType: string, width: number): Promise<ResizedImage> {
  return inSlot(async () => {
    try {
      const sharp = require('sharp');
      const source = sharp(body, { failOn: 'none' });
      const meta = await source.metadata();
      if (!meta.width || meta.width <= width) return { body, contentType };
      const resized = source.resize({ width });
      const out: ResizedImage = meta.hasAlpha
        ? { body: await resized.webp({ quality: 85 }).toBuffer(), contentType: 'image/webp' }
        : { body: await resized.jpeg({ quality: 85, mozjpeg: true }).toBuffer(), contentType: 'image/jpeg' };
      return out.body.length < body.length ? out : { body, contentType };
    } catch {
      return { body, contentType };
    }
  });
}
