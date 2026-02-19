/**
 * Provider-agnostic LLM types and interface.
 *
 * All LLM interaction in SecureClaw flows through this interface.
 * Provider implementations (Anthropic, OpenAI, LM Studio) translate
 * between these types and their native SDK formats.
 */

// ---------------------------------------------------------------------------
// Tool Definitions
// ---------------------------------------------------------------------------

export interface ToolParameter {
  type: string;
  description?: string;
  enum?: string[];
  items?: ToolParameter;
  properties?: Record<string, ToolParameter>;
  required?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required: string[];
  };
}

// ---------------------------------------------------------------------------
// Content Blocks
// ---------------------------------------------------------------------------

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolCallContent {
  type: 'tool_call';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: 'tool_result';
  toolCallId: string;
  content: string;
}

export type ContentBlock = TextContent | ToolCallContent | ToolResultContent;

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

/**
 * Provider-agnostic chat message.
 *
 * - `user`: User text message (content is a string).
 * - `assistant`: Assistant response (content is ContentBlock[] with text and/or tool calls).
 * - `tool_results`: Tool execution results (content is ToolResultContent[]).
 */
export interface ChatMessage {
  role: 'user' | 'assistant' | 'tool_results';
  content: string | ContentBlock[];
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export type StopReason = 'tool_use' | 'end_turn' | 'max_tokens' | 'unknown';

export interface LLMResponse {
  content: ContentBlock[];
  stopReason: StopReason;
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
}

// ---------------------------------------------------------------------------
// Provider Interface
// ---------------------------------------------------------------------------

export interface LLMProvider {
  /** Send a chat completion request with tool definitions. */
  chat(params: {
    model: string;
    maxTokens: number;
    system: string;
    messages: ChatMessage[];
    tools: ToolDefinition[];
  }): Promise<LLMResponse>;

  /** Provider name for logging. */
  readonly name: string;
}
