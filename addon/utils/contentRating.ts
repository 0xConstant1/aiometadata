import { isUnratedCertification } from './ageRating';

const getCountryISO3: (iso2: string) => string | undefined = require('country-iso-2-to-3');

function newestCertification(releaseDates: any[], matches: (releaseDate: any) => boolean): string | null {
  const candidates = releaseDates
    .filter(matches)
    .sort((a, b) => new Date(b.release_date).getTime() - new Date(a.release_date).getTime());
  return candidates.length > 0 ? candidates[0].certification : null;
}

/**
 * A restoration or reissue is not resubmitted to the ratings board, so it comes back
 * unrated with a release date decades newer than the original. Taking the newest
 * release outright would let that erase the rating the film actually carries, so a
 * real rating is preferred at every step and an unrated one is only the last word.
 */
export function getTmdbMovieCertificationForCountry(certificationsData: any, country = 'US'): string | null {
  if (!certificationsData) {
    return null;
  }

  const countryData = certificationsData.results?.find((r: any) => r.iso_3166_1 === country);
  if (!countryData?.release_dates) return null;

  const theatrical = newestCertification(
    countryData.release_dates,
    rd => rd.type === 3 && !isUnratedCertification(rd.certification)
  );
  if (theatrical) return theatrical;

  const anyRelease = newestCertification(
    countryData.release_dates,
    rd => !isUnratedCertification(rd.certification)
  );
  if (anyRelease) return anyRelease;

  // Nothing here is rated. Answer with the unrated value rather than null, because a
  // caller reading a second country falls back to the first only when this is null.
  return newestCertification(
    countryData.release_dates,
    rd => typeof rd.certification === 'string' && rd.certification.trim() !== ''
  );
}

export function getTmdbTvCertificationForCountry(certificationsData: any, country = 'US'): string | null {
  if (!certificationsData) {
    return null;
  }

  const countryData = certificationsData.results?.find((r: any) => r.iso_3166_1 === country);
  if (!countryData?.rating) return null;

  return countryData.rating;
}

export function getTvdbCertification(contentRatings: any, countryCode: string | null | undefined, contentType?: string, fallbackToUsa = true): string | null {
  if (!contentRatings || !Array.isArray(contentRatings)) {
    return null;
  }

  let code = countryCode?.toLowerCase();
  if (code && code.length === 2) {
    try { code = getCountryISO3(code.toUpperCase())?.toLowerCase(); } catch {}
  }

  let certification = code ? contentRatings.find(rating =>
    rating.country?.toLowerCase() === code &&
    (!contentType || rating.contentType === contentType || rating.contentType === '')
  ) : null;

  if (!certification && fallbackToUsa) {
    certification = contentRatings.find(rating =>
      rating.country?.toLowerCase() === 'usa' &&
      (!contentType || rating.contentType === contentType || rating.contentType === '')
    );
  }

  return certification?.name || null;
}
