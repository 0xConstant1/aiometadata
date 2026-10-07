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
