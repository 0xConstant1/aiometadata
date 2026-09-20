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
 *
 * **Only language is judged here, deliberately.** An earlier revision also demoted on
 * missing artwork (`!meta.logo` / `!meta.background`). That was removed, because a verdict
 * reached here is applied to every row the write enqueues, and those rows are not all
 * scoped the same way:
 *
 *   - `basic`, `cast`, `director`, `writer`, `links`, `trailers`, `extras` are keyed by
 *     `commonHash`, which covers language and metadata provider but NOT the art provider.
 *     Profiles differing only in artwork share these rows — and they hold ~90% of the
 *     store's bytes, `cast` and `links` being the costliest components to rebuild.
 *   - only `poster`, `background`, `logo`, `landscapePoster`, `rawPoster` and `videos`
 *     carry an art-specific hash.
 *
 * So an artwork verdict, which is by definition per-art-profile, would have restamped the
 * shared 90% on behalf of one profile. On a public instance with many art configurations
 * per language, at least one profile missing a logo is near-certain for long-tail titles,
 * which would have pinned the most expensive rows at the short TTL more or less
 * permanently — the exact opposite of what the cold store is for.
 *
 * Scoping the rule to art rows does not rescue it: a missing logo writes no logo row at
 * all, and the read path only attempts to refill art that `basic._hasLogo` says exists.
 * Re-checking artwork therefore requires the *shared* row to lapse. Artwork freshness
 * needs a different mechanism (moving the `_has*` flags off the shared row, or a separate
 * art-scoped TTL) and is left as follow-up work rather than approximated badly here.
 *
 * Language has no such problem: `language` is part of `commonHash`, so every profile
 * sharing a row computes the same verdict.
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
  // Those are never demoted: there is no locale field that could ever be filled, so a
  // short TTL would buy nothing and put every anime title on a refetch treadmill.
  if (stamp?.titleLang === 'fallback') reasons.push('title from language fallback');
  if (stamp?.overviewLang === 'fallback') reasons.push('overview from language fallback');

  return { verdict: reasons.length > 0 ? 'partial' : 'complete', reasons };
}

module.exports = { classifyMetaCompleteness };
