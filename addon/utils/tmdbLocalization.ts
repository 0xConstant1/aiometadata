/**
 * Whether a TMDB record's title and overview came back in the user's own language.
 *
 * Kept in its own module with no imports: `parseProps` and `getTmdb` both pull in the
 * Redis-backed cache stack, which makes them unusable from a unit test. `parseProps`
 * re-exports `classifyTmdbLocalization` so callers keep reaching it through `Utils`.
 *
 * Both signals are read from the raw response rather than by instrumenting the
 * translation helpers, because TMDB makes them directly observable (verified live
 * against the API on 2026-09-20):
 *
 *  - `overview` is NOT language-filled. TMDB returns "" when the requested language has
 *    no overview, so an empty top-level overview means `processOverviewTranslations` is
 *    about to fall back to English.
 *  - a translation entry's `title`/`name` is left BLANK when it equals the original
 *    title. Breaking Bad es-ES returns an empty `name` while the Spanish title is
 *    correct, so a blank title is only a fallback when the record's original language is
 *    not the user's. Treating "no match" as "fallback" would demote every
 *    English-language title for English users.
 *  - entries may exist while being entirely empty (LIVE with Kelly and Mark, es-ES), so
 *    every check tests the field, never the entry's presence.
 *
 * The verdict never compares values against English: a legitimate Spanish translation of
 * "Casablanca" is the string "Casablanca".
 */

export type TmdbLocalizationStamp = {
  titleLang: 'exact' | 'fallback';
  overviewLang: 'exact' | 'fallback';
};

/**
 * Mirrors `getTmdb.getTranslations`: an exact iso_639_1 + iso_3166_1 match, which is why
 * an es-MX user never matches an es-ES entry (a known, accepted gap — that user is
 * already served an English fallback today).
 */
function findExactTranslation(translations: any, language: string): any {
  const list = translations?.translations;
  if (!Array.isArray(list)) return null;
  const [iso639, iso3166] = String(language).split('-');
  return list.find((t: any) => t?.iso_639_1 === iso639 && t?.iso_3166_1 === iso3166) || null;
}

export function classifyTmdbLocalization(
  rawData: any,
  language: string,
  type: 'movie' | 'series'
): TmdbLocalizationStamp {
  const titleField = type === 'movie' ? 'title' : 'name';
  const baseLang = String(language || 'en-US').split('-')[0].toLowerCase();
  const originalLang = String(rawData?.original_language || '').toLowerCase();

  const entry = findExactTranslation(rawData?.translations, language || 'en-US');
  const entryTitle = entry?.data?.[titleField];
  const hasLocalizedTitle = typeof entryTitle === 'string' && entryTitle.trim() !== '';

  const overview = rawData?.overview;
  const hasLocalizedOverview = typeof overview === 'string' && overview.trim() !== '';

  return {
    titleLang: hasLocalizedTitle || (!!originalLang && originalLang === baseLang) ? 'exact' : 'fallback',
    overviewLang: hasLocalizedOverview ? 'exact' : 'fallback',
  };
}

module.exports = { classifyTmdbLocalization };
