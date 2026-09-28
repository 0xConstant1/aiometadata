import consola from 'consola';
import { ACCOUNT_SERVICES, type AccountService } from './accounts';

const database: any = require('./database');
const logger = consola.withTag('AccountLinks');

/** Deletes a token row once no configuration or user refers to it. */
export async function releaseTokenIfUnused(service: AccountService, tokenId: string, revoke?: (refreshToken: string) => void): Promise<boolean> {
  let refs;
  try {
    refs = await database.findTokenReferences(ACCOUNT_SERVICES[service].key, [tokenId]);
  } catch (error: any) {
    logger.warn(`Kept ${service} token: could not check who still uses it: ${error?.message}`);
    return false;
  }
  if (refs.length) return false;
  const held = await database.getOAuthToken(tokenId).catch(() => null);
  if (held?.refresh_token && revoke) revoke(held.refresh_token);
  await database.deleteOAuthToken(tokenId);
  return true;
}
