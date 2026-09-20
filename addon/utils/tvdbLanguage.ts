/**
 * TVDB files European Portuguese under `por` and Brazilian under `pt`, and most records
 * carry only one of the two. Falling straight from the missing one to English hands a
 * Portuguese speaker English while a Portuguese translation sits in the same record, so
 * the sibling variant is tried first.
 */
export function tvdbLanguageChain(primary: string | null | undefined): string[] {
  const code = primary || 'eng';
  const chain = [code];
  if (code === 'por') chain.push('pt');
  else if (code === 'pt') chain.push('por');
  if (!chain.includes('eng')) chain.push('eng');
  return chain;
}

/**
 * First non-empty `field` across the language chain, together with the chain entry that
 * produced it. A null language means nothing matched and the caller will fall through to
 * the record's own base field, which is in its original language.
 */
export function pickTranslationWithLang(
  items: any[] | null | undefined,
  chain: string[],
  field: string
): { value: string | undefined; language: string | null } {
  if (!Array.isArray(items)) return { value: undefined, language: null };
  for (const code of chain) {
    const value = items.find(item => item?.language === code)?.[field];
    if (typeof value === 'string' && value.trim() !== '') return { value, language: code };
  }
  return { value: undefined, language: null };
}

/** First non-empty `field` across the language chain. */
export function pickTranslation(
  items: any[] | null | undefined,
  chain: string[],
  field: string
): string | undefined {
  return pickTranslationWithLang(items, chain, field).value;
}

export type LocalizationStamp = {
  titleLang: 'exact' | 'fallback';
  overviewLang: 'exact' | 'fallback';
};

/**
 * Whether a TVDB record's name and overview are in the user's own language.
 *
 * A record can carry zero translations for a field (verified live: TVDB movie 75531 has
 * no overview translations at all), in which case the assembly uses the record's base
 * field. That is the original language, so it is exact only for a user who speaks it.
 *
 * Note the verdict keys off which language matched, never off the value: a legitimate
 * Spanish translation of "Breaking Bad" is the string "Breaking Bad", so comparing
 * against English would wrongly call it a fallback.
 */
export function classifyTvdbLocalization(record: any, chain: string[]): LocalizationStamp {
  const original = String(record?.originalLanguage || '').toLowerCase();
  const verdict = (items: any[] | null | undefined, field: string): 'exact' | 'fallback' => {
    const { language } = pickTranslationWithLang(items, chain, field);
    if (language === null) return original === chain[0] ? 'exact' : 'fallback';
    return language === chain[0] ? 'exact' : 'fallback';
  };
  return {
    titleLang: verdict(record?.translations?.nameTranslations, 'name'),
    overviewLang: verdict(record?.translations?.overviewTranslations, 'overview'),
  };
}

/** First artwork of `type` across the language chain, before any untyped fallback. */
export function pickArtwork(
  artworks: any[] | null | undefined,
  type: number | string,
  chain: string[],
  field: string
): string | undefined {
  if (!Array.isArray(artworks)) return undefined;
  for (const code of chain) {
    const value = artworks.find(art => art?.type === type && art?.language === code)?.[field];
    if (value) return value;
  }
  return undefined;
}

module.exports = { tvdbLanguageChain, pickTranslation, pickTranslationWithLang, pickArtwork, classifyTvdbLocalization };
