export type AccountService = 'simkl' | 'mdblist' | 'publicmetadb' | 'anilist' | 'mal';

export const ACCOUNT_SERVICES: Record<AccountService, { key: string; master: string }> = {
  simkl: { key: 'simklTokenId', master: 'simklWatchTracking' },
  mdblist: { key: 'mdblist', master: 'mdblistWatchTracking' },
  publicmetadb: { key: 'publicmetadb', master: 'publicmetadbWatchTracking' },
  anilist: { key: 'anilistTokenId', master: 'anilistWatchTracking' },
  mal: { key: 'malTokenId', master: 'malWatchTracking' },
};

export const ACCOUNT_SERVICE_LIST = Object.keys(ACCOUNT_SERVICES) as AccountService[];

/** Someone else, with at least one account of their own. */
export function isHolderCard(card: any): boolean {
  if (!card || card.trackers === true) return false;
  const keys = card.accounts?.apiKeys ?? {};
  return ACCOUNT_SERVICE_LIST.some((service) => Boolean(keys[ACCOUNT_SERVICES[service].key]));
}

export function holderCards(config: any): any[] {
  const cards = Array.isArray(config?.jellyfinUsers) ? config.jellyfinUsers : [];
  return cards.filter((card: any) => typeof card?.id === 'string' && card.id && isHolderCard(card));
}

export function withAccountOwner(config: any, owner: string | null | undefined): any {
  if (!owner) return config;
  const card = holderCards(config).find((c) => c.id === owner);
  if (!card) return config;
  return { ...config, jellyfinAccounts: card.accounts, jellyfinAccountOwner: card.id };
}

export function accountOwner(config: any): string {
  return config?.jellyfinAccounts && typeof config.jellyfinAccountOwner === 'string' ? config.jellyfinAccountOwner : '';
}

/** The config with the account fields of one service, or all five, taken from the holder. */
export function trackerConfig(config: any, only?: AccountService): any {
  const accounts = config?.jellyfinAccounts;
  if (!accounts) return config;
  const out: any = { ...config, apiKeys: { ...(config.apiKeys ?? {}) }, watchTracking: { ...(config.watchTracking ?? {}) } };
  for (const service of only ? [only] : ACCOUNT_SERVICE_LIST) {
    const { key, master } = ACCOUNT_SERVICES[service];
    out.apiKeys[key] = accounts.apiKeys?.[key] || undefined;
    out[master] = accounts[master];
    out.watchTracking[service] = accounts.watchTracking?.[service];
  }
  if (!only || only === 'simkl') out.simklUser = accounts.simklUser;
  return out;
}

export function credentialOf(config: any, service: AccountService): string | undefined {
  return trackerConfig(config, service)?.apiKeys?.[ACCOUNT_SERVICES[service].key] || undefined;
}
