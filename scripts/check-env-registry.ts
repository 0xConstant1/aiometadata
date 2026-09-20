import fs from 'fs';
import path from 'path';
import { SETTINGS_REGISTRY } from '../addon/lib/settingsRegistry';

const ADDON_DIR = path.resolve(__dirname, '../addon');

// Internal or runtime-injected vars, exempt from the drift check.
const INTERNAL_ALLOWLIST = new Set<string>([
  'NODE_ENV',
  'NODE_OPTIONS',
  'TZ',
  'PWD',
  'HOME',
  'CACHE_WARMUP_UUID',
  'POSTER_CACHE_LOG_PIPE',
]);

/** Known debt: warned about, never grown. A setting not listed here fails the check. */
const DASHBOARD_BYPASS_BASELINE = new Set<string>([
  'ADDON_LOGO_URL',
  'ADDON_NAME_SUFFIX',
  'ANILIST_CATALOG_TTL',
  'API_KEY_TEST_TIMEOUT_MS',
  'BUILT_IN_FANART_API_KEY',
  'BUILT_IN_RPDB_API_KEY',
  'CACHE_CLEANUP_AUTO_ENABLED',
  'CACHE_COMPRESSION_ENABLED',
  'CACHE_COMPRESSION_MIN_BYTES',
  'CACHE_CORRUPTED_THRESHOLD',
  'CACHE_HEALTH_CHECK_INTERVAL',
  'CACHE_MAX_RETRIES',
  'CACHE_RETRY_DELAY',
  'CACHE_WARMUP_MODE',
  'CACHE_WARMUP_UUIDS',
  'CACHE_WARM_LANGUAGE',
  'CATALOG_LIST_ITEMS_SIZE',
  'CATALOG_WARMUP_AUTO_ON_EPOCH_CHANGE',
  'CATALOG_WARMUP_INTERVAL_HOURS',
  'CATALOG_WARMUP_LOG_LEVEL',
  'CATALOG_WARMUP_QUIET_HOURS',
  'CATALOG_WARMUP_QUIET_HOURS_ENABLED',
  'CATALOG_WARMUP_RESUME_ON_RESTART',
  'COLD_STORE_INACTIVE_DAYS',
  'COLD_STORE_STATS_TTL',
  'COLD_TTL_FROZEN',
  'COLD_TTL_STABLE',
  'CONFIG_CACHE_COMPRESSION_ENABLED',
  'CONFIG_CACHE_TTL_SEC',
  'DASHBOARD_METADATA_LANGUAGE',
  'DISABLE_GUEST_MODE',
  'DISABLE_METRICS',
  'ENABLE_UI_RESTART',
  'FANART_API_PROJECT_KEY',
  'FLIXPATROL_CATALOG_URL',
  'FLIXPATROL_TTL',
  'FROZEN_AGE',
  'GEMINI_HTTPS_PROXY',
  'GEMINI_HTTP_PROXY',
  'JELLYFIN_STREAM_USER_AGENT',
  'JIKAN_API_BASE',
  'KEYS_TO_KEEP_AFTER_PRUNE',
  'LOG_QUERY_MAX_ENTRIES',
  'LOG_VIEWER_MAX_ENTRIES',
  'MAL_PAGE_SIZE',
  'MAL_WARMUP_DECADES',
  'MAL_WARMUP_ENABLED',
  'MAL_WARMUP_INTERVAL_HOURS',
  'MAL_WARMUP_LOG_LEVEL',
  'MAL_WARMUP_PRIORITY',
  'MAL_WARMUP_QUIET_HOURS_ENABLED',
  'MAL_WARMUP_QUIET_HOURS_RANGE',
  'MAL_WARMUP_SCHEDULE',
  'MAL_WARMUP_SFW',
  'MAX_TRACKED_KEYS',
  'MDBLIST_RATINGS_MAX_PAGES',
  'MDBLIST_RATINGS_PAGE_SIZE',
  'METAHUB_IMAGE_ERROR_TTL_SECONDS',
  'METAHUB_IMAGE_EXISTS_TTL_SECONDS',
  'METAHUB_IMAGE_HEAD_TIMEOUT_MS',
  'META_COLD_STORE_COMPRESSION',
  'META_COLD_STORE_MAX_BYTES',
  'META_TTL',
  'MOVIELENS_API_BASE',
  'MOVIELENS_CATALOG_TTL_SECONDS',
  'MOVIELENS_IMPORT_REFERER',
  'MOVIELENS_LIST_MAX_PAGES',
  'MOVIELENS_LOGIN_REFERER',
  'MOVIELENS_MANUAL_SYNC_COOLDOWN_SECONDS',
  'MOVIELENS_REQUEST_TIMEOUT_MS',
  'MOVIELENS_USERMETA_TTL_SECONDS',
  'MOVIELENS_USER_AGENT',
  'OPENROUTER_HTTPS_PROXY',
  'OPENROUTER_HTTP_PROXY',
  'PREFER_SMALLER_BACKDROPS_TMDB',
  'PREFER_SMALLER_LANDSCAPE_TMDB',
  'PREFER_SMALLER_LOGOS_TMDB',
  'PREFER_SMALLER_POSTERS_TMDB',
  'PUBLICMETADB_LISTS_TTL',
  'SETTLE_MOVIE',
  'SETTLE_SERIES',
  'SIMKL_ACTIVITIES_TTL',
  'SIMKL_TRENDING_PAGE_SIZE_OPTIONS',
  'TEST_API_KEY_MAX_LENGTH',
  'TEST_KEYS_RATE_LIMIT_PER_MIN',
  'TMDB_KEYWORD_EXPORT_LOOKBACK_DAYS',
  'TMDB_KEYWORD_EXPORT_TTL',
  'TMDB_NETWORK_EXPORT_LOOKBACK_DAYS',
  'TMDB_NETWORK_EXPORT_TTL',
  'TMDB_POPULAR_WARMING_ENABLED',
  'TRAKT_FILTER_MAX_WAIT_MS',
  'TVDB_LIST_ENRICH_CONCURRENCY',
]);

const ENV_RE = /process\.env\.([A-Z_][A-Z0-9_]*)|process\.env\[\s*['"]([A-Z_][A-Z0-9_]*)['"]\s*\]/g;
const GET_SETTING_RE = /getSetting\(\s*['"]([A-Z_][A-Z0-9_]*)['"]/g;

// Top-level const/let/var whose initializer reads process.env, inline or via an IIFE: frozen until restart.
const MODULE_INLINE_RE = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=(?![^\n;]*=>)(?![^\n;]*\bfunction\b)[^\n;]*?process\.env\.([A-Z_][A-Z0-9_]*)/gm;
const MODULE_IIFE_RE = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*=\s*\(\s*(?:async\s+)?\(\)\s*=>\s*\{([\s\S]*?)\}\s*\)\s*\(\s*\)/gm;

function walk(dir: string, out: string[]): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'data') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|js)$/.test(entry.name)) out.push(full);
  }
}

const known = new Set<string>(INTERNAL_ALLOWLIST);
for (const def of SETTINGS_REGISTRY) {
  known.add(def.key);
  known.add(def.envVar);
  if (def.legacyEnvVar) known.add(def.legacyEnvVar);
}

const files: string[] = [];
walk(ADDON_DIR, files);

const used = new Map<string, string>();
const settingKeysUsed = new Set<string>();
const moduleLoad = new Map<string, string>();

function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) if (content[i] === '\n') line++;
  return line;
}

for (const file of files) {
  const content = fs.readFileSync(file, 'utf8');
  const rel = path.relative(process.cwd(), file);

  content.split('\n').forEach((line, i) => {
    let m: RegExpExecArray | null;
    ENV_RE.lastIndex = 0;
    while ((m = ENV_RE.exec(line)) !== null) {
      const name = m[1] || m[2];
      if (!used.has(name)) used.set(name, `${rel}:${i + 1}`);
    }
    GET_SETTING_RE.lastIndex = 0;
    while ((m = GET_SETTING_RE.exec(line)) !== null) settingKeysUsed.add(m[1]);
  });

  let mm: RegExpExecArray | null;
  MODULE_INLINE_RE.lastIndex = 0;
  while ((mm = MODULE_INLINE_RE.exec(content)) !== null) {
    if (!moduleLoad.has(mm[1])) moduleLoad.set(mm[1], `${rel}:${lineAt(content, mm.index)}`);
  }
  MODULE_IIFE_RE.lastIndex = 0;
  while ((mm = MODULE_IIFE_RE.exec(content)) !== null) {
    const body = mm[1];
    let inner: RegExpExecArray | null;
    const innerRe = /process\.env\.([A-Z_][A-Z0-9_]*)/g;
    while ((inner = innerRe.exec(body)) !== null) {
      if (!moduleLoad.has(inner[1])) moduleLoad.set(inner[1], `${rel}:${lineAt(content, mm.index)}`);
    }
  }
}

const defByEnvVar = new Map<string, typeof SETTINGS_REGISTRY[number]>();
for (const def of SETTINGS_REGISTRY) {
  defByEnvVar.set(def.envVar, def);
  if (def.legacyEnvVar) defByEnvVar.set(def.legacyEnvVar, def);
}

const restartViolations: string[] = [];
for (const [envVar, loc] of moduleLoad) {
  const def = defByEnvVar.get(envVar);
  if (def && !def.requiresRestart && !def.envOnly) {
    restartViolations.push(`   ${envVar}\t(read at module load ${loc}) — registry entry '${def.key}' is missing requiresRestart`);
  }
}

// Registered for the dashboard but only ever read from process.env: the toggle does nothing.
const bypassed: string[] = [];
for (const def of SETTINGS_REGISTRY) {
  if (def.envOnly || def.requiresRestart) continue;
  const loc = used.get(def.envVar);
  if (!loc || settingKeysUsed.has(def.key) || moduleLoad.has(def.envVar)) continue;
  bypassed.push(def.envVar);
}
const newlyBypassed = bypassed.filter((v) => !DASHBOARD_BYPASS_BASELINE.has(v)).sort();
const fixedSinceBaseline = [...DASHBOARD_BYPASS_BASELINE].filter((v) => !bypassed.includes(v)).sort();

const missing = [...used.keys()].filter((v) => !known.has(v)).sort();

const unused = [...SETTINGS_REGISTRY]
  .filter((def) => !used.has(def.envVar) && !(def.legacyEnvVar && used.has(def.legacyEnvVar)) && !settingKeysUsed.has(def.key))
  .map((def) => def.envVar)
  .sort();

if (unused.length) {
  console.log(`\n⚠  ${unused.length} registered env var(s) not referenced in addon/ (harmless, possibly renamed/removed):`);
  for (const v of unused) console.log(`   - ${v}`);
}

let failed = false;

if (missing.length) {
  failed = true;
  console.error(`\n❌ ${missing.length} env var(s) used in code but missing from settingsRegistry.ts:\n`);
  for (const v of missing) console.error(`   ${v}\t(first seen ${used.get(v)})`);
  console.error(`\nAdd each to SETTINGS_REGISTRY (with type/default/description) so it appears in the dashboard,`);
  console.error(`or add it to INTERNAL_ALLOWLIST in scripts/check-env-registry.ts if it is internal plumbing.`);
}

if (bypassed.length) {
  console.log(`\n⚠  ${bypassed.length} dashboard setting(s) are only read from process.env, so edits in the UI do nothing.`);
  console.log(`   Tracked in DASHBOARD_BYPASS_BASELINE; convert them to getSetting() to shrink the list.`);
}

if (fixedSinceBaseline.length) {
  console.log(`\n✅ ${fixedSinceBaseline.length} setting(s) fixed since the baseline was taken. Remove them from`);
  console.log(`   DASHBOARD_BYPASS_BASELINE in scripts/check-env-registry.ts:`);
  for (const v of fixedSinceBaseline) console.log(`   - ${v}`);
}

if (newlyBypassed.length) {
  failed = true;
  console.error(`\n❌ ${newlyBypassed.length} new setting(s) registered for the dashboard but read only from process.env:\n`);
  for (const v of newlyBypassed) console.error(`   ${v}\t(${used.get(v)})`);
  console.error(`\nRead it with getSetting('KEY') so a dashboard value is used, or mark the registry`);
  console.error(`entry envOnly: true so the dashboard stops offering a control that does nothing.`);
}

if (restartViolations.length) {
  failed = true;
  console.error(`\n❌ ${restartViolations.length} setting(s) read at module load but not marked requiresRestart:\n`);
  for (const v of restartViolations) console.error(v);
  console.error(`\nEither add 'requiresRestart: true' to the registry entry, or change the code to read`);
  console.error(`process.env lazily (inside a function/getter) so live dashboard edits take effect.`);
}

if (failed) {
  console.error('');
  process.exit(1);
}

console.log(`\n✅ env registry in sync: all ${used.size} referenced env vars are registered or allowlisted.`);
