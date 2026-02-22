/**
 * OpenAI Codex OAuth broker.
 *
 * Security goals:
 * - PKCE + state validation for all authorization code exchanges.
 * - Loopback callback URL (localhost); container bind host adapts for Docker.
 * - Strict binding of pending login attempts to the initiating user/chat.
 * - Refresh-token rotation support with encrypted at-rest persistence.
 * - No credential logging.
 */

import * as crypto from 'node:crypto';
import * as http from 'node:http';
import * as fs from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { OAuthStore, OAuthTokenData } from './oauth.js';
import type { OpenAICodexOAuthConfig } from '../config.js';

const DEFAULT_ISSUER = 'https://auth.openai.com';
const DEFAULT_SCOPE = 'openid profile email offline_access';
const DEFAULT_CALLBACK_PORT = 1455;
const DEFAULT_TIMEOUT_SECONDS = 600;
const TOKEN_EXPIRY_FALLBACK_MS = 50 * 60 * 1000;
const TOKEN_REFRESH_BUFFER_MS = 90 * 1000;

export const CODEX_OAUTH_BASE_URL = 'https://chatgpt.com/backend-api/codex';
export const CODEX_ACCOUNT_HEADER = 'ChatGPT-Account-ID';

interface PendingLogin {
  state: string;
  userId: string;
  chatId: string;
  codeVerifier: string;
  redirectUri: string;
  expiresAt: number;
  inProgress: boolean;
  timeout: NodeJS.Timeout;
}

interface TokenResponse {
  access_token: string;
  token_type?: string;
  refresh_token?: string;
  scope?: string;
  expires_in?: number;
  id_token?: string;
}

export interface CodexAccessCredentials {
  accessToken: string;
  accountId: string;
}

export interface CodexConnectStartResult {
  authUrl: string;
  redirectUri: string;
  expiresInSeconds: number;
}

export class OpenAICodexOAuthService {
  private oauthStore: OAuthStore;
  private config: OpenAICodexOAuthConfig;
  private pendingByState: Map<string, PendingLogin> = new Map();
  private stateByUser: Map<string, string> = new Map();
  private refreshPromise: Promise<OAuthTokenData> | null = null;
  private callbackServer: http.Server | null = null;
  private callbackPort: number | null = null;
  private callbackPublicHost: string = process.env['OAUTH_CALLBACK_HOST'] || 'localhost';
  private callbackBindHost: string =
    process.env['OAUTH_CALLBACK_BIND_HOST'] ||
    (isRunningInContainer() ? '0.0.0.0' : '127.0.0.1');
  private onAsyncStatus?: (chatId: string, message: string) => void;

  constructor(
    oauthStore: OAuthStore,
    config: OpenAICodexOAuthConfig,
    onAsyncStatus?: (chatId: string, message: string) => void,
  ) {
    this.oauthStore = oauthStore;
    this.config = config;
    this.onAsyncStatus = onAsyncStatus;
  }

  isConnected(): boolean {
    return this.oauthStore.hasToken('openai_codex');
  }

  async startLogin(userId: string, chatId: string): Promise<CodexConnectStartResult> {
    this.pruneExpiredLogins();
    await this.ensureCallbackServer();

    const existingState = this.stateByUser.get(userId);
    if (existingState) {
      this.clearPendingState(existingState);
    }

    const state = randomUrlSafe(24);
    const codeVerifier = randomUrlSafe(64);
    const codeChallenge = toCodeChallenge(codeVerifier);
    const redirectUri = `http://${this.callbackPublicHost}:${this.callbackPort}/auth/callback`;
    const timeoutSeconds = this.config.loginTimeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    const expiresAt = Date.now() + timeoutSeconds * 1000;

    const timeout = setTimeout(() => {
      const pending = this.pendingByState.get(state);
      if (!pending) return;
      this.clearPendingState(state);
      this.onAsyncStatus?.(
        chatId,
        '⏰ Codex OAuth login expired. Run /connect codex to start a new login.',
      );
    }, timeoutSeconds * 1000);
    timeout.unref();

    this.pendingByState.set(state, {
      state,
      userId,
      chatId,
      codeVerifier,
      redirectUri,
      expiresAt,
      inProgress: false,
      timeout,
    });
    this.stateByUser.set(userId, state);

    const authUrl = this.buildAuthorizeUrl(redirectUri, state, codeChallenge);
    return {
      authUrl,
      redirectUri,
      expiresInSeconds: timeoutSeconds,
    };
  }

  async completeFromCallbackInput(userId: string, input: string): Promise<void> {
    this.pruneExpiredLogins();
    const trimmed = input.trim();
    const parsed = parseCallbackInput(trimmed);

    if (parsed) {
      await this.completeWithCode(userId, parsed.state, parsed.code);
      return;
    }

    // Raw-code fallback for users on remote/VPS setups: only permitted when
    // there is exactly one active pending login for this user.
    const state = this.stateByUser.get(userId);
    if (!state) {
      throw new Error('No pending Codex OAuth login. Run /connect codex first.');
    }
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      throw new Error(
        'Callback URL is missing OAuth code/state. ' +
          'Paste the final localhost callback URL (or just the code), not the initial auth.openai.com URL.',
      );
    }
    await this.completeWithCode(userId, state, trimmed);
  }

  async getValidAccessCredentials(): Promise<CodexAccessCredentials> {
    let tokenData = this.oauthStore.getToken('openai_codex');
    if (!tokenData) {
      throw new Error(
        'Codex OAuth is not connected. Run /connect codex to authenticate.',
      );
    }

    tokenData = this.normalizeToken(tokenData);
    if (!tokenData.accountId) {
      throw new Error('Stored Codex OAuth token is missing account ID. Reconnect with /connect codex.');
    }

    if (this.needsRefresh(tokenData)) {
      tokenData = await this.refreshTokenSerialized(tokenData);
      if (!tokenData.accountId) {
        throw new Error('Refreshed Codex token is missing account ID. Reconnect with /connect codex.');
      }
    }

    return {
      accessToken: tokenData.accessToken,
      accountId: tokenData.accountId,
    };
  }

  disconnect(): boolean {
    return this.oauthStore.deleteToken('openai_codex');
  }

  async stop(): Promise<void> {
    for (const state of [...this.pendingByState.keys()]) {
      this.clearPendingState(state);
    }
    await this.stopCallbackServer();
  }

  private async ensureCallbackServer(): Promise<void> {
    if (this.callbackServer && this.callbackPort) return;

    const requestedPort = this.config.callbackPort ?? DEFAULT_CALLBACK_PORT;
    const server = http.createServer((req, res) => {
      void this.handleCallbackRequest(req, res);
    });

    const bindToPort = (port: number): Promise<number> =>
      new Promise((resolve, reject) => {
        const onError = (err: Error) => {
          server.off('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.off('error', onError);
          const address = server.address();
          if (!address || typeof address === 'string') {
            reject(new Error('Failed to resolve callback server address.'));
            return;
          }
          resolve((address as AddressInfo).port);
        };

        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, this.callbackBindHost);
      });

    try {
      this.callbackPort = await bindToPort(requestedPort);
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== 'EADDRINUSE') {
        throw new Error('Failed to start OAuth callback server.');
      }
      // Fallback to ephemeral port for usability without compromising loopback-only binding.
      this.callbackPort = await bindToPort(0);
    }

    this.callbackServer = server;
    this.callbackServer.unref();
  }

  private async stopCallbackServer(): Promise<void> {
    if (!this.callbackServer) return;

    const server = this.callbackServer;
    this.callbackServer = null;
    this.callbackPort = null;

    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handleCallbackRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      const base = `http://${this.callbackPublicHost}:${this.callbackPort ?? DEFAULT_CALLBACK_PORT}`;
      const url = new URL(req.url ?? '/', base);

      if (url.pathname !== '/auth/callback') {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }

      const code = url.searchParams.get('code');
      const state = url.searchParams.get('state');
      const errorCode = url.searchParams.get('error');

      if (errorCode) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('OAuth authorization was denied. Return to SecureClaw and retry /connect codex.');
        if (state) {
          const pending = this.pendingByState.get(state);
          if (pending) {
            this.onAsyncStatus?.(
              pending.chatId,
              `⚠️ Codex OAuth authorization failed: ${errorCode}. Run /connect codex again.`,
            );
            this.clearPendingState(state);
          }
        }
        return;
      }

      if (!code || !state) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('Missing OAuth callback parameters.');
        return;
      }

      const pending = this.pendingByState.get(state);
      if (!pending || Date.now() > pending.expiresAt) {
        if (pending) this.clearPendingState(state);
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('OAuth state is invalid or expired. Start again with /connect codex.');
        return;
      }

      await this.completeWithCode(pending.userId, state, code);
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('SecureClaw Codex OAuth login complete. You can close this tab.');
      this.onAsyncStatus?.(
        pending.chatId,
        '✅ Codex OAuth login completed. SecureClaw is now authenticated.',
      );
    } catch {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('OAuth callback processing failed. Retry with /connect codex.');
    } finally {
      this.pruneExpiredLogins();
    }
  }

  private async completeWithCode(
    userId: string,
    state: string,
    code: string,
  ): Promise<void> {
    const pending = this.pendingByState.get(state);
    if (!pending) {
      throw new Error('OAuth state not found. Run /connect codex again.');
    }
    if (pending.userId !== userId) {
      throw new Error('OAuth state does not belong to this user.');
    }
    if (Date.now() > pending.expiresAt) {
      this.clearPendingState(state);
      throw new Error('OAuth login expired. Run /connect codex again.');
    }
    if (pending.inProgress) {
      throw new Error('OAuth callback already being processed.');
    }

    pending.inProgress = true;
    try {
      const tokenData = await this.exchangeAuthorizationCode(
        code,
        pending.codeVerifier,
        pending.redirectUri,
      );
      this.oauthStore.storeToken('openai_codex', tokenData);
      this.clearPendingState(state);
    } catch (err) {
      pending.inProgress = false;
      throw err;
    }
  }

  private async exchangeAuthorizationCode(
    code: string,
    codeVerifier: string,
    redirectUri: string,
  ): Promise<OAuthTokenData> {
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.config.clientId,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    });

    const response = await fetch(this.getTokenEndpoint(), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body,
    });

    if (!response.ok) {
      throw new Error(`Codex OAuth token exchange failed (${response.status}).`);
    }

    const payload = (await response.json()) as Partial<TokenResponse>;
    return this.toTokenData(payload);
  }

  private async refreshTokenSerialized(
    tokenData: OAuthTokenData,
  ): Promise<OAuthTokenData> {
    if (!this.refreshPromise) {
      this.refreshPromise = this.refreshToken(tokenData).finally(() => {
        this.refreshPromise = null;
      });
    }
    return this.refreshPromise;
  }

  private async refreshToken(tokenData: OAuthTokenData): Promise<OAuthTokenData> {
    const response = await fetch(this.getTokenEndpoint(), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: tokenData.refreshToken,
        client_id: this.config.clientId,
        scope: 'openid profile email',
      }),
    });

    if (!response.ok) {
      if (response.status === 400 || response.status === 401) {
        this.oauthStore.deleteToken('openai_codex');
      }
      throw new Error(
        `Codex OAuth token refresh failed (${response.status}). Reconnect with /connect codex.`,
      );
    }

    const payload = (await response.json()) as Partial<TokenResponse>;
    const refreshed = this.toTokenData(payload, tokenData);
    this.oauthStore.storeToken('openai_codex', refreshed);
    return refreshed;
  }

  private toTokenData(
    payload: Partial<TokenResponse>,
    fallback?: OAuthTokenData,
  ): OAuthTokenData {
    if (!payload.access_token) {
      throw new Error('Codex OAuth token response missing access_token.');
    }

    const refreshToken = payload.refresh_token ?? fallback?.refreshToken;
    if (!refreshToken) {
      throw new Error('Codex OAuth token response missing refresh_token.');
    }

    const accountId =
      extractAccountIdFromJwt(payload.access_token) ??
      (payload.id_token ? extractAccountIdFromJwt(payload.id_token) : undefined) ??
      fallback?.accountId;

    if (!accountId) {
      throw new Error('Unable to determine ChatGPT account ID from OAuth token.');
    }

    const expiresAt =
      getTokenExpiry(payload.access_token) ??
      (payload.expires_in ? Date.now() + payload.expires_in * 1000 : undefined) ??
      Date.now() + TOKEN_EXPIRY_FALLBACK_MS;

    return {
      accessToken: payload.access_token,
      refreshToken,
      expiresAt,
      tokenType: payload.token_type ?? fallback?.tokenType ?? 'Bearer',
      scope: payload.scope ?? fallback?.scope ?? DEFAULT_SCOPE,
      accountId,
      provider: 'openai-codex',
      keyVersion: fallback?.keyVersion ?? 1,
    };
  }

  private normalizeToken(tokenData: OAuthTokenData): OAuthTokenData {
    const parsedAccountId =
      tokenData.accountId ?? extractAccountIdFromJwt(tokenData.accessToken);
    return {
      ...tokenData,
      accountId: parsedAccountId,
    };
  }

  private needsRefresh(tokenData: OAuthTokenData): boolean {
    return Date.now() >= tokenData.expiresAt - TOKEN_REFRESH_BUFFER_MS;
  }

  private buildAuthorizeUrl(
    redirectUri: string,
    state: string,
    codeChallenge: string,
  ): string {
    const url = new URL(this.getAuthorizeEndpoint());
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', this.config.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('scope', DEFAULT_SCOPE);
    url.searchParams.set('code_challenge', codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('state', state);
    url.searchParams.set('originator', 'secureclaw');
    url.searchParams.set('id_token_add_organizations', 'true');
    url.searchParams.set('codex_cli_simplified_flow', 'true');

    if (this.config.allowedWorkspaceId) {
      url.searchParams.set('allowed_workspace_id', this.config.allowedWorkspaceId);
    }

    return url.toString();
  }

  private getAuthorizeEndpoint(): string {
    return `${this.getIssuerOrigin()}/oauth/authorize`;
  }

  private getTokenEndpoint(): string {
    return `${this.getIssuerOrigin()}/oauth/token`;
  }

  private getIssuerOrigin(): string {
    const issuer = this.config.issuer ?? DEFAULT_ISSUER;
    const parsed = new URL(issuer);
    if (parsed.protocol !== 'https:') {
      throw new Error('Codex OAuth issuer must use HTTPS.');
    }
    return parsed.origin;
  }

  private clearPendingState(state: string): void {
    const pending = this.pendingByState.get(state);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.pendingByState.delete(state);

    const currentState = this.stateByUser.get(pending.userId);
    if (currentState === state) {
      this.stateByUser.delete(pending.userId);
    }

    if (this.pendingByState.size === 0) {
      void this.stopCallbackServer();
    }
  }

  private pruneExpiredLogins(): void {
    const now = Date.now();
    for (const [state, pending] of this.pendingByState) {
      if (now > pending.expiresAt) {
        this.clearPendingState(state);
      }
    }
  }
}

function randomUrlSafe(numBytes: number): string {
  return crypto.randomBytes(numBytes).toString('base64url');
}

function toCodeChallenge(codeVerifier: string): string {
  return crypto.createHash('sha256').update(codeVerifier).digest('base64url');
}

function parseCallbackInput(input: string): { code: string; state: string } | null {
  try {
    const url = new URL(input);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (!code || !state) return null;
    return { code, state };
  } catch {
    return null;
  }
}

function getTokenExpiry(jwt: string): number | null {
  const payload = parseJwtPayload(jwt);
  if (!payload) return null;
  const exp = payload['exp'];
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return null;
  return exp * 1000;
}

function extractAccountIdFromJwt(jwt: string): string | undefined {
  const payload = parseJwtPayload(jwt);
  if (!payload) return undefined;

  const authObj = payload['https://api.openai.com/auth'];
  if (isRecord(authObj)) {
    const accountId = authObj['chatgpt_account_id'];
    if (typeof accountId === 'string' && accountId.length > 0) {
      return accountId;
    }
  }

  const direct = payload['chatgpt_account_id'];
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }

  return undefined;
}

function parseJwtPayload(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const payloadRaw = Buffer.from(parts[1]!, 'base64url').toString('utf-8');
    const payload = JSON.parse(payloadRaw) as unknown;
    if (!isRecord(payload)) return null;
    return payload;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRunningInContainer(): boolean {
  try {
    return fs.existsSync('/.dockerenv');
  } catch {
    return false;
  }
}
