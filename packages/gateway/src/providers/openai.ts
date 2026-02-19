/**
 * OpenAI-compatible LLM provider.
 *
 * Works with:
 * - OpenAI API (GPT-4o, etc.)
 * - LM Studio (local models via OpenAI-compatible endpoint)
 * - Any other OpenAI-compatible server (vLLM, ollama, etc.)
 *
 * Translates between provider-agnostic types and OpenAI's
 * Chat Completions API format.
 */

import OpenAI from 'openai';
import type {
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionMessageToolCall,
} from 'openai/resources/chat/completions';
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

// ---------------------------------------------------------------------------
// Translation: Provider-Agnostic → OpenAI
// ---------------------------------------------------------------------------

function toOpenAITool(tool: ToolDefinition): ChatCompletionTool {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

/**
 * Convert a single ChatMessage into one or more OpenAI messages.
 *
 * A `tool_results` message expands into individual `tool` role messages
 * (one per tool result), which is what OpenAI expects.
 */
function toOpenAIMessages(
  msg: ChatMessage,
): ChatCompletionMessageParam[] {
  if (msg.role === 'user') {
    return [{ role: 'user', content: msg.content as string }];
  }

  if (msg.role === 'tool_results') {
    // Each tool result becomes a separate 'tool' message
    const blocks = msg.content as ToolResultContent[];
    return blocks.map((block) => ({
      role: 'tool' as const,
      tool_call_id: block.toolCallId,
      content: block.content,
    }));
  }

  // role === 'assistant' — content can be a plain string (final text response)
  // or ContentBlock[] (response with tool calls that was stored mid-loop)
  if (typeof msg.content === 'string') {
    return [{ role: 'assistant' as const, content: msg.content }];
  }

  const contentBlocks = msg.content as ContentBlock[];
  const textParts: string[] = [];
  const toolCalls: ChatCompletionMessageToolCall[] = [];

  for (const block of contentBlocks) {
    if (block.type === 'text') {
      textParts.push((block as TextContent).text);
    } else if (block.type === 'tool_call') {
      const tc = block as ToolCallContent;
      toolCalls.push({
        id: tc.id,
        type: 'function',
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.input),
        },
      });
    }
  }

  if (toolCalls.length > 0) {
    return [{
      role: 'assistant' as const,
      content: textParts.join('') || null,
      tool_calls: toolCalls,
    }];
  }

  return [{
    role: 'assistant' as const,
    content: textParts.join('') || null,
  }];
}

// ---------------------------------------------------------------------------
// Translation: OpenAI → Provider-Agnostic
// ---------------------------------------------------------------------------

function fromOpenAIResponse(
  response: OpenAI.Chat.Completions.ChatCompletion,
): LLMResponse {
  const choice = response.choices[0];
  if (!choice) {
    return { content: [], stopReason: 'unknown' };
  }

  const message = choice.message;
  const content: ContentBlock[] = [];

  // Text content
  if (message.content) {
    content.push({ type: 'text', text: message.content } satisfies TextContent);
  }

  // Tool calls
  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        // If arguments aren't valid JSON, pass them as a raw string
        input = { _raw: tc.function.arguments };
      }
      content.push({
        type: 'tool_call',
        id: tc.id,
        name: tc.function.name,
        input,
      } satisfies ToolCallContent);
    }
  }

  const stopReasonMap: Record<string, StopReason> = {
    tool_calls: 'tool_use',
    stop: 'end_turn',
    length: 'max_tokens',
  };

  return {
    content,
    stopReason: stopReasonMap[choice.finish_reason ?? ''] ?? 'unknown',
    usage: response.usage
      ? {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens,
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface OpenAIProviderOptions {
  apiKey?: string;
  baseURL?: string;
}

export class OpenAIProvider implements LLMProvider {
  private client: OpenAI;
  readonly name: string;

  constructor(options: OpenAIProviderOptions = {}, providerName?: string) {
    this.client = new OpenAI({
      apiKey: options.apiKey ?? process.env['OPENAI_API_KEY'] ?? 'not-needed',
      baseURL: options.baseURL,
    });
    this.name = providerName ?? 'openai';
  }

  async chat(params: {
    model: string;
    maxTokens: number;
    system: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
  }): Promise<LLMResponse> {
    // Build the messages array with system prompt first
    const openaiMessages: ChatCompletionMessageParam[] = [
      { role: 'system', content: params.system },
      ...params.messages.flatMap(toOpenAIMessages),
    ];

    const requestParams: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: params.model,
      max_tokens: params.maxTokens,
      messages: openaiMessages,
    };

    // Only include tools if there are any (some models choke on empty arrays)
    if (params.tools.length > 0) {
      requestParams.tools = params.tools.map(toOpenAITool);
    }

    const response = await this.client.chat.completions.create(requestParams);

    return fromOpenAIResponse(response);
  }
}
