import { createHash } from 'crypto';
import { envInt } from '../utils/envNumber';
import { httpGet } from '../utils/httpClient';

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;

export interface TrailerStream {
  title: string;
  ytId?: string;
  url?: string;
}

export function trailerStreamUrl(manifestUrl: unknown, type: string, id: string, resource: 'stream' | 'meta' = 'stream'): string | null {
  const trimmed = typeof manifestUrl === 'string' ? manifestUrl.trim() : '';
  if (!trimmed.endsWith('/manifest.json')) return null;
  return `${trimmed.slice(0, -'manifest.json'.length)}${resource}/${type}/${encodeURIComponent(id)}.json`;
}

function imdbIdOf(meta: any): string | null {
  const direct = meta?.imdb_id || meta?._imdbId;
  if (typeof direct === 'string' && direct.startsWith('tt')) return direct;
  const fromId = typeof meta?.id === 'string' ? meta.id.match(/^tt\d+/)?.[0] : null;
  return fromId || null;
}

function toStream(raw: any): TrailerStream | null {
  const title = typeof raw?.title === 'string' && raw.title.trim() ? raw.title.trim() : typeof raw?.name === 'string' && raw.name.trim() ? raw.name.trim() : 'Trailer';
  if (typeof raw?.ytId === 'string' && YOUTUBE_ID.test(raw.ytId)) return { title, ytId: raw.ytId };
  if (typeof raw?.url === 'string' && /^https?:\/\//i.test(raw.url)) return { title, url: raw.url };
  return null;
}

// A signed link is not kept past its own expiry.
function ttlFor(streams: TrailerStream[]): number {
  const base = envInt('TRAILER_ADDON_TTL', 24 * 60 * 60, 60);
  let ttl = base;
  for (const stream of streams) {
    const expire = stream.url ? /[?&]expire=(\d{9,10})(?:&|$)/.exec(stream.url) : null;
    if (expire) ttl = Math.min(ttl, Math.max(60, Number(expire[1]) - Math.floor(Date.now() / 1000) - 300));
  }
  return ttl;
}

const pending = new Map<string, Promise<TrailerStream[]>>();
function inflight(key: string, work: () => Promise<TrailerStream[]>): Promise<TrailerStream[]> {
  const running = pending.get(key);
  if (running) return running;
  const started = work().finally(() => pending.delete(key));
  pending.set(key, started);
  return started;
}

async function addonResource(manifestUrl: string): Promise<'stream' | 'meta'> {
  const { cacheWrapGlobal } = require('./getCache');
  const addonHash = createHash('sha256').update(manifestUrl).digest('hex').slice(0, 12);
  const shape = await cacheWrapGlobal(
    `trailer_addon:manifest:v1:${addonHash}`,
    async () => {
      const response = await httpGet(manifestUrl, { timeout: envInt('TRAILER_ADDON_TIMEOUT_MS', 6000, 500) });
      const resources = Array.isArray(response?.data?.resources) ? response.data.resources : [];
      const names = resources.map((r: any) => (typeof r === 'string' ? r : r?.name));
      return { resource: names.includes('stream') ? 'stream' : 'meta' };
    },
    envInt('TRAILER_ADDON_TTL', 24 * 60 * 60, 60),
    { upstream: true }
  );
  return shape?.resource === 'stream' ? 'stream' : 'meta';
}

function streamsFromMeta(meta: any): TrailerStream[] {
  const out: TrailerStream[] = [];
  for (const raw of Array.isArray(meta?.trailerStreams) ? meta.trailerStreams : []) {
    const stream = toStream(raw);
    if (stream) out.push(stream);
  }
  for (const link of Array.isArray(meta?.links) ? meta.links : []) {
    const stream = toStream({ url: link?.trailers, title: link?.provider ?? link?.name });
    if (stream) out.push(stream);
  }
  if (!out.length) {
    for (const raw of Array.isArray(meta?.trailers) ? meta.trailers : []) {
      const stream = toStream({ ytId: raw?.source ?? raw?.ytId, title: raw?.name });
      if (stream) out.push(stream);
    }
  }
  return out;
}

async function fetchAddonTrailers(manifestUrl: string, type: string, id: string): Promise<TrailerStream[]> {
  const resource = await addonResource(manifestUrl);
  const url = trailerStreamUrl(manifestUrl, type, id, resource);
  if (!url) return [];
  let response: any;
  try {
    response = await httpGet(url, { timeout: envInt('TRAILER_ADDON_TIMEOUT_MS', 6000, 500) });
  } catch (error: any) {
    if (error?.response?.status === 404) return [];
    throw error;
  }
  if (resource === 'meta') return streamsFromMeta(response?.data?.meta);
  const streams = Array.isArray(response?.data?.streams) ? response.data.streams : [];
  return streams.map(toStream).filter((s: TrailerStream | null): s is TrailerStream => s !== null);
}

// Applied on the way out, like the IMDb rating: the cached components keep the provider's own.
export async function applyTrailerAddonProjection(meta: any, config: any): Promise<any> {
  if (!meta || config?.trailerProvider !== 'addon') return meta;
  const manifestUrl = typeof config?.trailerAddonUrl === 'string' ? config.trailerAddonUrl.trim() : '';
  if (!manifestUrl) return meta;

  const type = meta.type === 'movie' || meta.type === 'anime.movie' ? 'movie' : 'series';
  const id = imdbIdOf(meta);
  if (!id) return meta;

  const { readGlobalCache, writeGlobalCache } = require('./getCache');
  const addonHash = createHash('sha256').update(manifestUrl).digest('hex').slice(0, 12);
  const key = `trailer_addon:v1:${addonHash}:${type}:${id}`;
  let streams: TrailerStream[] | null = await readGlobalCache(key);
  if (!Array.isArray(streams)) {
    try {
      streams = await inflight(key, () => fetchAddonTrailers(manifestUrl, type, id));
    } catch {
      return meta;
    }
    await writeGlobalCache(key, streams, streams.length ? ttlFor(streams) : envInt('TRAILER_ADDON_EMPTY_TTL', 60 * 60, 60));
  }
  if (!Array.isArray(streams) || !streams.length) return meta;

  meta.trailerStreams = streams;
  const youtube = streams.filter((s) => s.ytId);
  if (youtube.length) meta.trailers = youtube.map((s) => ({ source: s.ytId, type: 'Trailer', name: s.title }));
  return meta;
}
