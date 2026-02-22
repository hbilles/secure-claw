/**
 * OpenAI Codex LLM provider — wraps the OpenAI Responses API.
 *
 * Codex models (codex-mini-latest, gpt-5-codex, gpt-5.1-codex, gpt-5.2-codex)
 * are served via the Responses API, which has a different request/response
 * contract than the Chat Completions API used by the OpenAI provider.
 *
 * Translates between provider-agnostic types and the Responses API format.
 */

import OpenAI from 'openai';
import type {
  Response as OAIResponse,
  FunctionTool,
  EasyInputMessage,
  ResponseInputItem,
  ResponseFunctionToolCall,
  ResponseOutputMessage,
  ResponseOutputText,
  ResponseCreateParamsBase,
  ResponseCreateParamsNonStreaming,
} from 'openai/resources/responses/responses';
import {
  CODEX_ACCOUNT_HEADER,
  CODEX_OAUTH_BASE_URL,
} from '../services/openai-codex-oauth.js';
import type {
  LLMProvider,
  LLMResponse,
  ChatMessage,
  ToolDefinition,
  ContentBlock,
  TextContent,
  ToolCallContent,
  ToolResultContent,
  StopReason,
} from '../llm-provider.js';

const DEFAULT_OAUTH_MODEL = 'gpt-5-codex';
const DEFAULT_OAUTH_INSTRUCTIONS = 'You are SecureClaw. Follow system and user instructions exactly.';
const CHATGPT_OAUTH_UNSUPPORTED_MODELS = new Set(['codex-mini-latest']);

// ---------------------------------------------------------------------------
// Translation: Provider-Agnostic → Responses API
// ---------------------------------------------------------------------------

function toCodexTool(tool: ToolDefinition): FunctionTool {
  return {
    type: 'function',
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false, // SecureClaw schemas lack additionalProperties: false
  };
}

/**
 * Convert the provider-agnostic message history into Responses API input items.
 *
 * Each ChatMessage maps to one or more ResponseInputItem entries:
 * - user text       → EasyInputMessage { role: 'user' }
 * - assistant text  → EasyInputMessage { role: 'assistant' }
 * - assistant blocks → EasyInputMessage (text) + ResponseFunctionToolCall (tool calls)
 * - tool_results    → ResponseInputItem.FunctionCallOutput per result
 */
function toCodexInput(messages: ChatMessage[]): ResponseInputItem[] {
  const items: ResponseInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === 'user') {
      items.push({
        role: 'user',
        content: msg.content as string,
      } satisfies EasyInputMessage);
      continue;
    }

    if (msg.role === 'tool_results') {
      const blocks = msg.content as ToolResultContent[];
      for (const block of blocks) {
        items.push({
          type: 'function_call_output',
          call_id: block.toolCallId,
          output: block.content,
        });
      }
      continue;
    }

    // role === 'assistant'
    if (typeof msg.content === 'string') {
      items.push({
        role: 'assistant',
        content: msg.content,
      } satisfies EasyInputMessage);
      continue;
    }

    // Assistant message with ContentBlock[] — split text and tool calls
    const contentBlocks = msg.content as ContentBlock[];
    const textParts: string[] = [];

    for (const block of contentBlocks) {
      if (block.type === 'text') {
        textParts.push((block as TextContent).text);
      } else if (block.type === 'tool_call') {
        const tc = block as ToolCallContent;
        items.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.name,
          arguments: JSON.stringify(tc.input),
        } as ResponseFunctionToolCall);
      }
    }

    if (textParts.length > 0) {
      items.push({
        role: 'assistant',
        content: textParts.join(''),
      } satisfies EasyInputMessage);
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Translation: Responses API → Provider-Agnostic
// ---------------------------------------------------------------------------

function fromCodexResponse(response: OAIResponse): LLMResponse {
  const content: ContentBlock[] = [];
  let hasToolCalls = false;

  for (const item of response.output) {
    if (item.type === 'message') {
      const msg = item as ResponseOutputMessage;
      for (const part of msg.content) {
        if (part.type === 'output_text') {
          content.push({
            type: 'text',
            text: (part as ResponseOutputText).text,
          } satisfies TextContent);
        }
      }
    } else if (item.type === 'function_call') {
      hasToolCalls = true;
      const tc = item as ResponseFunctionToolCall;
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.arguments) as Record<string, unknown>;
      } catch {
        input = { _raw: tc.arguments };
      }
      content.push({
        type: 'tool_call',
        id: tc.call_id,
        name: tc.name,
        input,
      } satisfies ToolCallContent);
    }
    // Skip reasoning items and built-in tool types (web_search, etc.)
  }

  let stopReason: StopReason;
  if (hasToolCalls) {
    stopReason = 'tool_use';
  } else if (response.status === 'incomplete') {
    stopReason =
      response.incomplete_details?.reason === 'max_output_tokens'
        ? 'max_tokens'
        : 'unknown';
  } else if (response.status === 'completed') {
    stopReason = 'end_turn';
  } else {
    stopReason = 'unknown';
  }

  return {
    content,
    stopReason,
    usage: response.usage
      ? {
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface CodexProviderOptions {
  apiKey?: string;
  baseURL?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  authMode?: 'api-key' | 'oauth';
  oauthResolver?: {
    getValidAccessCredentials(): Promise<{ accessToken: string; accountId: string }>;
  };
}

export class CodexProvider implements LLMProvider {
  private client: OpenAI | null = null;
  private reasoningEffort?: 'low' | 'medium' | 'high';
  private authMode: 'api-key' | 'oauth';
  private oauthResolver?: CodexProviderOptions['oauthResolver'];
  readonly name = 'codex';

  constructor(options: CodexProviderOptions = {}) {
    this.authMode = options.authMode ?? 'api-key';
    this.reasoningEffort = options.reasoningEffort;

    if (this.authMode === 'oauth') {
      if (!options.oauthResolver) {
        throw new Error('Codex OAuth mode requires an OAuth token resolver.');
      }
      if (options.baseURL && options.baseURL !== CODEX_OAUTH_BASE_URL) {
        throw new Error(
          `Codex OAuth mode enforces base URL ${CODEX_OAUTH_BASE_URL}. ` +
            'Custom baseURL is not allowed in OAuth mode.',
        );
      }
      this.oauthResolver = options.oauthResolver;
      return;
    }

    const apiKey = options.apiKey ?? process.env['OPENAI_API_KEY'];
    if (!apiKey) {
      throw new Error(
        'Codex provider requires OPENAI_API_KEY in api-key mode. ' +
          'Set it in your .env file or configure llm.codexAuthMode: oauth.',
      );
    }

    this.client = new OpenAI({ apiKey, baseURL: options.baseURL });
  }

  async chat(params: {
    model: string;
    maxTokens: number;
    system: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
  }): Promise<LLMResponse> {
    const client = await this.getClient();
    const input = toCodexInput(params.messages);

    if (this.authMode === 'oauth') {
      const requestParams: Omit<ResponseCreateParamsBase, 'stream'> = {
        model: normalizeOauthModel(params.model),
        instructions: normalizeOauthInstructions(params.system),
        input,
        // ChatGPT-backed Codex requires non-persistent responses.
        store: false,
      };

      if (params.tools.length > 0) {
        requestParams.tools = params.tools.map(toCodexTool);
      }

      if (this.reasoningEffort) {
        requestParams.reasoning = {
          effort: this.reasoningEffort,
        };
      }

      // ChatGPT-backed Codex requires stream=true; the SDK helper handles SSE and
      // returns the final accumulated response snapshot.
      const response = await client.responses.stream(requestParams).finalResponse();
      return fromCodexResponse(response as OAIResponse);
    }

    const requestParams: ResponseCreateParamsNonStreaming = {
      model: params.model,
      instructions: params.system,
      input,
      max_output_tokens: params.maxTokens,
      store: false, // SecureClaw manages its own conversation state
    };

    // Only include tools if there are any
    if (params.tools.length > 0) {
      requestParams.tools = params.tools.map(toCodexTool);
    }

    // Reasoning effort for Codex/o-series models
    if (this.reasoningEffort) {
      requestParams.reasoning = {
        effort: this.reasoningEffort,
      };
    }

    const response = await client.responses.create(requestParams);
    return fromCodexResponse(response as OAIResponse);
  }

  private async getClient(): Promise<OpenAI> {
    if (this.authMode === 'api-key') {
      if (!this.client) {
        throw new Error('Codex provider is not initialized.');
      }
      return this.client;
    }

    if (!this.oauthResolver) {
      throw new Error('Codex OAuth resolver is not configured.');
    }

    const credentials = await this.oauthResolver.getValidAccessCredentials();
    return new OpenAI({
      apiKey: credentials.accessToken,
      baseURL: CODEX_OAUTH_BASE_URL,
      defaultHeaders: {
        [CODEX_ACCOUNT_HEADER]: credentials.accountId,
      },
    });
  }
}

function normalizeOauthInstructions(system: string): string {
  const trimmed = system.trim();
  return trimmed.length > 0 ? trimmed : DEFAULT_OAUTH_INSTRUCTIONS;
}

function normalizeOauthModel(model: string): string {
  const requested = model.trim();
  if (requested.length === 0) {
    return DEFAULT_OAUTH_MODEL;
  }

  const lowered = requested.toLowerCase();
  if (CHATGPT_OAUTH_UNSUPPORTED_MODELS.has(lowered)) {
    console.warn(
      `[codex] Model "${requested}" is not supported in ChatGPT OAuth mode. ` +
        `Falling back to "${DEFAULT_OAUTH_MODEL}".`,
    );
    return DEFAULT_OAUTH_MODEL;
  }

  if (!lowered.includes('codex')) {
    console.warn(
      `[codex] Model "${requested}" is not a Codex model. ` +
        `ChatGPT OAuth mode requires a Codex model; falling back to "${DEFAULT_OAUTH_MODEL}".`,
    );
    return DEFAULT_OAUTH_MODEL;
  }

  return requested;
}
