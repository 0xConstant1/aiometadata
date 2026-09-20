/**
 * How confident we are that a payload is worth freezing on disk.
 *
 * `classifyMetaStability` answers "will this record still be accurate?" in terms of the
 * title's production status. It says nothing about whether the payload is any good. A row
 * assembled from an English fallback because no Spanish translation existed is exactly
 * the row most likely to change next week, because the missing piece is what a provider
 * contributor is most likely to add.
 *
 * Incompleteness demotes to a short TTL rather than preventing storage: for the obscure
 * tail, absence is permanent rather than pending (95-100% of sampled Greek and Vietnamese
 * titles have no localized overview and never will), so skipping would delete the store's
 * value for exactly the users who benefit most. The one exception is a failed language
 * resolution, where the payload is wrong rather than merely unlocalized.
 */

export type CompletenessStamp = {
  titleLang: 'exact' | 'fallback';
  overviewLang: 'exact' | 'fallback';
  /** TVDB paths only: false when to3LetterCode degraded to 'eng' for a non-English config. */
  langResolved?: boolean;
};

export type CompletenessResult = {
  verdict: 'complete' | 'partial' | 'skip';
  reasons: string[];
};

export function classifyMetaCompleteness(meta: any): CompletenessResult {
  const stamp: CompletenessStamp | undefined = meta?._completeness;

  // Wrong language, not merely unlocalized. A short TTL is the wrong remedy for data
  // that should never be persisted, so this refuses storage outright.
  if (stamp?.langResolved === false) {
    return { verdict: 'skip', reasons: ['language resolution degraded to eng'] };
  }

  const reasons: string[] = [];
  // An absent stamp means a provider with no locale layer (Kitsu/MAL/TVMAZE/IMDb).
  // Those are never demoted on language; only the artwork rules below apply.
  if (stamp?.titleLang === 'fallback') reasons.push('title from language fallback');
  if (stamp?.overviewLang === 'fallback') reasons.push('overview from language fallback');
  if (!meta?.logo) reasons.push('no logo');
  if (!meta?.background) reasons.push('no background');

  return { verdict: reasons.length > 0 ? 'partial' : 'complete', reasons };
}

module.exports = { classifyMetaCompleteness };
