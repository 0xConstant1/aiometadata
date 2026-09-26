import type { UserConfig } from '../types';

export type WatchTrackingService =
  | 'simkl'
  | 'anilist'
  | 'mal'
  | 'mdblist'
  | 'publicmetadb';

export type WatchTrackingMediaType = 'movie' | 'series';

type WatchTrackingMasterKey =
  | 'simklWatchTracking'
  | 'anilistWatchTracking'
  | 'malWatchTracking'
  | 'mdblistWatchTracking'
  | 'publicmetadbWatchTracking';

interface WatchTrackingServiceDefinition {
  masterKey: WatchTrackingMasterKey;
  hasCredential: (config: UserConfig) => boolean;
}

export const WATCH_TRACKING_SERVICES: WatchTrackingService[] = [
  'simkl',
  'anilist',
  'mal',
  'mdblist',
  'publicmetadb',
];

const SERVICE_DEFINITIONS: Record<
  WatchTrackingService,
  WatchTrackingServiceDefinition
> = {
  simkl: {
    masterKey: 'simklWatchTracking',
    hasCredential: (config) => !!config.apiKeys?.simklTokenId,
  },
  anilist: {
    masterKey: 'anilistWatchTracking',
    hasCredential: (config) => !!config.apiKeys?.anilistTokenId,
  },
  mal: {
    masterKey: 'malWatchTracking',
    hasCredential: (config) => !!config.apiKeys?.malTokenId,
  },
  mdblist: {
    masterKey: 'mdblistWatchTracking',
    hasCredential: (config) => !!config.apiKeys?.mdblist,
  },
  publicmetadb: {
    masterKey: 'publicmetadbWatchTracking',
    hasCredential: (config) => !!config.apiKeys?.publicmetadb,
  },
};

export function isWatchTrackingMediaTypeSelected(
  config: UserConfig,
  service: WatchTrackingService,
  mediaType: WatchTrackingMediaType,
): boolean {
  return config.watchTracking?.[service]?.[mediaType] !== false;
}

export function isWatchTrackingServiceEnabled(
  config: UserConfig,
  service: WatchTrackingService,
): boolean {
  const definition = SERVICE_DEFINITIONS[service];
  return (
    definition.hasCredential(config) &&
    config[definition.masterKey] === true
  );
}

export function shouldTrackServiceMediaType(
  config: UserConfig,
  service: WatchTrackingService,
  mediaType: WatchTrackingMediaType,
): boolean {
  return (
    isWatchTrackingServiceEnabled(config, service) &&
    isWatchTrackingMediaTypeSelected(config, service, mediaType)
  );
}

export function hasAnyWatchTrackingEnabled(config: UserConfig): boolean {
  return WATCH_TRACKING_SERVICES.some(
    (service) =>
      shouldTrackServiceMediaType(config, service, 'movie') ||
      shouldTrackServiceMediaType(config, service, 'series'),
  );
}

export function normalizeWatchTrackingMediaType(
  routeType: unknown,
  parsedType: WatchTrackingMediaType,
): WatchTrackingMediaType | null {
  const normalizedRouteType =
    typeof routeType === 'string' ? routeType.trim().toLowerCase() : '';

  if (
    normalizedRouteType === 'movie' ||
    normalizedRouteType === 'series'
  ) {
    return normalizedRouteType === parsedType ? normalizedRouteType : null;
  }

  return parsedType;
}

