import { useEffect, useState } from "react";
import { useConfig } from "@/contexts/ConfigContext";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";
import type { CardService, CatalogConfig, JellyfinUser } from "@/contexts/config";
import { disconnectCardAccount, persistIntegrationCredential } from "@/lib/integrationCredentials";
import { CARD_SERVICES, CARD_SERVICE_ORDER, cardAccount, missingWatchlistSlots, withAccount, withTracking } from "@/lib/cardAccounts";
import { ApiKeyConnect } from "@/components/accounts/ApiKeyConnect";
import { OAuthTokenConnect } from "@/components/accounts/OAuthTokenConnect";
import { SimklConnect } from "@/components/accounts/SimklConnect";

interface UserAccountsProps {
  user: JellyfinUser;
  catalogs: CatalogConfig[];
  onChange: (next: JellyfinUser) => void;
  onAddCatalogs: (entries: CatalogConfig[]) => void;
}

export function UserAccounts({ user, catalogs, onChange, onAddCatalogs }: UserAccountsProps) {
  const { auth } = useConfig();
  const [open, setOpen] = useState<CardService | null>(null);
  const [busy, setBusy] = useState<CardService | null>(null);
  const [stale, setStale] = useState<Partial<Record<CardService, boolean>>>({});

  const simklToken = user.accounts?.apiKeys?.simklTokenId;
  const anilistToken = user.accounts?.apiKeys?.anilistTokenId;
  const malToken = user.accounts?.apiKeys?.malTokenId;
  useEffect(() => {
    let cancelled = false;
    const tokens: Array<[CardService, string | undefined]> = [['simkl', simklToken], ['anilist', anilistToken], ['mal', malToken]];
    for (const [service, tokenId] of tokens) {
      if (!tokenId) continue;
      fetch('/api/oauth/token/info', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tokenId }) })
        .then((res) => { if (!cancelled) setStale((prev) => ({ ...prev, [service]: !res.ok })); })
        .catch(() => undefined);
    }
    return () => { cancelled = true; };
  }, [simklToken, anilistToken, malToken]);

  const connected = (service: CardService, value: string, extra: { label?: string; publicmetadbWatchlist?: string }) => {
    onChange(withAccount(user, service, value, extra));
    setOpen(null);
    toast.success(`${user.name} connected to ${CARD_SERVICES[service].label}${extra.label ? ` as ${extra.label}` : ''}`);
    if (service === 'simkl' || service === 'anilist' || service === 'mal') {
      void persistIntegrationCredential({ provider: service, tokenId: value, userUUID: auth.userUUID, password: auth.password, authenticated: auth.authenticated, profile: user.id })
        .then((result) => { if (result.error) toast.warning(`Connected; save the configuration to keep it (${result.error})`); });
    }
  };

  const disconnect = async (service: CardService) => {
    const path = CARD_SERVICES[service].disconnectPath;
    if (path && auth.userUUID) {
      setBusy(service);
      const result = await disconnectCardAccount(path, auth.userUUID, user.id, auth.password);
      setBusy(null);
      if (!result.ok) {
        toast.error(result.error ?? 'Disconnect failed');
        return;
      }
    }
    onChange(withAccount(user, service, undefined));
  };

  return (
    <div className="space-y-2 border-t pt-3">
      <Label className="text-xs font-medium">Accounts</Label>
      <p className="text-[11px] text-muted-foreground">
        Connect {user.name}'s own trackers. Once any is connected, what they play, mark, drop or heart goes to these accounts only, and their shelves and watchlist catalogs read from them. Your accounts are never used for them.
      </p>
      {CARD_SERVICE_ORDER.map((service) => {
        const info = CARD_SERVICES[service];
        const account = cardAccount(user, service);
        const missing = account.connected ? missingWatchlistSlots(catalogs, service) : [];
        return (
          <div key={service} className="space-y-2 rounded-md border px-3 py-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="w-28 text-xs font-medium">{info.label}</span>
              {account.connected ? (
                <>
                  <span className="text-xs text-emerald-400">{account.label ? `Connected as ${account.label}` : 'Connected'}</span>
                  {stale[service] ? <span className="text-xs text-amber-400">This sign-in no longer works; disconnect and connect again.</span> : null}
                  <Button size="sm" variant="ghost" className="ml-auto h-7 text-xs" disabled={busy === service} onClick={() => disconnect(service)}>
                    {busy === service ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Disconnect'}
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="outline" className="ml-auto h-7 text-xs" onClick={() => setOpen(open === service ? null : service)}>
                  {open === service ? 'Cancel' : 'Connect'}
                </Button>
              )}
            </div>
            {!account.connected && open === service ? (
              service === 'simkl' ? <SimklConnect onConnected={(tokenId, username) => connected('simkl', tokenId, { label: username })} />
              : service === 'anilist' ? <OAuthTokenConnect provider="anilist" authUrl="/anilist/auth" label="AniList" onConnected={(tokenId, username) => connected('anilist', tokenId, { label: username })} />
              : service === 'mal' ? <OAuthTokenConnect provider="mal" authUrl="/mal/auth" label="MyAnimeList" onConnected={(tokenId, username) => connected('mal', tokenId, { label: username })} />
              : <ApiKeyConnect service={service} onConnected={(key, found) => connected(service, key, found)} />
            ) : null}
            {account.connected ? (
              <div className="flex flex-wrap items-center gap-4 text-xs">
                <label className="flex items-center gap-1.5">
                  <Switch checked={account.enabled} onCheckedChange={(next) => onChange(withTracking(user, service, { enabled: next }))} aria-label={`Watch tracking on ${info.label} for ${user.name}`} />
                  Watch tracking
                </label>
                <label className="flex items-center gap-1.5">
                  <Switch checked={account.movie} disabled={!account.enabled} onCheckedChange={(next) => onChange(withTracking(user, service, { movie: next }))} aria-label={`Track movies on ${info.label}`} />
                  Movies
                </label>
                <label className="flex items-center gap-1.5">
                  <Switch checked={account.series} disabled={!account.enabled} onCheckedChange={(next) => onChange(withTracking(user, service, { series: next }))} aria-label={`Track series on ${info.label}`} />
                  Series
                </label>
                {service === 'publicmetadb' && !user.accounts?.publicmetadbWatchlist ? (
                  <span className="text-amber-400">No watchlist list on this account, so PublicMetaDB is not one of their watchlist shelves.</span>
                ) : null}
              </div>
            ) : null}
            {missing.length ? (
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => onAddCatalogs(missing)}>
                <Plus className="mr-1 h-3 w-3" /> Add {info.label} watchlist to the catalogs
              </Button>
            ) : null}
          </div>
        );
      })}
      <p className="text-[11px] text-muted-foreground">
        When plays are recorded follows Watch Tracking in General, for every user.
      </p>
    </div>
  );
}
