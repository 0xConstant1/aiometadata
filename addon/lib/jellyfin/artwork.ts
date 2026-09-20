import { LRUCache } from 'lru-cache';
import { envInt } from '../../utils/envNumber';

export interface Artwork {
  body: Buffer;
  contentType: string;
}

const held = new LRUCache<string, Artwork>({
  maxSize: envInt('JELLYFIN_IMAGE_CACHE_MB', 64, 1) * 1024 * 1024,
  sizeCalculation: (value) => value.body.length,
  ttl: envInt('JELLYFIN_IMAGE_CACHE_TTL', 6 * 60 * 60, 60) * 1000,
});

const loading = new Map<string, Promise<Artwork>>();

/**
 * The bytes for one image at one size, fetched once. A shelf shows the same
 * poster on many items and many clients open it at once, so the load is shared
 * rather than run per request.
 */
export async function cachedArtwork(key: string, load: () => Promise<Artwork>): Promise<Artwork> {
  const known = held.get(key);
  if (known) return known;

  const running = loading.get(key);
  if (running) return running;

  const work = (async () => {
    try {
      const image = await load();
      held.set(key, image);
      return image;
    } finally {
      loading.delete(key);
    }
  })();

  loading.set(key, work);
  return work;
}

export function _resetArtworkCache(): void {
  held.clear();
  loading.clear();
}
