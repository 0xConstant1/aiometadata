export interface FeaturedCollection {
  id: string;
  name: string;
  author: string;
  authorUrl: string;
  /**
   * Fetched as-is. A remote URL keeps the author's own updates flowing without a
   * release here; a local one under public/featured pins a copy when the author
   * has no stable raw link to point at.
   */
  url: string;
  summary: string;
  note?: string;
  /** Shown before loading, because a big design can exceed the catalog limit. */
  catalogs: number;
  detail: string;
  /** Nuvio has no classic row and skips them, so the count is worth stating. */
  classicRows?: number;
}

export const FEATURED_COLLECTIONS: FeaturedCollection[] = [
  {
    id: 'ninja-streams',
    name: 'Ninja Streams',
    author: 'RandomNinjaAtk',
    authorUrl: 'https://github.com/RandomNinjaAtk/Ninja-Streams',
    url: 'https://raw.githubusercontent.com/RandomNinjaAtk/Ninja-Streams/main/AIOMetadata/Fusion-Widgets.json',
    summary: 'New and trending, streaming services, genres, decades, runtime, studios and networks, plus airing this week, recent releases and library rows.',
    catalogs: 114,
    detail: '12 designs, 7 collections and 5 classic rows.',
    classicRows: 5,
  },
  {
    id: 'ume-nobnobz',
    name: 'Unified Media Experience',
    author: 'nobnobz',
    authorUrl: 'https://nobnobz.github.io/fusion-widget-manager/',
    url: '/featured/ume-nobnobz.json',
    summary: 'Discover, streaming services, genres, decades, directors, actors, studios, awards, collections and lists.',
    catalogs: 371,
    detail: '24 designs, 10 collections and 14 classic rows, 271 folders with artwork.',
    classicRows: 14,
  },
  {
    id: 'callandt95',
    name: 'Callandt95',
    author: 'Callandt',
    authorUrl: 'https://github.com/itsrenoria/fusion-starter-kit',
    url: '/featured/callandt95.json',
    summary: 'Trending and watchlist rows, the latest on seven streaming services, seventeen movie genres and thirty film franchises.',
    note: 'Rebuilt on our own sources: the Trakt rows are the same curator\'s MDBList lists, the genre tiles are TMDB Discover catalogs, and the franchises are TMDB collections.',
    catalogs: 63,
    detail: '2 collections and 13 classic rows, 47 tiles with artwork.',
    classicRows: 13,
  },
  {
    id: 'snoak',
    name: 'Snoak',
    author: 'snoak',
    authorUrl: 'https://github.com/itsrenoria/fusion-starter-kit',
    url: '/featured/snoak.json',
    summary: 'Today\'s most popular, discover, the top ten on six streaming services, then those services and nine genres each with their latest and popular, and six decades.',
    note: 'Every row is the curator\'s own MDBList list, the same ones behind the Trakt design.',
    catalogs: 85,
    detail: '4 collections and 14 classic rows, 26 tiles with artwork.',
    classicRows: 14,
  },
  {
    id: 'tvgenie',
    name: 'TVGenie',
    author: 'tvgeniekodi',
    authorUrl: 'https://mdblist.com/lists/tvgeniekodi',
    url: '/featured/tvgenie.json',
    summary: 'Daily picks, latest and trending, the top of each decade from the 1980s and a few genres for movies and shows, and seven streaming networks.',
    note: 'Every tile is the curator\'s own MDBList list.',
    catalogs: 30,
    detail: '3 collections, 23 tiles with artwork.',
  },
];
