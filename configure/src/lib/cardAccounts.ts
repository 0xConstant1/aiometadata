import type { CardService, CatalogConfig, JellyfinUser, JellyfinUserAccounts } from '@/contexts/config';

type Shelf = 'movies' | 'series' | 'anime';
type KeyField = keyof NonNullable<JellyfinUserAccounts['apiKeys']>;
type MasterField = 'simklWatchTracking' | 'mdblistWatchTracking' | 'publicmetadbWatchTracking' | 'anilistWatchTracking' | 'malWatchTracking';

interface CardServiceInfo {
  label: string;
  key: KeyField;
  master: MasterField;
  shelves: Shelf[];
  resume: boolean;
  disconnectPath?: string;
}

export const CARD_SERVICE_ORDER: CardService[] = ['simkl', 'mdblist', 'publicmetadb', 'anilist', 'mal'];

export const CARD_SERVICES: Record<CardService, CardServiceInfo> = {
  simkl: { label: 'Simkl', key: 'simklTokenId', master: 'simklWatchTracking', shelves: ['movies', 'series', 'anime'], resume: true, disconnectPath: '/api/auth/simkl/disconnect' },
  mdblist: { label: 'MDBList', key: 'mdblist', master: 'mdblistWatchTracking', shelves: ['movies', 'series'], resume: true },
  publicmetadb: { label: 'PublicMetaDB', key: 'publicmetadb', master: 'publicmetadbWatchTracking', shelves: ['movies', 'series'], resume: true },
  anilist: { label: 'AniList', key: 'anilistTokenId', master: 'anilistWatchTracking', shelves: ['anime'], resume: false, disconnectPath: '/anilist/disconnect' },
  mal: { label: 'MyAnimeList', key: 'malTokenId', master: 'malWatchTracking', shelves: ['anime'], resume: false, disconnectPath: '/mal/disconnect' },
};

export function connectedServices(user?: JellyfinUser): CardService[] {
  if (!user || user.trackers === true) return [];
  return CARD_SERVICE_ORDER.filter((service) => Boolean(user.accounts?.apiKeys?.[CARD_SERVICES[service].key]));
}

export function isHolder(user?: JellyfinUser): boolean {
  return connectedServices(user).length > 0;
}

export function cardAccount(user: JellyfinUser | undefined, service: CardService) {
  const info = CARD_SERVICES[service];
  const accounts = user?.trackers === true ? undefined : user?.accounts;
  const media = accounts?.watchTracking?.[service];
  return {
    connected: Boolean(accounts?.apiKeys?.[info.key]),
    label: accounts?.labels?.[service],
    enabled: accounts?.[info.master] === true,
    movie: media?.movie !== false,
    series: media?.series !== false,
  };
}

function copyAccounts(user: JellyfinUser): JellyfinUserAccounts & Required<Pick<JellyfinUserAccounts, 'apiKeys' | 'watchTracking' | 'labels'>> {
  return {
    ...(user.accounts ?? {}),
    apiKeys: { ...(user.accounts?.apiKeys ?? {}) },
    watchTracking: { ...(user.accounts?.watchTracking ?? {}) },
    labels: { ...(user.accounts?.labels ?? {}) },
  };
}

export function withAccount(user: JellyfinUser, service: CardService, value: string | undefined, extra: { label?: string; publicmetadbWatchlist?: string } = {}): JellyfinUser {
  const info = CARD_SERVICES[service];
  const accounts = copyAccounts(user);
  if (value) {
    accounts.apiKeys[info.key] = value;
    accounts[info.master] = true;
    if (extra.label) accounts.labels[service] = extra.label;
    if (service === 'publicmetadb') accounts.publicmetadbWatchlist = extra.publicmetadbWatchlist;
  } else {
    delete accounts.apiKeys[info.key];
    delete accounts[info.master];
    delete accounts.watchTracking[service];
    delete accounts.labels[service];
    if (service === 'publicmetadb') delete accounts.publicmetadbWatchlist;
  }
  return { ...user, accounts };
}

export function withTracking(user: JellyfinUser, service: CardService, patch: { enabled?: boolean; movie?: boolean; series?: boolean }): JellyfinUser {
  const accounts = copyAccounts(user);
  if (patch.enabled !== undefined) accounts[CARD_SERVICES[service].master] = patch.enabled;
  if (patch.movie !== undefined || patch.series !== undefined) {
    accounts.watchTracking[service] = {
      ...(accounts.watchTracking[service] ?? {}),
      ...(patch.movie !== undefined ? { movie: patch.movie } : {}),
      ...(patch.series !== undefined ? { series: patch.series } : {}),
    };
  }
  return { ...user, accounts };
}

function reads(user: JellyfinUser, service: CardService): boolean {
  return user.trackers !== true && cardAccount(user, service).connected && user.accounts?.[CARD_SERVICES[service].master] !== false;
}

export function trackerOptionsFor(user: JellyfinUser): Array<{ value: string; label: string }> {
  return (['mdblist', 'simkl', 'publicmetadb'] as CardService[])
    .filter((service) => reads(user, service))
    .map((service) => ({ value: service, label: CARD_SERVICES[service].label }));
}

export function watchlistOptionsFor(user: JellyfinUser): Array<{ value: string; label: string; shelves: Shelf[] }> {
  return (['mdblist', 'simkl', 'publicmetadb', 'anilist', 'mal'] as CardService[])
    .filter((service) => reads(user, service) && (service !== 'publicmetadb' || Boolean(user.accounts?.publicmetadbWatchlist)))
    .map((service) => ({ value: service, label: CARD_SERVICES[service].label, shelves: CARD_SERVICES[service].shelves }));
}

const WATCHLIST_SLOTS: Partial<Record<CardService, CatalogConfig[]>> = {
  mdblist: [{
    id: 'mdblist.watchlist', type: 'all', name: 'Watchlist', enabled: true, showInHome: true, source: 'mdblist',
    sourceUrl: 'https://api.mdblist.com/watchlist/items?unified=true', enableRatingPosters: true, metadata: { accountsOnly: true },
  } as CatalogConfig],
  simkl: (['movies', 'shows', 'anime'] as const).map((type) => ({
    id: `simkl.watchlist.${type}.plantowatch`,
    type: type === 'movies' ? 'movie' : type === 'anime' ? 'anime' : 'series',
    name: `Simkl Plan to Watch ${type.charAt(0).toUpperCase()}${type.slice(1)}`,
    enabled: true, showInHome: true, source: 'simkl', metadata: { status: 'plantowatch', accountsOnly: true },
  } as CatalogConfig)),
  anilist: [{ id: 'anilist.Planning', type: 'anime', name: 'Planning', enabled: true, showInHome: true, source: 'anilist', metadata: { listName: 'Planning', accountsOnly: true } } as CatalogConfig],
  mal: [{ id: 'mal.userlist.plan_to_watch', type: 'anime', name: 'MyAnimeList Plan to Watch', enabled: true, showInHome: true, source: 'mal', metadata: { accountsOnly: true } } as CatalogConfig],
};

export function missingWatchlistSlots(catalogs: Array<Pick<CatalogConfig, 'id'>>, service: CardService): CatalogConfig[] {
  const held = (id: string) => catalogs.some((c) => c.id === id || (id === 'mdblist.watchlist' && c.id.startsWith('mdblist.watchlist')));
  return (WATCHLIST_SLOTS[service] ?? []).filter((slot) => !held(slot.id));
}

export function handoffNameClash(mainName: string, mainHandoff: string[] | undefined, users: JellyfinUser[]): string | null {
  const owners = new Map<string, string>();
  const claim = (owner: string, names: Array<string | undefined>): string | null => {
    for (const raw of names) {
      const name = (raw ?? '').trim();
      if (!name) continue;
      const held = owners.get(name.toLowerCase());
      if (held !== undefined && held !== owner) return name;
      owners.set(name.toLowerCase(), owner);
    }
    return null;
  };
  const first = claim('', [mainName, ...(mainHandoff ?? [])]);
  if (first) return first;
  for (const user of users) {
    const clash = claim(user.id, [user.name, ...(user.handoffNames ?? [])]);
    if (clash) return clash;
  }
  return null;
}
