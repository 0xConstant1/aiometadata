import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Check, ChevronDown, ChevronUp, LayoutGrid, Loader2, Pause, Play, Search, TableProperties, Upload, X } from "lucide-react";
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

function duration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes <= 0) return "";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h ${m}m` : `${h}h`;
}

function stamp(value: number | null): string {
  if (!value) return "—";
  const d = new Date(value);
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })} at ${d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
}

function episodeCode(row: JellyfinPlayRow, spaced = false): string {
  if (row.number === null) return "";
  const e = `E${String(row.number).padStart(2, "0")}`;
  if (row.season === null) return e;
  return `S${String(row.season).padStart(2, "0")}${spaced ? " " : ""}${e}`;
}

const playedAt = (row: JellyfinPlayRow): number => row.lastPlayedAt ?? row.updatedAt;

interface DayTile {
  key: string;
  title: string;
  posterUrl: string | null;
  profile: string;
  show: boolean;
  rows: JellyfinPlayRow[];
  runtimeMs: number;
  at: number;
}

interface DayGroup {
  key: string;
  date: Date;
  tiles: DayTile[];
  movies: number;
  shows: number;
  episodes: number;
  runtimeMs: number;
}

function groupByDay(rows: JellyfinPlayRow[]): DayGroup[] {
  const days = new Map<string, DayGroup>();
  for (const row of rows) {
    const at = playedAt(row);
    const date = new Date(at);
    const dayKey = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    let day = days.get(dayKey);
    if (!day) {
      day = { key: dayKey, date: new Date(date.getFullYear(), date.getMonth(), date.getDate()), tiles: [], movies: 0, shows: 0, episodes: 0, runtimeMs: 0 };
      days.set(dayKey, day);
    }
    const show = row.seriesId !== null;
    const tileKey = `${row.profile}|${show ? row.seriesId : row.videoId}`;
    let tile = day.tiles.find((t) => t.key === tileKey);
    if (!tile) {
      tile = { key: tileKey, title: row.title, posterUrl: row.posterUrl, profile: row.profile, show, rows: [], runtimeMs: 0, at: 0 };
      day.tiles.push(tile);
      if (show) day.shows += 1; else day.movies += 1;
    }
    tile.rows.push(row);
    tile.runtimeMs += row.runtimeMs;
    tile.at = Math.max(tile.at, at);
    day.runtimeMs += row.runtimeMs;
    if (show) day.episodes += 1;
  }
  for (const day of days.values()) {
    for (const tile of day.tiles) {
      tile.rows.sort((a, b) => (a.season ?? -1) - (b.season ?? -1) || (a.number ?? 0) - (b.number ?? 0));
    }
    day.tiles.sort((a, b) => b.at - a.at);
  }
  return [...days.values()].sort((a, b) => b.date.getTime() - a.date.getTime());
}

function EpisodeLine({ row }: { row: JellyfinPlayRow }) {
  return (
    <div className="flex gap-3 rounded-md border border-white/[0.06] bg-muted/20 p-2">
      <div className="w-24 shrink-0"><Art src={row.imageUrl ?? row.posterUrl} title={row.title} wide /></div>
      <div className="min-w-0 flex-1">
        <p className="text-xs leading-tight truncate"><span className="text-primary font-medium">{episodeCode(row, true)}</span>{row.episodeTitle ? ` ${row.episodeTitle}` : ""}</p>
        <p className="text-[11px] text-muted-foreground">{stamp(row.lastPlayedAt)}</p>
      </div>
      {row.runtimeMs > 0 && <span className="self-end rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-white">{duration(row.runtimeMs)}</span>}
    </div>
  );
}

function DayTileCard({ tile }: { tile: DayTile }) {
  const [open, setOpen] = useState(false);
  const many = tile.rows.length > 1;
  const first = tile.rows[0];
  const last = tile.rows[tile.rows.length - 1];
  return (
    <div className={`rounded-lg border border-white/[0.06] bg-muted/30 ${open ? "sm:col-span-2 lg:col-span-3" : ""}`}>
      <div className="flex gap-3 p-3">
        <div className="w-16 shrink-0"><Art src={tile.posterUrl} title={tile.title} wide={false} /></div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold leading-tight truncate" title={tile.title}>{tile.title}</p>
          <p className="text-[11px] text-muted-foreground">{tile.profile}</p>
          {tile.show && many && (
            <p className="mt-1 text-xs"><span className="text-primary font-medium">{tile.rows.length} episodes</span> <span className="text-muted-foreground">{episodeCode(first)} - {episodeCode(last)}</span></p>
          )}
          {tile.show && !many && (
            <p className="mt-1 text-xs truncate"><span className="text-primary font-medium">{episodeCode(first, true)}</span>{first.episodeTitle ? ` ${first.episodeTitle}` : ""}</p>
          )}
          {!many && <p className="text-[11px] text-muted-foreground">{stamp(first.lastPlayedAt)}</p>}
        </div>
        <div className="flex flex-col items-end justify-between shrink-0">
          {many
            ? <Button variant="ghost" size="sm" className="h-8 w-8 p-0" onClick={() => setOpen((v) => !v)} aria-label={open ? "Hide episodes" : "Show episodes"}>{open ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</Button>
            : <span className="rounded-full bg-black/60 p-1 text-white"><Check className="h-3 w-3" /></span>}
          {tile.runtimeMs > 0 && <span className="rounded bg-black/60 px-1.5 py-0.5 text-[10px] tabular-nums text-white">{duration(tile.runtimeMs)}</span>}
        </div>
      </div>
      {open && (
        <div className="grid grid-cols-1 gap-2 border-t border-white/[0.06] p-3 sm:grid-cols-2 lg:grid-cols-3">
          {[...tile.rows].reverse().map((row) => <EpisodeLine key={`${row.profile}|${row.videoId}`} row={row} />)}
        </div>
      )}
    </div>
  );
}

const DAY_TILE_CAP = 6;

function PlayedDay({ day }: { day: DayGroup }) {
  const [all, setAll] = useState(false);
  const hidden = day.tiles.slice(DAY_TILE_CAP - 1);
  const capped = !all && day.tiles.length > DAY_TILE_CAP;
  const shown = capped ? day.tiles.slice(0, DAY_TILE_CAP - 1) : day.tiles;
  const rest = capped ? hidden : [];
  const restMovies = rest.filter((t) => !t.show).length;
  const restShows = rest.length - restMovies;
  const restEpisodes = rest.reduce((n, t) => n + (t.show ? t.rows.length : 0), 0);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <p className="text-sm font-semibold">
          {day.date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })} · {day.date.toLocaleDateString(undefined, { weekday: "long" })}
          {day.runtimeMs > 0 && <span className="ml-2 text-xs font-normal text-muted-foreground">{duration(day.runtimeMs)}</span>}
        </p>
        <p className="text-xs text-muted-foreground tabular-nums">
          {day.movies > 0 && <span className="mr-3"><span className="text-foreground">{day.movies}</span> {day.movies === 1 ? "movie" : "movies"}</span>}
          {day.shows > 0 && <span className="mr-3"><span className="text-foreground">{day.shows}</span> {day.shows === 1 ? "show" : "shows"}</span>}
          {day.episodes > 0 && <span><span className="text-foreground">{day.episodes}</span> eps</span>}
        </p>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((tile) => <DayTileCard key={tile.key} tile={tile} />)}
        {capped && (
          <button type="button" onClick={() => setAll(true)} className="flex items-center gap-3 rounded-lg border border-dashed border-white/[0.15] p-3 text-left hover:bg-muted/30">
            <span className="flex h-12 w-12 shrink-0 items-center justify-center rounded-md bg-muted/60 text-lg font-semibold tabular-nums">{rest.length}</span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">Show {rest.length} more</span>
              <span className="block text-[11px] text-muted-foreground">
                {[restMovies ? `${restMovies} ${restMovies === 1 ? "movie" : "movies"}` : "", restShows ? `${restShows} ${restShows === 1 ? "show" : "shows"}` : "", restEpisodes ? `${restEpisodes} eps` : ""].filter(Boolean).join(" · ")}
              </span>
            </span>
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          </button>
        )}
        {all && day.tiles.length > DAY_TILE_CAP && (
          <button type="button" onClick={() => setAll(false)} className="flex items-center justify-center gap-2 rounded-lg border border-dashed border-white/[0.15] p-3 text-xs text-muted-foreground hover:bg-muted/30">
            Show less <ChevronUp className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  );
}

function PlayedByDay({ rows }: { rows: JellyfinPlayRow[] }) {
  const days = groupByDay(rows);
  return <div className="space-y-5">{days.map((day) => <PlayedDay key={day.key} day={day} />)}</div>;
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
  const [rows, setRows] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  const exportJson = useJellyfinExport();
  const { data, isLoading, isError, isFetching } = useJellyfinConfiguration(userUUID, profile, rows, { activeTab });

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
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            {isFetching && !isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Rows"}
            <select
              id="jellyfin-dashboard-rows"
              value={rows ?? data.rows}
              onChange={(event) => setRows(Number(event.target.value))}
              className="h-7 rounded-md border border-white/[0.08] bg-background px-1.5 text-xs text-foreground"
            >
              {[...new Set([data.rows, 50, 100, 200, 500])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <Button size="sm" variant="outline" className="h-7 gap-1" onClick={runExport} disabled={exporting}>
            {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Export JSON
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
      <div className={`divide-y divide-white/[0.06] border-t border-white/[0.06] transition-opacity ${isFetching && !isLoading ? "opacity-60" : "opacity-100"}`}>
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
              : <PlayedByDay rows={data.recentlyPlayed} />}
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
