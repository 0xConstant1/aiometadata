import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import JellyfinCalendar from "./JellyfinCalendar";
import JellyfinLibrary from "./JellyfinLibrary";
import { sizedArt } from "./art";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, RefreshCw, LayoutGrid, Loader2, Pause, Play, Search, TableProperties, Upload, X } from "lucide-react";
import {
  useJellyfinConfiguration,
  useJellyfinExport,
  useJellyfinOverview,
  useJellyfinSearch,
  useJellyfinShowRefresh,
  useJellyfinShows,
  type DashboardTab,
  type JellyfinEpisodeRef,
  type JellyfinShowRow,
  type JellyfinConfiguration,
  type JellyfinPlayRow,
  type JellyfinProfileSummary,
  type JellyfinSessionRow,
  type JellyfinSyncRow,
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
  return <img src={sizedArt(src, wide ? 780 : 342) ?? src} alt="" loading="lazy" onError={() => setFailed(true)} className={`${shape} w-full rounded-md object-cover bg-muted/60`} />;
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

function ProgressCard({ row }: { row: JellyfinPlayRow }) {
  const pct = percentOf(row);
  const left = row.runtimeMs > row.positionMs ? duration(row.runtimeMs - row.positionMs) : "";
  const code = episodeCode(row, true);
  const subtitle = code ? `${code}${row.episodeTitle ? ` · ${row.episodeTitle}` : ""}` : row.episode;
  return (
    <div className="group relative overflow-hidden rounded-lg bg-muted/40 ring-1 ring-white/[0.06] transition hover:ring-white/20" title={`${row.title}${row.episode ? ` · ${row.episode}` : ""}`}>
      <div className="transition-transform duration-500 group-hover:scale-[1.03]"><Art src={row.backdropUrl && !row.seriesId ? row.backdropUrl : row.imageUrl ?? row.backdropUrl} title="" wide /></div>
      <div className="absolute inset-0 bg-gradient-to-t from-black/95 via-black/45 to-black/0" />
      <span className="glass absolute top-2 left-2 rounded-full px-2 py-0.5 text-[10px] text-white/85">{row.profile} · {when(row.lastPlayedAt ?? row.updatedAt)}</span>
      <div className="absolute inset-x-0 bottom-0 space-y-1.5 p-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight text-white">{row.title}</p>
          {subtitle && <p className="truncate text-[11px] leading-tight text-white/65">{subtitle}</p>}
        </div>
        <div className="flex items-center gap-2">
          <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/20">
            {pct !== null && <div className="h-full rounded-full bg-gradient-to-r from-blue-600 to-blue-400" style={{ width: `${Math.min(100, Math.max(2, pct))}%` }} />}
          </div>
          <span className="whitespace-nowrap text-[10px] tabular-nums text-white/75">{left ? `${left} left` : clock(row.positionMs)}</span>
        </div>
      </div>
    </div>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  const track = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: true, end: false });
  const measure = () => {
    const el = track.current;
    if (!el) return;
    const start = el.scrollLeft <= 4;
    const end = el.scrollLeft + el.clientWidth >= el.scrollWidth - 4;
    setEdges((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  };
  useEffect(measure, [children]);
  const page = (dir: 1 | -1) => track.current?.scrollBy({ left: dir * track.current.clientWidth * 0.85, behavior: "smooth" });
  const arrow = "glass absolute top-1/2 z-10 hidden h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-white transition hover:bg-black/60 md:flex";
  return (
    <div className="group/row relative -mx-4 sm:-mx-6">
      <div ref={track} onScroll={measure} className="flex snap-x gap-3 overflow-x-auto scroll-px-4 px-4 pb-2 sm:scroll-px-6 sm:px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {children}
      </div>
      {!edges.start && <button type="button" aria-label="Scroll back" onClick={() => page(-1)} className={`${arrow} left-2`}><ChevronLeft className="h-5 w-5" /></button>}
      {!edges.end && <button type="button" aria-label="Scroll on" onClick={() => page(1)} className={`${arrow} right-2`}><ChevronRight className="h-5 w-5" /></button>}
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

const SERVICE_LABELS: Record<string, string> = { mdblist: "MDBList", simkl: "Simkl", anilist: "AniList", mal: "MyAnimeList", publicmetadb: "PublicMetaDB" };

const dayKey = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

interface Activity {
  days: Record<string, number>;
  total: number;
  active: number;
  streak: number;
  best: number;
}

function activityOf(profiles: JellyfinProfileSummary[]): Activity {
  const days: Record<string, number> = {};
  for (const p of profiles) for (const [day, n] of Object.entries(p.days)) days[day] = (days[day] ?? 0) + n;
  const cursor = new Date();
  cursor.setHours(12, 0, 0, 0);
  if (!days[dayKey(cursor)]) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days[dayKey(cursor)]) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  let best = 0;
  let run = 0;
  const walk = new Date();
  walk.setHours(12, 0, 0, 0);
  walk.setDate(walk.getDate() - 370);
  for (let i = 0; i <= 370; i += 1, walk.setDate(walk.getDate() + 1)) {
    run = days[dayKey(walk)] ? run + 1 : 0;
    best = Math.max(best, run);
  }
  const counts = Object.values(days);
  return { days, total: counts.reduce((a, n) => a + n, 0), active: counts.filter((n) => n > 0).length, streak, best };
}

function Avatar({ src, name, size }: { src: string | null; name: string; size: "sm" | "lg" }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const box = size === "lg" ? "h-14 w-14 text-xl" : "h-5 w-5 text-[10px]";
  if (src && !failed) return <img src={src} alt="" onError={() => setFailed(true)} className={`${box} shrink-0 rounded-full object-cover ring-2 ring-white/10`} />;
  return <span className={`${box} shrink-0 rounded-full bg-blue-500/20 text-blue-300 font-semibold flex items-center justify-center ring-2 ring-white/10`}>{(name.trim()[0] ?? "?").toUpperCase()}</span>;
}

function HeroStat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="min-w-0">
      <p className="text-2xl sm:text-3xl font-semibold tabular-nums leading-none">{value}</p>
      <p className="mt-1 text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      {hint && <p className="text-[11px] text-muted-foreground/80 truncate">{hint}</p>}
    </div>
  );
}

function NowPlaying({ s }: { s: JellyfinSessionRow }) {
  const pct = s.runtimeMs > 0 ? Math.min(100, Math.max(1, (s.positionMs / s.runtimeMs) * 100)) : null;
  return (
    <div className="glass flex items-center gap-3 rounded-xl px-3 py-2">
      <div className="w-20 shrink-0"><Art src={s.imageUrl} title={s.title} wide /></div>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-xs leading-tight truncate">
          <span className={`mr-1.5 inline-flex items-center gap-1 rounded px-1 py-px text-[10px] font-medium ${s.paused ? "bg-white/10 text-muted-foreground" : "bg-blue-500/20 text-blue-300"}`}>
            {s.paused ? <Pause className="h-2.5 w-2.5" /> : <Play className="h-2.5 w-2.5" />}{s.paused ? "Paused" : "Playing"}
          </span>
          <span className="font-medium">{s.title}</span>
          {s.episode && <span className="text-muted-foreground"> · {s.episode}</span>}
        </p>
        <div className="flex items-center gap-2">
          <div className="h-1 flex-1 rounded-full bg-white/10 overflow-hidden">
            {pct !== null && <div className="h-full bg-gradient-to-r from-blue-600 to-blue-400" style={{ width: `${pct}%` }} />}
          </div>
          <span className="text-[10px] tabular-nums text-muted-foreground whitespace-nowrap">{clock(s.positionMs)}{s.runtimeMs > 0 ? ` / ${clock(s.runtimeMs)}` : ""}</span>
        </div>
        <p className="text-[10px] text-muted-foreground truncate">{s.viewer ? `${s.viewer}, into ${s.profile}'s history` : s.profile} · {when(s.at)}</p>
      </div>
    </div>
  );
}

function Hero({ data, profile, onProfile, activity, controls, switching }: {
  data: JellyfinConfiguration;
  profile: string | null;
  onProfile: (key: string | null) => void;
  activity: Activity;
  controls: React.ReactNode;
  switching: boolean;
}) {
  const shown = profile === null ? data.profiles : data.profiles.filter((p) => p.key === profile);
  const sum = (pick: (p: JellyfinProfileSummary) => number) => shown.reduce((n, p) => n + pick(p), 0);
  const lastActivity = shown.reduce<number | null>((at, p) => Math.max(at ?? 0, p.lastActivity ?? 0) || null, null);
  const lead = profile === null ? data.profiles[0] : shown[0];
  const backdrop = sizedArt(data.sessions[0]?.backdropUrl ?? data.inProgress[0]?.backdropUrl ?? data.recentlyPlayed[0]?.backdropUrl
    ?? data.sessions[0]?.imageUrl ?? data.inProgress[0]?.imageUrl ?? data.recentlyPlayed[0]?.imageUrl, 1280);
  const [loaded, setLoaded] = useState<string | null>(null);
  const chips = data.profiles.length > 1;
  return (
    <div className="relative overflow-hidden">
      {backdrop && (
        <img
          key={backdrop}
          src={backdrop}
          alt=""
          onLoad={() => setLoaded(backdrop)}
          className={`absolute inset-0 h-full w-full object-cover object-top transition-opacity duration-700 ${loaded === backdrop && !switching ? "opacity-50" : "opacity-0"}`}
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-r from-background via-background/85 to-background/30" />
      <div className="absolute inset-0 bg-gradient-to-t from-background via-background/40 to-transparent" />
      <div className="relative space-y-5 px-4 pt-4 pb-6 sm:px-6">
        <div className="flex flex-wrap items-center justify-end gap-2">{controls}</div>
        <div className="flex items-center gap-4">
          <Avatar src={lead?.avatar ?? null} name={lead?.name ?? data.label} size="lg" />
          <div className="min-w-0">
            <p className="text-2xl font-semibold leading-tight truncate">{profile === null ? data.label : lead?.name ?? data.label}</p>
            {switching ? (
              <p className="flex items-center gap-1.5 text-xs text-blue-300"><Loader2 className="h-3 w-3 animate-spin" /> Loading {profile === null ? "every profile" : lead?.name ?? "profile"}…</p>
            ) : (
              <p className="text-xs text-muted-foreground truncate">
                <span className="font-mono">{data.userUUID.slice(0, 8)}</span>
                {lastActivity ? ` · active ${when(lastActivity)}` : ""}
                {lead?.sharedWith.length ? ` · shared with ${lead.sharedWith.join(", ")}` : ""}
              </p>
            )}
          </div>
        </div>
        {chips && (
          <div className="flex flex-wrap gap-1.5">
            <button type="button" onClick={() => onProfile(null)} className={`h-7 rounded-full px-3 text-xs ring-1 transition-colors ${profile === null ? "bg-foreground text-background ring-transparent" : "glass ring-transparent hover:bg-black/50"}`}>All</button>
            {data.profiles.map((p) => (
              <button key={p.key} type="button" onClick={() => onProfile(p.key)} className={`h-7 inline-flex items-center gap-1.5 rounded-full pl-1 pr-3 text-xs ring-1 transition-colors ${profile === p.key ? "bg-foreground text-background ring-transparent" : "glass ring-transparent hover:bg-black/50"}`}>
                {switching && profile === p.key ? <Loader2 className="h-5 w-5 animate-spin p-0.5" /> : <Avatar src={p.avatar} name={p.name} size="sm" />}
                {p.name}
              </button>
            ))}
          </div>
        )}
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4 max-w-2xl">
          <HeroStat label="Movies" value={sum((p) => p.movies).toLocaleString()} />
          <HeroStat label="Episodes" value={sum((p) => p.episodes).toLocaleString()} />
          <HeroStat label="In progress" value={sum((p) => p.inProgress).toLocaleString()} />
          <HeroStat label="Day streak" value={activity.streak} hint={activity.best > activity.streak ? `best ${activity.best} this year` : undefined} />
        </div>
        {!switching && data.sessions.length > 0 && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 max-w-3xl">
            {data.sessions.map((s, i) => <NowPlaying key={`${s.title}-${i}`} s={s} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function SyncChip({ row }: { row: JellyfinSyncRow }) {
  const tone = row.lastError ? "bg-red-500" : row.pending > 0 ? "bg-amber-400" : row.imported ? "bg-emerald-500" : "bg-muted-foreground";
  const detail = [
    row.profiles.join(", "),
    row.fullAt ? `full read ${when(row.fullAt)}` : "never read in full",
    row.pending ? `${row.pending} waiting since ${when(row.oldestPendingAt)}, ${row.attempts} ${row.attempts === 1 ? "try" : "tries"}` : "",
    row.lastError ?? "",
  ].filter(Boolean).join(" · ");
  return (
    <span title={detail} className="glass inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs">
      <span className={`h-1.5 w-1.5 rounded-full ${tone}`} />
      <span className="font-medium">{SERVICE_LABELS[row.service] ?? row.service}</span>
      <span className="text-muted-foreground">{row.imported ? `synced ${when(row.syncedAt)}` : "not imported yet"}</span>
      {row.pending > 0 && <span className="text-amber-400 tabular-nums">{row.pending} waiting</span>}
    </span>
  );
}

function SyncStrip({ rows }: { rows: JellyfinSyncRow[] }) {
  const failed = rows.filter((r) => r.lastError);
  return (
    <section className="px-4 py-3 sm:px-6">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mr-1 text-[11px] uppercase tracking-wide text-muted-foreground">Trackers</span>
        {rows.length === 0
          ? <span className="text-xs text-muted-foreground">None connected. History is kept on this server only.</span>
          : rows.map((row, i) => <SyncChip key={`${row.service}-${i}`} row={row} />)}
      </div>
      {failed.map((row, i) => (
        <p key={`${row.service}-error-${i}`} className="mt-2 text-[11px] text-red-400 truncate" title={row.lastError ?? undefined}>
          {SERVICE_LABELS[row.service] ?? row.service}: {row.lastError}
        </p>
      ))}
    </section>
  );
}

const HEAT = ["bg-muted/50", "bg-blue-500/25", "bg-blue-500/50", "bg-blue-500/80", "bg-blue-400"];

function ActivityMap({ activity }: { activity: Activity }) {
  const [folded, fold] = useFolded("jellyfin.fold.activity");
  const scroller = useRef<HTMLDivElement>(null);
  const { weeks, months, cut } = useMemo(() => {
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const start = new Date(today);
    start.setDate(start.getDate() - 52 * 7 - today.getDay());
    const weeks: Array<Array<{ key: string; date: Date; n: number } | null>> = [];
    const months: Array<{ at: number; label: string }> = [];
    const cursor = new Date(start);
    let lastMonth = -1;
    while (cursor <= today) {
      const week: Array<{ key: string; date: Date; n: number } | null> = [];
      for (let d = 0; d < 7; d += 1) {
        if (cursor > today) week.push(null);
        else {
          const key = dayKey(cursor);
          week.push({ key, date: new Date(cursor), n: activity.days[key] ?? 0 });
        }
        cursor.setDate(cursor.getDate() + 1);
      }
      const first = week[0]?.date;
      if (first && first.getMonth() !== lastMonth) {
        months.push({ at: weeks.length, label: first.toLocaleDateString(undefined, { month: "short" }) });
        lastMonth = first.getMonth();
      }
      weeks.push(week);
    }
    const lit = Object.values(activity.days).filter((n) => n > 0).sort((a, b) => a - b);
    const q = (f: number) => lit[Math.min(lit.length - 1, Math.floor(lit.length * f))] ?? 1;
    return { weeks, months, cut: [q(0.25), q(0.5), q(0.75)] };
  }, [activity.days]);
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [weeks.length, folded]);
  const level = (n: number) => (n <= 0 ? 0 : n <= cut[0] ? 1 : n <= cut[1] ? 2 : n <= cut[2] ? 3 : 4);
  return (
    <section className={`px-4 sm:px-6 ${folded ? "py-3" : "py-4"}`}>
      <div className={`flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 ${folded ? "" : "mb-3"}`}>
        <ShelfTitle title="Activity" count={null} folded={folded} onFold={fold} />
        <p className="text-xs text-muted-foreground tabular-nums">
          <span className="text-foreground">{activity.total.toLocaleString()}</span> finished in the last year · <span className="text-foreground">{activity.active}</span> active days · best streak <span className="text-foreground">{activity.best}</span>
        </p>
      </div>
      {!folded && (
      <>
      <div ref={scroller} className="overflow-x-auto pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        <div className="min-w-[720px] space-y-1">
          <div className="relative h-3 text-[10px] text-muted-foreground">
            {months.map((m) => <span key={`${m.at}-${m.label}`} className="absolute" style={{ left: `${(m.at / weeks.length) * 100}%` }}>{m.label}</span>)}
          </div>
          <div className="grid gap-[3px]" style={{ gridTemplateColumns: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
            {weeks.map((week, w) => (
              <div key={w} className="grid gap-[3px]">
                {week.map((day, d) => day
                  ? <span key={day.key} title={`${day.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" })}: ${day.n} finished`} className={`aspect-square w-full rounded-[3px] ${HEAT[level(day.n)]}`} />
                  : <span key={`empty-${d}`} className="aspect-square w-full" />)}
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="mt-2 flex items-center justify-end gap-1 text-[10px] text-muted-foreground">
        Less {HEAT.map((c) => <span key={c} className={`h-[11px] w-[11px] rounded-[2px] ${c}`} />)} More
      </div>
      </>
      )}
    </section>
  );
}

function useFolded(key: string): [boolean, () => void] {
  const [folded, setFolded] = useState(() => {
    try {
      return localStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  const toggle = () => {
    setFolded(!folded);
    try {
      if (folded) localStorage.removeItem(key);
      else localStorage.setItem(key, "1");
    } catch {}
  };
  return [folded, toggle];
}

function ShelfTitle({ title, count, folded, onFold }: { title: string; count: number | null; folded?: boolean; onFold?: () => void }) {
  const label = (
    <>
      {title}{count !== null && <span className="tabular-nums"> ({count})</span>}
    </>
  );
  if (!onFold) return <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>;
  return (
    <button type="button" onClick={onFold} aria-expanded={!folded} className="group/fold flex items-center gap-1.5 text-[11px] uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground">
      <ChevronDown className={`h-3.5 w-3.5 transition-transform duration-200 ${folded ? "-rotate-90" : ""}`} />
      {label}
    </button>
  );
}

function Shelf({ title, count, action, folded = false, onFold, children }: { title: string; count: number | null; action?: React.ReactNode; folded?: boolean; onFold?: () => void; children: React.ReactNode }) {
  return (
    <section className="px-4 py-3 sm:px-6">
      <div className={`flex flex-wrap items-center justify-between gap-2 ${folded ? "" : "mb-2"}`}>
        <ShelfTitle title={title} count={count} folded={folded} onFold={onFold} />
        {!folded && action}
      </div>
      {!folded && children}
    </section>
  );
}

const episodeRef = (ref: JellyfinEpisodeRef | null): string => {
  if (!ref || ref.number === null) return "";
  const e = `E${ref.number}`;
  return ref.season === null ? e : `S${ref.season} ${e}`;
};

type ShowFilter = "all" | "next" | "waiting" | "done" | "problems";

const SHOW_FILTERS: Array<{ key: ShowFilter; label: string; outcomes: string[] }> = [
  { key: "all", label: "All", outcomes: [] },
  { key: "next", label: "Up next", outcomes: ["shown"] },
  { key: "waiting", label: "Waiting", outcomes: ["caught-up", "airs-later"] },
  { key: "done", label: "Finished", outcomes: ["finished", "dropped"] },
  { key: "problems", label: "Not shown", outcomes: ["missing-episode", "no-meta", "no-air-date", "not-anime", "rating-cap"] },
];

function showStatus(row: JellyfinShowRow): { text: string; tone: string; fixable: boolean } {
  const next = episodeRef(row.next);
  switch (row.outcome) {
    case "shown": return { text: `Up next ${next}${row.next?.name ? ` · ${row.next.name}` : ""}`, tone: "text-blue-300", fixable: false };
    case "caught-up": return { text: "Caught up, nothing aired after the last watched", tone: "text-emerald-400", fixable: false };
    case "airs-later": return { text: `${next} airs ${row.airsAt ? new Date(row.airsAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "later"}`, tone: "text-sky-300", fixable: false };
    case "finished": return { text: "Finished", tone: "text-emerald-400", fixable: false };
    case "dropped": return { text: "Dropped", tone: "text-muted-foreground", fixable: false };
    case "missing-episode": return { text: `Last watched ${episodeRef(row.last) || "episode"} is not among its ${row.episodes ?? 0} episodes`, tone: "text-red-400", fixable: true };
    case "no-meta": return { text: "No metadata for this show", tone: "text-red-400", fixable: true };
    case "no-air-date": return { text: `${next} has no air date`, tone: "text-amber-400", fixable: true };
    case "not-anime": return { text: "Left out: this profile's shelf keeps anime only", tone: "text-muted-foreground", fixable: false };
    case "rating-cap": return { text: "Left out: above this profile's age rating", tone: "text-muted-foreground", fixable: false };
    default: return { text: row.outcome, tone: "text-muted-foreground", fixable: false };
  }
}

const SOURCE_LABELS: Record<string, string> = { server: "played here", tracker: "from the tracker", sequel: "sequel" };

function ShowCard({ row, onRefresh, refreshing }: { row: JellyfinShowRow; onRefresh: () => void; refreshing: boolean }) {
  const status = showStatus(row);
  const pct = row.total ? Math.min(100, Math.round(((row.watched ?? 0) / row.total) * 100)) : null;
  return (
    <div className="flex gap-3 rounded-lg bg-muted/30 p-2.5 ring-1 ring-white/[0.06]">
      <div className="w-12 shrink-0"><Art src={row.posterUrl} title={row.title} wide={false} /></div>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-start justify-between gap-2">
          <p className="truncate text-sm font-semibold leading-tight" title={row.title}>{row.title}</p>
          {status.fixable && (
            <Button size="sm" variant="ghost" className="-mr-1 -mt-1 h-6 gap-1 px-1.5 text-[11px]" onClick={onRefresh} disabled={refreshing} title="Read this show's episodes again and rebuild its shelves">
              <RefreshCw className={`h-3 w-3 ${refreshing ? "animate-spin" : ""}`} /> Refresh
            </Button>
          )}
        </div>
        <p className={`truncate text-[11px] leading-tight ${status.tone}`} title={status.text}>{status.text}</p>
        {pct !== null && (
          <div className="flex items-center gap-2">
            <div className="h-1 flex-1 overflow-hidden rounded-full bg-white/10">
              <div className={`h-full rounded-full ${pct >= 100 ? "bg-emerald-500" : "bg-gradient-to-r from-blue-600 to-blue-400"}`} style={{ width: `${Math.max(2, pct)}%` }} />
            </div>
            <span className="text-[10px] tabular-nums text-muted-foreground">{row.watched}/{row.total}</span>
          </div>
        )}
        <p className="truncate text-[10px] text-muted-foreground">{SOURCE_LABELS[row.source] ?? row.source}{row.lastWatchedAt ? ` · ${when(row.lastWatchedAt)}` : ""}</p>
      </div>
    </div>
  );
}

const SHOWS_CAP = 12;

function Shows({ userUUID, profile, profileName, activeTab }: { userUUID: string; profile: string | null; profileName: string; activeTab: DashboardTab }) {
  const [fresh, setFresh] = useState(0);
  const [filter, setFilter] = useState<ShowFilter>("all");
  const [all, setAll] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const refreshShow = useJellyfinShowRefresh();
  const [folded, fold] = useFolded("jellyfin.fold.shows");
  const { data, isLoading, isError, isFetching } = useJellyfinShows(userUUID, profile, fresh, { activeTab, enabled: !folded });
  const rows = data?.rows ?? [];
  const counts = Object.fromEntries(SHOW_FILTERS.map((f) => [f.key, f.outcomes.length ? rows.filter((r) => f.outcomes.includes(r.outcome)).length : rows.length])) as Record<ShowFilter, number>;
  const picked = SHOW_FILTERS.find((f) => f.key === filter)!;
  const shown = picked.outcomes.length ? rows.filter((r) => picked.outcomes.includes(r.outcome)) : rows;
  const visible = all ? shown : shown.slice(0, SHOWS_CAP);

  const refresh = async (row: JellyfinShowRow) => {
    setRefreshing(row.metaId);
    try {
      await refreshShow(userUUID, row.metaId);
      setFresh((n) => n + 1);
      toast.success(`${row.title} read again`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Refresh failed");
    } finally {
      setRefreshing(null);
    }
  };

  return (
    <Shelf
      title={`Shows, ${profileName}'s Next Up`}
      count={data ? rows.length : null}
      folded={folded}
      onFold={fold}
      action={
        <span className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {data && !isFetching && <span className="tabular-nums">built in {(data.ms / 1000).toFixed(1)} s</span>}
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => setFresh((n) => n + 1)} disabled={isFetching}>
            <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`} /> Rebuild
          </Button>
        </span>
      }
    >
      {isLoading && !data ? (
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Building Next Up the way a client would…</p>
      ) : isError || !data ? (
        <p className="text-xs text-red-500">Could not build this profile's Next Up.</p>
      ) : rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">No shows in progress.</p>
      ) : (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {SHOW_FILTERS.map((f) => (
              <button key={f.key} type="button" onClick={() => { setFilter(f.key); setAll(false); }} className={`h-7 rounded-full px-3 text-xs ring-1 transition-colors ${filter === f.key ? "bg-foreground text-background ring-transparent" : "bg-muted/30 ring-white/[0.1] hover:bg-muted/50"}`}>
                {f.label} <span className="tabular-nums opacity-60">{counts[f.key]}</span>
              </button>
            ))}
          </div>
          <div className={`grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-3 transition-opacity ${isFetching ? "opacity-60" : ""}`}>
            {visible.map((row) => <ShowCard key={row.metaId} row={row} onRefresh={() => { void refresh(row); }} refreshing={refreshing === row.metaId} />)}
          </div>
          {shown.length > SHOWS_CAP && (
            <Button size="sm" variant="ghost" className="h-7 gap-1 text-xs" onClick={() => setAll((v) => !v)}>
              {all ? <>Show fewer <ChevronUp className="h-3.5 w-3.5" /></> : <>View all {shown.length} <ChevronDown className="h-3.5 w-3.5" /></>}
            </Button>
          )}
        </div>
      )}
    </Shelf>
  );
}

type View = "cards" | "table";

function useRemembered<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const stored = sessionStorage.getItem(key);
      return stored === null ? initial : (JSON.parse(stored) as T);
    } catch {
      return initial;
    }
  });
  const remember = (next: T) => {
    setValue(next);
    try {
      if (next === initial) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(next));
    } catch {}
  };
  return [value, remember];
}

function ShelfSkeleton() {
  return (
    <section className="space-y-3 px-4 py-4 sm:px-6">
      <Skeleton className="h-3 w-36" />
      <div className="flex gap-3 overflow-hidden">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="aspect-video w-64 shrink-0 rounded-lg sm:w-80" />)}
      </div>
    </section>
  );
}

function ConfigurationSkeleton() {
  return (
    <div className="border-t border-white/[0.06]">
      <div className="space-y-5 px-4 pt-14 pb-6 sm:px-6">
        <div className="flex items-center gap-4">
          <Skeleton className="h-14 w-14 rounded-full" />
          <div className="space-y-2"><Skeleton className="h-6 w-44" /><Skeleton className="h-3 w-56" /></div>
        </div>
        <div className="grid max-w-2xl grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-4">
          {[0, 1, 2, 3].map((i) => <div key={i} className="space-y-2"><Skeleton className="h-8 w-20" /><Skeleton className="h-3 w-16" /></div>)}
        </div>
        <p className="flex items-center gap-2 text-xs text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Loading playback…</p>
      </div>
      <div className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
        <section className="flex gap-2 px-4 py-3 sm:px-6">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-7 w-36 rounded-full" />)}</section>
        <ShelfSkeleton />
      </div>
    </div>
  );
}

function Configuration({ userUUID, activeTab, onClose }: { userUUID: string; activeTab: DashboardTab; onClose: () => void }) {
  const [profile, setProfile] = useRemembered<string | null>(`jellyfin.profile.${userUUID}`, null);
  const [view, setView] = useRemembered<View>("jellyfin.view", "cards");
  const [rows, setRows] = useRemembered<number | null>("jellyfin.rows", null);
  const [exporting, setExporting] = useState(false);
  const [allProgress, setAllProgress] = useRemembered<boolean>("jellyfin.allProgress", false);
  const [foldedProgress, foldProgress] = useFolded("jellyfin.fold.progress");
  const [foldedPlayed, foldPlayed] = useFolded("jellyfin.fold.played");
  const exportJson = useJellyfinExport();
  const { data, isLoading, isError, isFetching, isPlaceholderData } = useJellyfinConfiguration(userUUID, profile, rows, { activeTab });

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

  if (isLoading && !data) return <ConfigurationSkeleton />;
  if (isError || !data) return <p className="text-xs text-red-500 px-4 py-3">Could not load this configuration's playback.</p>;

  const switching = isPlaceholderData && (data.userUUID !== userUUID || data.profile !== profile);
  const shown = profile === null ? data.profiles : data.profiles.filter((p) => p.key === profile);
  const activity = activityOf(shown);
  const profileName = (profile === null ? data.profiles[0]?.name : data.profiles.find((p) => p.key === profile)?.name) ?? data.label;
  const controls = (
    <>
      <div className="glass inline-flex rounded-full p-0.5">
        <Button size="sm" variant={view === "cards" ? "secondary" : "ghost"} className="h-7 rounded-full px-2.5" onClick={() => setView("cards")} aria-label="Cards"><LayoutGrid className="h-3.5 w-3.5" /></Button>
        <Button size="sm" variant={view === "table" ? "secondary" : "ghost"} className="h-7 rounded-full px-2.5" onClick={() => setView("table")} aria-label="Table"><TableProperties className="h-3.5 w-3.5" /></Button>
      </div>
      <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
        {isFetching && !isLoading && !switching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : "Rows"}
        <select
          id="jellyfin-dashboard-rows"
          value={rows ?? data.rows}
          onChange={(event) => setRows(Number(event.target.value))}
          className="glass h-8 rounded-full px-2.5 text-xs text-foreground"
        >
          {[...new Set([data.rows, 50, 100, 200, 500])].sort((a, b) => a - b).map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </label>
      <Button size="sm" variant="ghost" className="glass h-8 gap-1 rounded-full px-3" onClick={runExport} disabled={exporting}>
        {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />} Export JSON
      </Button>
      <Button size="sm" variant="ghost" className="h-7 px-2" onClick={onClose} aria-label="Close"><X className="h-3.5 w-3.5" /></Button>
    </>
  );

  return (
    <div className="border-t border-white/[0.06]">
      <Hero data={data} profile={profile} onProfile={setProfile} activity={activity} controls={controls} switching={switching} />
      {switching ? (
        <div className="divide-y divide-white/[0.06] border-t border-white/[0.06]">
          <section className="flex gap-2 px-4 py-3 sm:px-6">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-7 w-36 rounded-full" />)}</section>
          <ShelfSkeleton />
          <ShelfSkeleton />
        </div>
      ) : (
      <div className={`divide-y divide-white/[0.06] border-t border-white/[0.06] transition-opacity ${isFetching && !isLoading ? "opacity-60" : "opacity-100"}`}>
        <SyncStrip rows={data.sync} />
        <Shelf
          title="Continue watching"
          count={data.inProgress.length}
          folded={foldedProgress}
          onFold={foldProgress}
          action={view === "cards" && data.inProgress.length > 3 && (
            <Button size="sm" variant="ghost" className="h-7 gap-1 px-2 text-xs" onClick={() => setAllProgress(!allProgress)}>
              {allProgress ? "Show as a row" : "View all"}
            </Button>
          )}
        >
          {data.inProgress.length === 0
            ? <p className="text-xs text-muted-foreground">Nothing in progress.</p>
            : view === "table"
              ? <PlayTable rows={data.inProgress} kind="progress" />
              : allProgress
                ? <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">{data.inProgress.map((row) => <ProgressCard key={`${row.profile}|${row.videoId}`} row={row} />)}</div>
                : (
                  <Row>
                    {data.inProgress.map((row) => <div key={`${row.profile}|${row.videoId}`} className="w-64 shrink-0 snap-start sm:w-80"><ProgressCard row={row} /></div>)}
                  </Row>
                )}
        </Shelf>
        <JellyfinLibrary key={`library:${profile ?? ""}`} userUUID={userUUID} profile={profile} profileName={profileName} activeTab={activeTab} />
        <Shows key={`shows:${profile ?? ""}`} userUUID={userUUID} profile={profile} profileName={profileName} activeTab={activeTab} />
        <JellyfinCalendar key={`calendar:${profile ?? ""}`} userUUID={userUUID} profile={profile} profileName={profileName} activeTab={activeTab} />
        <ActivityMap activity={activity} />
        <Shelf title="Recently played" count={data.recentlyPlayed.length} folded={foldedPlayed} onFold={foldPlayed}>
          {data.recentlyPlayed.length === 0
            ? <p className="text-xs text-muted-foreground">Nothing played yet.</p>
            : view === "table"
              ? <PlayTable rows={data.recentlyPlayed} kind="played" />
              : <PlayedByDay rows={data.recentlyPlayed} />}
        </Shelf>
      </div>
      )}
    </div>
  );
}

export default function DashboardJellyfin({ activeTab }: { activeTab: DashboardTab }) {
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useRemembered<string | null>("jellyfin.selected", null);
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
        <Stat label="Playing now" value={o?.playingNow ?? "…"} hint={o ? `${o.pausedNow} paused, ${o.sessions} session${o.sessions === 1 ? "" : "s"} open` : undefined} />
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
            ? <Configuration key={selected} userUUID={selected} activeTab={activeTab} onClose={() => setSelected(null)} />
            : <p className="text-xs text-muted-foreground px-4 py-3">Search for a configuration to see its playback.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
