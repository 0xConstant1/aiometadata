import { httpGet } from './httpClient.js';

export interface LumiereResult {
  imdbId: string;
  title: string;
  year: number | null;
}

// LumiereDB caps queries at 120 runes and limit at 50, and answers anything past either with a 400.
const MAX_QUERY_RUNES = 120;
const MAX_LIMIT = 50;

export async function fetchLumiereSearch(
  baseUrl: string,
  type: string,
  query: string,
  limit: number,
  timeoutMs: number
): Promise<LumiereResult[]> {
  const normalized = Array.from(query.replace(/\s+/g, ' ').trim()).slice(0, MAX_QUERY_RUNES).join('');
  if (!normalized) return [];

  const params = new URLSearchParams({
    query: normalized,
    type: type === 'movie' ? 'movies' : 'series',
    limit: String(Math.min(Math.max(limit, 1), MAX_LIMIT)),
  });
  const url = `${baseUrl.replace(/\/+$/, '')}/search?${params}`;

  const response: any = await httpGet(url, { timeout: timeoutMs });
  const items = response?.data?.items;
  if (!Array.isArray(items)) {
    throw new Error(`LumiereDB returned no result list (status ${response?.status})`);
  }

  return items
    .filter((item: any) => typeof item?.tconst === 'string' && item.tconst.startsWith('tt'))
    .map((item: any) => ({
      imdbId: item.tconst,
      title: item.primaryTitle || '',
      year: typeof item.startYear === 'number' ? item.startYear : null,
    }));
}
