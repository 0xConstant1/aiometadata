const { parse } = require('csv-parse/sync');

export interface IdMap {
  imdbId: string;
  tmdbId: string;
  tvdbId: string;
  tvmazeId?: string;
}

export type IdField = 'imdbId' | 'tmdbId' | 'tvdbId' | 'tvmazeId';

const HEADER_ALIASES: Record<string, IdField> = {
  imdb_id: 'imdbId', imdbId: 'imdbId',
  tmdb_id: 'tmdbId', tmdbId: 'tmdbId',
  tvdb_id: 'tvdbId', tvdbId: 'tvdbId',
  tvmaze_id: 'tvmazeId', tvmazeId: 'tvmazeId',
};

const VALID_ID: Record<IdField, RegExp> = {
  imdbId: /^tt\d+$/,
  tmdbId: /^\d+$/,
  tvdbId: /^\d+$/,
  tvmazeId: /^\d+(\/.*)?$/,
};

export function parseMappingCsv(csv: string): { rows: IdMap[]; invalid: number } {
  let hasTvmaze = false;
  const records: Record<string, string>[] = parse(csv, {
    bom: true,
    trim: true,
    skip_empty_lines: true,
    columns: (header: string[]) => header.map((name) => {
      const field = HEADER_ALIASES[name.trim()];
      if (field === 'tvmazeId') hasTvmaze = true;
      return field || false;
    }),
  });

  const rows: IdMap[] = [];
  let invalid = 0;
  for (const record of records) {
    const row: IdMap = { imdbId: record.imdbId || '', tmdbId: record.tmdbId || '', tvdbId: record.tvdbId || '' };
    if (hasTvmaze) row.tvmazeId = record.tvmazeId || '';
    const fields = Object.keys(row) as IdField[];
    if (!fields.some((field) => row[field]) || fields.some((field) => row[field] && !VALID_ID[field].test(row[field]))) {
      invalid++;
      continue;
    }
    if (row.tvmazeId) row.tvmazeId = String(parseInt(row.tvmazeId, 10));
    rows.push(row);
  }
  return { rows, invalid };
}

export interface IndexStats {
  primaryRows: number;
  backfilledRows: number;
  totalRows: number;
  filled: Record<IdField, number>;
  conflicts: number;
}

export interface MappingIndex {
  imdb: Map<string, IdMap>;
  tmdb: Map<number, IdMap>;
  tvdb: Map<number, IdMap>;
  tvmaze: Map<number, IdMap> | null;
  stats: IndexStats;
}

export function buildIndex(primary: IdMap[], backfill: IdMap[], withTvmaze: boolean): MappingIndex {
  const index: MappingIndex = {
    imdb: new Map(),
    tmdb: new Map(),
    tvdb: new Map(),
    tvmaze: withTvmaze ? new Map() : null,
    stats: { primaryRows: 0, backfilledRows: 0, totalRows: 0, filled: { imdbId: 0, tmdbId: 0, tvdbId: 0, tvmazeId: 0 }, conflicts: 0 },
  };
  const fields: IdField[] = withTvmaze ? ['imdbId', 'tmdbId', 'tvdbId', 'tvmazeId'] : ['imdbId', 'tmdbId', 'tvdbId'];
  const maps: Record<string, Map<any, IdMap>> = { imdbId: index.imdb, tmdbId: index.tmdb, tvdbId: index.tvdb, tvmazeId: index.tvmaze };
  const key = (field: IdField, value: string) => (field === 'imdbId' ? value : Number(value));
  const find = (field: IdField, value: string) => maps[field].get(key(field, value));
  const claim = (field: IdField, value: string, row: IdMap) => maps[field].set(key(field, value), row);
  const copy = (src: IdMap): IdMap => {
    const row: IdMap = { imdbId: src.imdbId || '', tmdbId: src.tmdbId || '', tvdbId: src.tvdbId || '' };
    if (withTvmaze) row.tvmazeId = src.tvmazeId || '';
    return row;
  };

  for (const src of primary) {
    const row = copy(src);
    let indexed = false;
    for (const field of fields) {
      if (row[field] && !find(field, row[field])) {
        claim(field, row[field], row);
        indexed = true;
      }
    }
    if (indexed) index.stats.primaryRows++;
  }

  for (const src of backfill) {
    const matches = new Set<IdMap>();
    for (const field of fields) {
      const hit = src[field] ? find(field, src[field]) : undefined;
      if (hit) matches.add(hit);
    }

    if (matches.size === 0) {
      const row = copy(src);
      if (!fields.some((field) => row[field])) continue;
      for (const field of fields) if (row[field]) claim(field, row[field], row);
      index.stats.backfilledRows++;
      continue;
    }

    const [target] = matches;
    const disagrees = fields.some((field) => src[field] && target[field] && key(field, src[field]) !== key(field, target[field]));
    if (matches.size > 1 || disagrees) {
      index.stats.conflicts++;
      continue;
    }

    // Any id owned by another row would have been a second match, so empty fields are safe to fill.
    for (const field of fields) {
      if (src[field] && !target[field]) {
        target[field] = src[field];
        claim(field, src[field], target);
        index.stats.filled[field]++;
      }
    }
  }

  index.stats.totalRows = index.stats.primaryRows + index.stats.backfilledRows;
  return index;
}
