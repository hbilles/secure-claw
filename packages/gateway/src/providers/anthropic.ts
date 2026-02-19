/**
 * Anthropic LLM provider — wraps the @anthropic-ai/sdk.
 *
 * Translates between provider-agnostic types and Anthropic's
 * Messages API format.
 */

import Anthropic from '@anthropic-ai/sdk';
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
// Translation: Provider-Agnostic → Anthropic
// ---------------------------------------------------------------------------

function toAnthropicTool(tool: ToolDefinition): Anthropic.Messages.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: {
      type: 'object' as const,
      properties: tool.parameters.properties,
      required: tool.parameters.required,
    },
  };
}

function toAnthropicMessage(
  msg: ChatMessage,
): Anthropic.Messages.MessageParam {
  if (msg.role === 'user') {
    return { role: 'user', content: msg.content as string };
  }

  if (msg.role === 'tool_results') {
    // Tool results are sent as a user message with tool_result content blocks
    const blocks = msg.content as ToolResultContent[];
    return {
      role: 'user',
      content: blocks.map((block) => ({
        type: 'tool_result' as const,
        tool_use_id: block.toolCallId,
        content: block.content,
      })),
    };
  }

  // role === 'assistant' — content is ContentBlock[]
  const contentBlocks = msg.content as ContentBlock[];
  return {
    role: 'assistant',
    content: contentBlocks.map((block) => {
      if (block.type === 'text') {
        return { type: 'text' as const, text: (block as TextContent).text };
      }
      // tool_call → tool_use
      const tc = block as ToolCallContent;
      return {
        type: 'tool_use' as const,
        id: tc.id,
        name: tc.name,
        input: tc.input,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Translation: Anthropic → Provider-Agnostic
// ---------------------------------------------------------------------------

function fromAnthropicResponse(
  response: Anthropic.Messages.Message,
): LLMResponse {
  const content: ContentBlock[] = response.content.map((block) => {
    if (block.type === 'text') {
      return { type: 'text', text: block.text } satisfies TextContent;
    }
    if (block.type === 'tool_use') {
      return {
        type: 'tool_call',
        id: block.id,
        name: block.name,
        input: block.input as Record<string, unknown>,
      } satisfies ToolCallContent;
    }
    // Fallback for unknown block types
    return { type: 'text', text: '' } satisfies TextContent;
  });

  const stopReasonMap: Record<string, StopReason> = {
    tool_use: 'tool_use',
    end_turn: 'end_turn',
    max_tokens: 'max_tokens',
  };

  return {
    content,
    stopReason: stopReasonMap[response.stop_reason ?? ''] ?? 'unknown',
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class AnthropicProvider implements LLMProvider {
  private client: Anthropic;
  readonly name = 'anthropic';

  constructor() {
    // The SDK reads ANTHROPIC_API_KEY from env automatically
    this.client = new Anthropic();
  }

  async chat(params: {
    model: string;
    maxTokens: number;
    system: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
  }): Promise<LLMResponse> {
    const response = await this.client.messages.create({
      model: params.model,
      max_tokens: params.maxTokens,
      system: params.system,
      tools: params.tools.map(toAnthropicTool),
      messages: params.messages.map(toAnthropicMessage),
    });

    return fromAnthropicResponse(response);
  }
}
