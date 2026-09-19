const consola = require('consola');
const { httpGet, httpPost } = require('../utils/httpClient.js');

const logger = consola.withTag('Simkl');

export const SIMKL_API_BASE = 'https://api.simkl.com';

export interface SimklTokens {
  access_token: string;
  // Note: Simkl access tokens never expire, no refresh_token
}

export interface SimklPinRequest {
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export type SimklPinPoll =
  | { status: 'authorized'; access_token: string }
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'expired' };

export interface SimklUser {
  username: string;
  name?: string;
  // Add other user fields as needed
}

export class SimklClient {
  private clientId: string;
  private clientSecret: string;
  private redirectUri: string;

  // PIN flow needs only a client id, so these two stay empty there.
  constructor(clientId: string, clientSecret: string = '', redirectUri: string = '') {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.redirectUri = redirectUri;
  }

  /**
   * Start the PIN (device) flow. No client secret, no callback URL.
   */
  async requestPin(): Promise<SimklPinRequest> {
    const params = new URLSearchParams({ client_id: this.clientId });
    let data: any;
    try {
      const response = await httpGet(`${SIMKL_API_BASE}/oauth/pin?${params.toString()}`);
      data = response.data;
    } catch (error: any) {
      const status = error?.response?.status;
      if (status === 401 || status === 403) {
        logger.error(`Simkl rejected the client credentials (HTTP ${status})`);
        throw new Error('Simkl rejected this instance\'s client id');
      }
      throw error;
    }

    if (!data || data.result !== 'OK' || !data.user_code) {
      logger.error('Unexpected Simkl PIN response:', JSON.stringify(data));
      throw new Error('Simkl did not return a PIN');
    }

    return {
      user_code: String(data.user_code),
      verification_url: String(data.verification_url || data.verification_uri || 'https://simkl.com/pin'),
      expires_in: Number(data.expires_in) || 900,
      interval: Number(data.interval) || 5,
    };
  }

  /**
   * Poll a pending PIN. Simkl returns result "OK" with an access token once the
   * user has entered the code, and "KO" with either "Authorization pending" or
   * "Slow down" while it is still waiting.
   */
  async pollPin(userCode: string): Promise<SimklPinPoll> {
    const params = new URLSearchParams({ client_id: this.clientId });

    let data: any;
    try {
      const response = await httpGet(
        `${SIMKL_API_BASE}/oauth/pin/${encodeURIComponent(userCode)}?${params.toString()}`
      );
      data = response.data;
    } catch (error: any) {
      const status = error?.response?.status;

      // A rejected client id is a configuration problem, not a user who hasn't
      // typed the code yet. Let it surface instead of polling forever.
      if (status === 401 || status === 403) {
        logger.error(`Simkl rejected the client credentials (HTTP ${status})`);
        throw error;
      }

      if (status === 429) {
        return { status: 'slow_down' };
      }

      // Anything else is treated as transient, the next tick retries.
      logger.debug(`Simkl PIN poll failed, treating as pending: ${error?.message}`);
      return { status: 'pending' };
    }

    if (data && data.result === 'OK' && data.access_token) {
      return { status: 'authorized', access_token: String(data.access_token) };
    }

    // Simkl answers an unknown code by minting a fresh one and returning the
    // step-1 body, which carries `device_code` and no `access_token`. Its
    // documentation names that field as the signal that the code we polled is
    // gone. Reading it as pending would keep polling, and every one of those
    // polls mints another code, so this has to come before anything else.
    if (data && data.device_code) {
      return { status: 'expired' };
    }

    const message = typeof data?.message === 'string' ? data.message.toLowerCase() : '';
    if (message.includes('slow down')) {
      return { status: 'slow_down' };
    }

    return { status: 'pending' };
  }

  /**
   * Get authorization URL for OAuth flow
   */
  getAuthorizationUrl(state?: string): string {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
    });

    if (state) {
      params.append('state', state);
    }

    return `https://simkl.com/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchange authorization code for access token
   * Note: Simkl tokens never expire
   */
  async exchangeCodeForToken(code: string): Promise<SimklTokens> {
    try {
      const response = await httpPost('https://api.simkl.com/oauth/token', {
        code,
        client_id: this.clientId,
        client_secret: this.clientSecret,
        redirect_uri: this.redirectUri,
        grant_type: 'authorization_code',
      });

      const data = response.data;

      logger.debug('Simkl token exchange response:', JSON.stringify(
        data,
        (key, value) =>
          (key === 'access_token' || key === 'refresh_token') && typeof value === 'string'
            ? '[REDACTED]'
            : value,
        2
      ));

      return {
        access_token: data.access_token,
      };
    } catch (error) {
      logger.error('Failed to exchange code for token:', error);
      throw error;
    }
  }

  /**
   * Get current user information
   */
  async getMe(accessToken: string): Promise<SimklUser> {
    try {
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'simkl-api-key': this.clientId,
      };

      // Simkl API endpoint for user settings/info
      // Try /users/settings endpoint first
      let response;
      let data;
      
      try {
        response = await httpGet(`${SIMKL_API_BASE}/users/settings`, { headers });
        data = response.data;
        logger.debug('Simkl /users/settings response:', JSON.stringify(data, null, 2));
      } catch (settingsError: any) {
        // If /users/settings fails, try /user (singular) as fallback
        logger.debug('Simkl /users/settings failed, trying /user:', settingsError.message);
        response = await httpGet(`${SIMKL_API_BASE}/user`, { headers });
        data = response.data;
        logger.debug('Simkl /user response:', JSON.stringify(data, null, 2));
      }

      if (!data) {
        logger.error('Simkl API returned null/undefined data');
        throw new Error('Simkl API returned no data');
      }

      const accountId = data?.account?.id;
      const userName = data?.user?.name || data?.name || '';
      
      const username = accountId ? String(accountId) : userName;
      const name = data?.user?.name || data?.name || data?.account?.name;

      if (!username) {
        logger.warn('No user identifier found in Simkl API response. Full response:', JSON.stringify(data, null, 2));
        throw new Error('Unable to retrieve user identifier from Simkl API');
      }

      return {
        username,
        name,
      };
    } catch (error) {
      logger.error('Failed to get user info:', error);
      throw error;
    }
  }

  /**
   * Revoke access token
   * Note: Simkl may not have a revoke endpoint, this is a placeholder
   */
  async revokeToken(accessToken: string): Promise<void> {
    try {
      // Simkl tokens can be revoked by user in Connected Apps settings
      // If there's a revoke endpoint, add it here
      logger.info('Token revoke requested - user should revoke in Simkl Connected Apps settings');
    } catch (error) {
      logger.error('Failed to revoke token:', error);
      throw error;
    }
  }

  /**
   * Get user's watchlist or lists
   * Add more methods as needed based on Simkl API documentation
   */
  async getUserLists(accessToken: string): Promise<any[]> {
    try {
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`,
        'simkl-api-key': this.clientId,
      };

      // Adjust endpoint based on actual Simkl API
      const response = await httpGet(`${SIMKL_API_BASE}/sync/all-items`, { headers });
      return Array.isArray(response.data) ? response.data : [];
    } catch (error) {
      logger.error('Failed to get user lists:', error);
      throw error;
    }
  }
}
// A V2 token only works with the client id it was issued to.
export const SIMKL_V2_TOKEN_PREFIX = 'simkl_at_';
export const SIMKL_V2_ISSUER = 'https://simkl.com';
const SIMKL_V2_SCOPE = 'media:read media:write';

export interface SimklV2Tokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
}

export interface SimklDeviceCode {
  device_code: string;
  user_code: string;
  verification_url: string;
  expires_in: number;
  interval: number;
}

export type SimklDevicePoll =
  | { status: 'authorized'; tokens: SimklV2Tokens }
  | { status: 'pending' }
  | { status: 'slow_down' }
  | { status: 'expired' };

export function isSimklV2Token(accessToken: unknown): boolean {
  return typeof accessToken === 'string' && accessToken.startsWith(SIMKL_V2_TOKEN_PREFIX);
}

export function simklV2Credentials(): { clientId: string; clientSecret: string } {
  const { getSetting } = require('./settingsService');
  return {
    clientId: String(getSetting('SIMKL_V2_CLIENT_ID') || '').trim(),
    clientSecret: String(getSetting('SIMKL_V2_CLIENT_SECRET') || '').trim(),
  };
}

export function simklClientIdFor(accessToken?: string | null): string {
  if (isSimklV2Token(accessToken)) return simklV2Credentials().clientId;
  return String(process.env.SIMKL_CLIENT_ID || '').trim() || simklV2Credentials().clientId;
}

async function postForm(path: string, form: Record<string, string>, clientSecret = ''): Promise<{ status: number; data: any }> {
  const body = new URLSearchParams(form);
  if (clientSecret) body.set('client_secret', clientSecret);
  const buildInfo = require('./buildInfo');
  const response = await fetch(`${SIMKL_API_BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json',
      'User-Agent': `AIOMetadata/${buildInfo?.version || '1.0'}`,
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
  const text = await response.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: 'invalid_response', error_description: text.slice(0, 200) };
  }
  return { status: response.status, data };
}

function readTokens(data: any): SimklV2Tokens {
  if (!data?.access_token || !data?.refresh_token) {
    throw new Error(`Simkl returned no token (${data?.error || 'empty response'})`);
  }
  return {
    access_token: String(data.access_token),
    refresh_token: String(data.refresh_token),
    expires_in: Number(data.expires_in) || 604800,
    scope: String(data.scope || ''),
  };
}

function oauthError(action: string, status: number, data: any): Error {
  const error: any = new Error(`Simkl ${action} failed (HTTP ${status}${data?.error ? `, ${data.error}` : ''})`);
  error.status = status;
  error.code = data?.error;
  return error;
}

export async function requestSimklDeviceCode(clientId: string): Promise<SimklDeviceCode> {
  const { status, data } = await postForm('/oauth2/device', { client_id: clientId, scope: SIMKL_V2_SCOPE });
  if (status < 200 || status >= 300 || !data?.device_code || !data?.user_code) {
    logger.error(`Simkl device code request failed (HTTP ${status}): ${data?.error || 'no code'}`);
    throw oauthError('device code request', status, data);
  }
  return {
    device_code: String(data.device_code),
    user_code: String(data.user_code),
    verification_url: String(data.verification_uri_complete || data.verification_uri || 'https://simkl.com/pin'),
    expires_in: Number(data.expires_in) || 900,
    interval: Number(data.interval) || 5,
  };
}

export async function pollSimklDeviceCode(clientId: string, deviceCode: string): Promise<SimklDevicePoll> {
  let result: { status: number; data: any };
  try {
    result = await postForm('/oauth2/token', {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: clientId,
      device_code: deviceCode,
    });
  } catch (error: any) {
    logger.debug(`Simkl device poll failed, treating as pending: ${error?.message}`);
    return { status: 'pending' };
  }
  const { status, data } = result;
  if (status >= 200 && status < 300) return { status: 'authorized', tokens: readTokens(data) };
  if (status === 401) throw oauthError('device poll', status, data);
  if (data?.error === 'slow_down' || status === 429) return { status: 'slow_down' };
  if (data?.error === 'expired_token') return { status: 'expired' };
  return { status: 'pending' };
}

export function simklV2AuthorizationUrl(clientId: string, redirectUri: string, state: string, codeVerifier: string): string {
  const crypto = require('crypto');
  const challenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: SIMKL_V2_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });
  return `${SIMKL_V2_ISSUER}/oauth2/authorize?${params.toString()}`;
}

export async function exchangeSimklV2Code(clientId: string, clientSecret: string, code: string, redirectUri: string, codeVerifier: string): Promise<SimklV2Tokens> {
  const { status, data } = await postForm('/oauth2/token', {
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
    code_verifier: codeVerifier,
  }, clientSecret);
  if (status < 200 || status >= 300) throw oauthError('code exchange', status, data);
  return readTokens(data);
}

export async function refreshSimklV2Token(clientId: string, clientSecret: string, refreshToken: string): Promise<SimklV2Tokens> {
  const { status, data } = await postForm('/oauth2/token', {
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken,
  }, clientSecret);
  if (status < 200 || status >= 300) throw oauthError('token refresh', status, data);
  return readTokens(data);
}

// Simkl answers 200 whether or not anything was revoked.
export async function revokeSimklV2Token(clientId: string, clientSecret: string, token: string): Promise<void> {
  await postForm('/oauth2/revoke', { client_id: clientId, token }, clientSecret);
}

export function simklV2ScopeWrites(scope: string): boolean {
  return String(scope || '').split(/\s+/).includes('media:write');
}
