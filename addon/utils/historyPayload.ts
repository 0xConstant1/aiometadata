export interface EpisodeRef {
  season: number;
  episode: number;
  ids?: Record<string, number>;
}

export function historyPayload(
  ids: Record<string, string | number>,
  season?: number,
  episode?: number,
  episodes?: EpisodeRef[]
): any {
  const refs: EpisodeRef[] = episodes?.length
    ? episodes
    : season != null && episode != null
      ? [{ season, episode }]
      : [];
  if (!refs.length) return { movies: [{ ids }] };

  const byId = refs.filter((ref) => ref.ids).map((ref) => ({ ids: ref.ids }));
  const seasons = new Map<number, number[]>();
  for (const ref of refs) {
    if (ref.ids) continue;
    const list = seasons.get(ref.season) ?? [];
    if (!list.includes(ref.episode)) list.push(ref.episode);
    seasons.set(ref.season, list);
  }
  return {
    ...(seasons.size ? {
      shows: [{
        ids,
        seasons: [...seasons.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([number, list]) => ({ number, episodes: list.sort((a, b) => a - b).map((n) => ({ number: n })) })),
      }],
    } : {}),
    ...(byId.length ? { episodes: byId } : {}),
  };
}
