import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OAuthStore, OAuthTokenData, ServiceName } from '../src/services/oauth.js';
import { OpenAICodexOAuthService } from '../src/services/openai-codex-oauth.js';

class FakeOAuthStore {
  private tokens = new Map<ServiceName, OAuthTokenData>();

  storeToken(service: ServiceName, tokenData: OAuthTokenData): void {
    this.tokens.set(service, tokenData);
  }

  getToken(service: ServiceName): OAuthTokenData | null {
    return this.tokens.get(service) ?? null;
  }

  hasToken(service: ServiceName): boolean {
    return this.tokens.has(service);
  }

  deleteToken(service: ServiceName): boolean {
    return this.tokens.delete(service);
  }
}

function buildJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString(
    'base64url',
  );
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

describe('OpenAICodexOAuthService', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    fetchMock.mockReset();
    vi.unstubAllGlobals();
  });

  const createService = (): {
    store: FakeOAuthStore;
    service: OpenAICodexOAuthService;
  } => {
    const store = new FakeOAuthStore();
    const service = new OpenAICodexOAuthService(store as unknown as OAuthStore, {
      clientId: 'test-client-id',
      callbackPort: 0,
      issuer: 'https://auth.openai.com',
      loginTimeoutSeconds: 120,
    });
    // Test environment may block loopback binds; stub callback-server startup.
    (service as unknown as { ensureCallbackServer: () => Promise<void>; callbackPort: number })
      .ensureCallbackServer = async () => {
      (service as unknown as { callbackPort: number }).callbackPort = 1455;
    };
    return { store, service };
  };

  it('completes authorization-code login and stores encrypted token payload', async () => {
    const { store, service } = createService();
    const expiresSec = Math.floor(Date.now() / 1000) + 3600;
    const accessToken = buildJwt({
      exp: expiresSec,
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'acct_1234567890',
      },
    });

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: accessToken,
          refresh_token: 'refresh_1',
          token_type: 'Bearer',
          scope: 'openid profile email offline_access',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const login = await service.startLogin('user-1', 'chat-1');
    const authUrl = new URL(login.authUrl);
    const state = authUrl.searchParams.get('state');
    expect(state).toBeTruthy();

    await service.completeFromCallbackInput(
      'user-1',
      `http://127.0.0.1/callback?code=abc123&state=${state}`,
    );

    const credentials = await service.getValidAccessCredentials();
    expect(credentials.accountId).toBe('acct_1234567890');
    expect(credentials.accessToken).toBe(accessToken);
    expect(store.hasToken('openai_codex')).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await service.stop();
  });

  it('rejects callback completion when state belongs to a different user', async () => {
    const { service } = createService();

    const login = await service.startLogin('user-owner', 'chat-owner');
    const state = new URL(login.authUrl).searchParams.get('state');
    await expect(
      service.completeFromCallbackInput(
        'user-attacker',
        `http://127.0.0.1/callback?code=abc123&state=${state}`,
      ),
    ).rejects.toThrow('does not belong to this user');

    expect(fetchMock).not.toHaveBeenCalled();
    await service.stop();
  });

  it('rejects initial authorize URL in manual callback mode with clear guidance', async () => {
    const { service } = createService();

    await service.startLogin('user-1', 'chat-1');

    await expect(
      service.completeFromCallbackInput(
        'user-1',
        'https://auth.openai.com/oauth/authorize?client_id=foo',
      ),
    ).rejects.toThrow('missing OAuth code/state');

    expect(fetchMock).not.toHaveBeenCalled();
    await service.stop();
  });

  it('refreshes expired token and persists refresh-token rotation', async () => {
    const { store, service } = createService();
    const oldAccess = buildJwt({
      exp: Math.floor(Date.now() / 1000) - 60,
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_old' },
    });
    store.storeToken('openai_codex', {
      accessToken: oldAccess,
      refreshToken: 'refresh_old',
      expiresAt: Date.now() - 10_000,
      tokenType: 'Bearer',
      accountId: 'acct_old',
      provider: 'openai-codex',
    });

    const refreshedAccess = buildJwt({
      exp: Math.floor(Date.now() / 1000) + 1800,
      'https://api.openai.com/auth': { chatgpt_account_id: 'acct_new' },
    });

    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: refreshedAccess,
          refresh_token: 'refresh_new',
          token_type: 'Bearer',
          scope: 'openid profile email',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    const credentials = await service.getValidAccessCredentials();
    expect(credentials.accountId).toBe('acct_new');
    expect(credentials.accessToken).toBe(refreshedAccess);

    const persisted = store.getToken('openai_codex');
    expect(persisted?.refreshToken).toBe('refresh_new');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await service.stop();
  });
});
