export type Target = 'nuvio' | 'fusion';

export const NUVIO_CHIP = 'bg-cyan-800/70 text-cyan-200 border-cyan-600/50';
export const FUSION_CHIP = 'bg-violet-800/70 text-violet-200 border-violet-600/50';
export const JELLYFIN_CHIP = 'bg-amber-800/70 text-amber-200 border-amber-600/50';

export interface TargetTerms {
  entryTitle: string;
  collection: string;
  row: string;
  child: string;
  children: string;
  childTitle: string;
  addChild: string;
  shape: string;
  cover: string;
  sources: string;
}

/**
 * One vocabulary for both targets. An object that renamed itself when the
 * target changed could not be documented or remembered, so the other app's
 * word is a hint from ALIASES instead of a substitution.
 */
const CANONICAL: TargetTerms = {
  entryTitle: 'Title',
  collection: 'Collection',
  row: 'Row',
  child: 'Folder',
  children: 'Folders',
  childTitle: 'Folder title',
  addChild: 'Add folder',
  shape: 'Tile shape',
  cover: 'Cover image URL',
  sources: 'Sources',
};

export const TERMS: Record<Target, TargetTerms> = {
  nuvio: CANONICAL,
  fusion: CANONICAL,
};

/** The canonical words are Nuvio's, so the hint always names Fusion's. */
export const ALIASES: Partial<Record<keyof TargetTerms, string>> = {
  entryTitle: 'Fusion calls this the Widget title',
  child: 'Fusion calls this an Item',
  children: 'Fusion calls these Items',
  shape: 'Fusion calls this Layout',
  sources: 'Fusion calls these Catalogs',
};

export function aliasHint(key: keyof TargetTerms): string | null {
  return ALIASES[key] ?? null;
}
