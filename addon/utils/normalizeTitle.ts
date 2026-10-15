/**
 * Normalizes a string for searching:
 * - Converts to lowercase
 * - Removes accents and diacritics
 * - Converts & to 'and'
 * - Removes non-alphanumeric characters (except whitespace)
 * - Removes a leading "the "
 * - Collapses multiple spaces
 */
export function normalizeTitle(str: string): string {
  if (!str) return '';
  return str
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s*&\s*/g, ' and ')
    // Convert dashes, underscores, slashes to spaces
    // eslint-disable-next-line no-useless-escape
    .replace(/[‐-―–—−_\/]+/g, ' ')
    // Remove all other non-alphanumeric characters
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/^the\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}
