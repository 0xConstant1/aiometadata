import { ACCOUNT_SERVICES, type AccountService } from './accounts';

const database: any = require('./database');

/** Deletes a token row once no configuration or user refers to it. */
export async function releaseTokenIfUnused(service: AccountService, tokenId: string, revoke?: (refreshToken: string) => void): Promise<boolean> {
  const refs = await database.findTokenReferences(ACCOUNT_SERVICES[service].key, [tokenId]);
  if (refs.length) return false;
  const held = await database.getOAuthToken(tokenId).catch(() => null);
  if (held?.refresh_token && revoke) revoke(held.refresh_token);
  await database.deleteOAuthToken(tokenId);
  return true;
}
