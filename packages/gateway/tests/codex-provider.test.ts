import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CODEX_ACCOUNT_HEADER, CODEX_OAUTH_BASE_URL } from '../src/services/openai-codex-oauth.js';

const createMock = vi.fn();
const streamMock = vi.fn();
const finalResponseMock = vi.fn();
const openAIConstructorMock = vi.fn();

vi.mock('openai', () => {
  class MockOpenAI {
    responses = {
      create: createMock,
      stream: streamMock,
    };

    constructor(options: unknown) {
      openAIConstructorMock(options);
    }
  }

  return { default: MockOpenAI };
});

import { CodexProvider } from '../src/providers/codex.js';

describe('CodexProvider', () => {
  beforeEach(() => {
    createMock.mockReset();
    streamMock.mockReset();
    finalResponseMock.mockReset();
    openAIConstructorMock.mockReset();

    streamMock.mockReturnValue({
      finalResponse: finalResponseMock,
    });
    finalResponseMock.mockResolvedValue({
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'ok' }],
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    });
    createMock.mockResolvedValue({
      status: 'completed',
      output: [
        {
          type: 'message',
          content: [{ type: 'output_text', text: 'ok' }],
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
      },
    });
  });

  it('uses streaming request contract in oauth mode', async () => {
    const provider = new CodexProvider({
      authMode: 'oauth',
      oauthResolver: {
        async getValidAccessCredentials() {
          return {
            accessToken: 'oauth_access_token',
            accountId: 'acct_123',
          };
        },
      },
    });

    const response = await provider.chat({
      model: 'gpt-5.2-2025-12-11',
      maxTokens: 256,
      system: '',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });

    expect(response.stopReason).toBe('end_turn');
    expect(openAIConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: 'oauth_access_token',
        baseURL: CODEX_OAUTH_BASE_URL,
        defaultHeaders: {
          [CODEX_ACCOUNT_HEADER]: 'acct_123',
        },
      }),
    );
    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(streamMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5-codex',
        store: false,
      }),
    );

    const streamParams = streamMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(streamParams['instructions']).toBeTypeOf('string');
    expect(streamParams['instructions']).not.toBe('');
    expect(streamParams).not.toHaveProperty('max_output_tokens');
    expect(createMock).not.toHaveBeenCalled();
  });

  it('uses non-streaming responses create contract in api-key mode', async () => {
    const provider = new CodexProvider({
      authMode: 'api-key',
      apiKey: 'test_api_key',
    });

    const response = await provider.chat({
      model: 'gpt-5-codex',
      maxTokens: 512,
      system: 'You are concise.',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
    });

    expect(response.stopReason).toBe('end_turn');
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model: 'gpt-5-codex',
        instructions: 'You are concise.',
        max_output_tokens: 512,
        store: false,
      }),
    );
    expect(streamMock).not.toHaveBeenCalled();
  });
});
