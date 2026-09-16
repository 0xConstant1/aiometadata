import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Check, Download, LayoutGrid, Loader2, Pause, Play, Search, TableProperties, X } from "lucide-react";
import {
  useJellyfinConfiguration,
  useJellyfinExport,
  useJellyfinOverview,
  useJellyfinSearch,
  type DashboardTab,
  type JellyfinPlayRow,
  type JellyfinSessionRow,
} from "@/hooks/useDashboardQueries";

function when(value: number | null | undefined): string {
  if (!value) return "—";
  const diff = Date.now() - value;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} d ago`;
  return new Date(value).toLocaleDateString();
}

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

const percentOf = (row: JellyfinPlayRow): number | null =>
  row.runtimeMs > 0 ? Math.round((row.positionMs / row.runtimeMs) * 100) : null;

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-muted/30 px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Art({ src, title, wide }: { src: string | null; title: string; wide: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const shape = wide ? "aspect-video" : "aspect-[2/3]";
  if (!src || failed) {
    return (
      <div className={`${shape} w-full rounded-md bg-muted/60 flex items-end p-2`}>
        <span className="text-[11px] leading-tight text-muted-foreground line-clamp-2">{title}</span>
      </div>
    );
  }
  return <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} className={`${shape} w-full rounded-md object-cover bg-muted/60`} />;
}

function Caption({ title, episode, meta }: { title: string; episode: string | null; meta: string }) {
  return (
    <div className="min-w-0">
      <p className="text-xs font-medium leading-tight truncate" title={title}>{title}</p>
      {episode && <p className="text-[11px] text-muted-foreground leading-tight truncate" title={episode}>{episode}</p>}
      <p className="text-[11px] text-muted-foreground leading-tight truncate">{meta}</p>
    </div>
  );
}

function SessionCard({ s }: { s: JellyfinSessionRow }) {
  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Art src={s.imageUrl} title={s.title} wide />
        <Badge variant={s.paused ? "secondary" : "default"} className="absolute top-1.5 left-1.5 gap-1 px-1.5 py-0 text-[10px]">
          {s.paused ? <Pause className="h-3 w-3" /> : <Play className="h-3 w-3" />}
          {clock(s.positionMs)}
        </Badge>
      </div>
      <Caption title={s.title} episode={s.episode} meta={`${s.viewer ? `${s.viewer}, into ${s.profile}'s history` : s.profile} · ${when(s.at)}`} />
    </div>
  );
}

function ProgressCard({ row }: { row: JellyfinPlayRow }) {
  const pct = percentOf(row);
  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Art src={row.imageUrl} title={row.title} wide />
        <span className="absolute top-1.5 right-1.5 rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-white">
          {clock(row.positionMs)}{pct !== null ? ` · ${pct}%` : ""}
        </span>
        {pct !== null && (
          <div className="absolute inset-x-0 bottom-0 h-1 bg-black/50 rounded-b-md overflow-hidden">
            <div className="h-full bg-primary" style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} />
          </div>
        )}
      </div>
      <Caption title={row.title} episode={row.episode} meta={`${row.profile} · ${when(row.lastPlayedAt ?? row.updatedAt)}`} />
    </div>
  );
}

function PlayedCard({ row }: { row: JellyfinPlayRow }) {
  return (
    <div className="space-y-1.5">
      <div className="relative">
        <Art src={row.posterUrl} title={row.title} wide={false} />
        <span className="absolute top-1.5 right-1.5 rounded-full bg-black/60 p-1 text-white"><Check className="h-3 w-3" /></span>
      </div>
      <Caption title={row.title} episode={row.episode} meta={`${row.profile} · ${when(row.lastPlayedAt)}`} />
    </div>
  );
}

function PlayTable({ rows, kind }: { rows: JellyfinPlayRow[]; kind: "progress" | "played" }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-muted-foreground">
            <th className="text-left font-medium py-2 pr-3">Title</th>
            <th className="text-left font-medium py-2 pr-3">Profile</th>
            <th className="text-left font-medium py-2 pr-3 font-mono">Id</th>
            <th className="text-right font-medium py-2 pr-3">{kind === "progress" ? "Position" : "Played"}</th>
            <th className="text-right font-medium py-2">{kind === "progress" ? "Last played" : "Runtime"}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const pct = percentOf(row);
            return (
              <tr key={`${row.profile}|${row.videoId}`} className="border-t border-white/[0.06]">
                <td className="py-2 pr-3">
                  <span className="font-medium">{row.title}</span>
                  {row.episode && <span className="text-muted-foreground"> · {row.episode}</span>}
                </td>
                <td className="py-2 pr-3 text-muted-foreground whitespace-nowrap">{row.profile}</td>
                <td className="py-2 pr-3 font-mono text-muted-foreground whitespace-nowrap">{row.videoId}</td>
                <td className="py-2 pr-3 text-right tabular-nums whitespace-nowrap">
                  {kind === "progress"
                    ? <>{clock(row.positionMs)}{pct !== null && <span className="text-muted-foreground"> · {pct}%</span>}</>
                    : when(row.lastPlayedAt)}
                </td>
                <td className="py-2 text-right tabular-nums text-muted-foreground whitespace-nowrap">
                  {kind === "progress" ? when(row.lastPlayedAt ?? row.updatedAt) : row.runtimeMs > 0 ? clock(row.runtimeMs) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Shelf({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">
        {title} <span className="tabular-nums">({count})</span>
      </p>
      {children}
    </section>
  );
}

type View = "cards" | "table";

function Configuration({ userUUID, activeTab, onClose }: { userUUID: string; activeTab: DashboardTab; onClose: () => void }) {
  const [profile, setProfile] = useState<string | null>(null);
  const [view, setView] = useState<View>("cards");
  const [exporting, setExporting] = useState(false);
  const exportJson = useJellyfinExport();
  const { data, isLoading, isError } = useJellyfinConfiguration(userUUID, profile, { activeTab });

  const runExport = async () => {
    setExporting(true);
    try {
      await exportJson(userUUID);
      toast.success("Exported");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  if (isLoading && !data) return <p className="text-xs text-muted-foreground px-4 py-3 flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" /> Loading playback…</p>;
  if (isError || !data) return <p className="text-xs text-red-500 px-4 py-3">Could not load this configuration's playback.</p>;

  const shown = profile === null ? data.profiles : data.profiles.filter((p) => p.key === profile);
  const inProgress = shown.reduce((n, p) => n + p.inProgress, 0);
  const played = shown.reduce((n, p) => n + p.played, 0);
  const lastActivity = shown.reduce<number | null>((at, p) => Math.max(at ?? 0, p.lastActivity ?? 0) || null, null);
  const wide = "grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-6 gap-3";
  const tall = "grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8 gap-3";

  return (
    <div className="border-t border-white/[0.06]">
      <div className="flex flex-wrap items-center gap-3 px-4 py-3">
        <span className="font-medium">{data.label}</span>
        <span className="font-mono text-xs text-muted-foreground">{data.userUUID}</span>
        <span className="text-xs text-muted-foreground tabular-nums">{inProgress} in progress · {played} played · {when(lastActivity)}</span>
        <span className="ml-auto flex items-center gap-2">
          <div className="inline-flex rounded-md border border-white/[0.08] p-0.5">
            <Button size="sm" variant={view === "cards" ? "secondary" : "ghost"} className="h-7 px-2" onClick={() => setView("cards")} aria-label="Cards"><LayoutGrid className="h-3.5 w-3.5" /></Button>
            <Button size="sm" variant={view === "table" ? "secondary" : "ghost"} className="h-7 px-2" onClick={() => setView("table")} aria-label="Table"><TableProperties className="h-3.5 w-3.5" /></Button>
          </div>
          <Button size="sm" variant="outline" className="h-7 gap-1" onClick={runExport} disabled={exporting}>
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Export JSON
          </Button>
          <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onClose} aria-label="Close"><X className="h-3.5 w-3.5" /></Button>
        </span>
      </div>
      {(data.profiles.length > 1 || data.profiles.some((p) => p.sharedWith.length > 0)) && (
        <div className="flex flex-wrap gap-1.5 px-4 pb-3">
          <Button size="sm" variant={profile === null ? "secondary" : "outline"} className="h-7" onClick={() => setProfile(null)}>All</Button>
          {data.profiles.map((p) => (
            <Button key={p.key} size="sm" variant={profile === p.key ? "secondary" : "outline"} className="h-7 gap-1.5" onClick={() => setProfile(p.key)}>
              {p.name}
              {p.sharedWith.length > 0 && <span className="text-muted-foreground">· shared with {p.sharedWith.join(", ")}</span>}
              <span className="text-muted-foreground tabular-nums">{p.inProgress} · {p.played}</span>
            </Button>
          ))}
        </div>
      )}
      <div className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
        {data.sessions.length > 0 && (
          <Shelf title="Playing now" count={data.sessions.length}>
            <div className={wide}>{data.sessions.map((s, i) => <SessionCard key={`${s.title}-${i}`} s={s} />)}</div>
          </Shelf>
        )}
        <Shelf title="Continue watching" count={data.inProgress.length}>
          {data.inProgress.length === 0
            ? <p className="text-xs text-muted-foreground">Nothing in progress.</p>
            : view === "table"
              ? <PlayTable rows={data.inProgress} kind="progress" />
              : <div className={wide}>{data.inProgress.map((row) => <ProgressCard key={`${row.profile}|${row.videoId}`} row={row} />)}</div>}
        </Shelf>
        <Shelf title="Recently played" count={data.recentlyPlayed.length}>
          {data.recentlyPlayed.length === 0
            ? <p className="text-xs text-muted-foreground">Nothing played yet.</p>
            : view === "table"
              ? <PlayTable rows={data.recentlyPlayed} kind="played" />
              : <div className={tall}>{data.recentlyPlayed.map((row) => <PlayedCard key={`${row.profile}|${row.videoId}`} row={row} />)}</div>}
        </Shelf>
      </div>
    </div>
  );
}

export default function DashboardJellyfin({ activeTab }: { activeTab: DashboardTab }) {
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed.trim()), 300);
    return () => clearTimeout(timer);
  }, [typed]);

  const overview = useJellyfinOverview({ activeTab });
  const search = useJellyfinSearch(query, { activeTab });
  const o = overview.data;
  const sync = o?.sync;
  const syncHint = !sync ? "" : sync.running
    ? "running now"
    : sync.finishedAt
      ? `${sync.added} imported across ${sync.configurations} configuration${sync.configurations === 1 ? "" : "s"}`
      : "not yet run";

  const pick = (userUUID: string) => {
    setSelected(userUUID);
    setTyped("");
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <Stat label="Playing now" value={o?.playingNow ?? "…"} hint={o ? `${o.sessions} session${o.sessions === 1 ? "" : "s"} known` : undefined} />
        <Stat label="Active configurations" value={o ? (o.activeConfigurations ?? "—") : "…"} hint={o ? `used the server in the last ${o.activeDays} days` : undefined} />
        <Stat label="Plays, 24 h" value={o?.playedDay ?? "…"} hint={o ? `${o.playedWeek} this week` : undefined} />
        <Stat label="Tracker sync" value={sync ? (sync.running ? "…" : sync.finishedAt ? when(sync.finishedAt) : "—") : "…"} hint={syncHint || undefined} />
      </div>

      <Card>
        <CardHeader className="space-y-3">
          <div>
            <CardTitle className="text-base">Playback of a configuration</CardTitle>
            <CardDescription>
              What the server recorded for one configuration: live sessions, positions and plays that went through it, and what the tracker sync imported. Look a configuration up by its id or a user name.
            </CardDescription>
          </div>
          <div className="relative max-w-md">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              id="jellyfin-configuration-search"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="Configuration id or user name"
              className="pl-8"
            />
            {query && (
              <div className="absolute z-20 mt-1 w-full rounded-md border border-white/[0.08] bg-popover shadow-lg">
                {search.isLoading ? (
                  <p className="text-xs text-muted-foreground px-3 py-2 flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" /> Searching…</p>
                ) : !search.data || search.data.results.length === 0 ? (
                  <p className="text-xs text-muted-foreground px-3 py-2">Nothing matches "{query}".</p>
                ) : (
                  search.data.results.map((row) => (
                    <button
                      key={row.userUUID}
                      type="button"
                      onClick={() => pick(row.userUUID)}
                      className="w-full flex items-center gap-3 px-3 py-2 text-left text-xs hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      <span className="font-medium">{row.label}</span>
                      <span className="font-mono text-muted-foreground">{row.userUUID.slice(0, 8)}</span>
                      <span className="text-muted-foreground truncate">{row.profiles.map((p) => p.name).join(", ")}</span>
                      <span className="ml-auto text-muted-foreground whitespace-nowrap">{when(row.lastActivity)}</span>
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {selected
            ? <Configuration userUUID={selected} activeTab={activeTab} onClose={() => setSelected(null)} />
            : <p className="text-xs text-muted-foreground px-4 py-3">Search for a configuration to see its playback.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
