import consola from 'consola';
import { envInt } from '../envNumber';

const logger = consola.withTag('Recommendations');
const redis: any = require('../../lib/redisClient');
const { runWithRequestContext }: any = require('../../lib/logBuffer');

let timer: ReturnType<typeof setInterval> | null = null;
let sweeping = false;

function seenKey(userUUID: string): string {
  return `recommendations:seen:${userUUID}`;
}

/** A row that was opened is kept warm; one nobody reads is left to lapse. */
export async function markSeen(userUUID: string): Promise<void> {
  if (!redis) return;
  try {
    await redis.set(seenKey(userUUID), '1', 'EX', envInt('RECOMMENDATION_ACTIVE_DAYS', 7, 1) * 24 * 60 * 60);
  } catch (error: any) {
    logger.debug(`Could not mark ${userUUID} as active: ${error?.message || error}`);
  }
}

function usable(config: any): boolean {
  const hasHistory = !!(config?.apiKeys?.simklTokenId || config?.apiKeys?.mdblist);
  const hasModel = !!(config?.apiKeys?.gemini || config?.apiKeys?.openrouter
    || process.env.GEMINI_API_KEY || process.env.BUILT_IN_GEMINI_API_KEY || process.env.OPENROUTER_API_KEY);
  return hasHistory && hasModel;
}

export async function sweepRecommendations(): Promise<{ checked: number; refreshed: number }> {
  const out = { checked: 0, refreshed: 0 };
  if (!redis || sweeping) return out;
  sweeping = true;
  try {
    const database: any = require('../../lib/database');
    const { withGlobalEpoch }: any = require('../../lib/cacheEpoch');
    const { runWithSourceRefetch }: any = require('../../lib/cacheSourceRefetch');
    const { RECOMMENDATION_CATALOGS, isRecommendationCatalog }: any = require('./catalog');
    const { picksKey, recommend }: any = require('./rank');
    const { getTasteProfile }: any = require('./profile');
    const leadMs = envInt('RECOMMENDATION_REFRESH_LEAD', 3600, 60) * 1000;

    for (const user of await database.getAllUsers()) {
      let config: any;
      try {
        config = JSON.parse(user.config);
      } catch {
        continue;
      }
      const wanted = (config?.catalogs || [])
        .filter((catalog: any) => catalog?.enabled && isRecommendationCatalog(catalog.id))
        .map((catalog: any) => catalog.id);
      if (!wanted.length || !usable(config)) continue;
      if (!(await redis.exists(seenKey(user.id)))) continue;

      let profile: any = null;
      for (const id of wanted) {
        const kind = RECOMMENDATION_CATALOGS.find((entry: any) => entry.id === id)?.kind;
        if (!kind) continue;
        out.checked += 1;
        const ttlMs = await redis.pttl(withGlobalEpoch(picksKey(config, user.id, kind)));
        if (!(ttlMs > 0 && ttlMs <= leadMs)) continue;
        try {
          profile = profile ?? (await runWithRequestContext(user.id, () => getTasteProfile(config, user.id)));
          if (!profile) break;
          const picks = await runWithRequestContext(user.id, () => runWithSourceRefetch(() => recommend(config, user.id, profile, kind)));
          out.refreshed += 1;
          logger.info(`Refreshed ${id} for ${user.id} ${Math.round(ttlMs / 60000)} min before it lapsed: ${picks.length} picks`);
        } catch (error: any) {
          logger.warn(`Could not refresh ${id} for ${user.id}: ${error?.message || error}`);
        }
      }
    }
  } catch (error: any) {
    logger.warn(`Recommendation refresh sweep failed: ${error?.message || error}`);
  } finally {
    sweeping = false;
  }
  return out;
}

export function startRecommendationRefresh(): void {
  if (timer || !redis) return;
  const every = envInt('RECOMMENDATION_REFRESH_SWEEP', 900, 60) * 1000;
  timer = setInterval(() => {
    sweepRecommendations().catch(() => undefined);
  }, every);
  timer.unref?.();
  logger.info(`Recommendation refresh sweep every ${Math.round(every / 60000)} min, ${envInt('RECOMMENDATION_REFRESH_LEAD', 3600, 60) / 60} min before a row lapses`);
}

module.exports = { markSeen, sweepRecommendations, startRecommendationRefresh };
