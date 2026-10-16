export function sizedArt(url: string | null | undefined, width: number): string | null {
  if (!url) return null;
  return url.replace(/\/poster-cache\/(?!proxy\/|w\d+\/)/, `/poster-cache/w${width}/`);
}
