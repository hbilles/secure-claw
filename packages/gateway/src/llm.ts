/**
 * LLM client wrapping the Anthropic SDK.
 *
 * Uses streaming for better perceived latency. Returns the full
 * response text once the stream completes.
 */

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 4096;

const SYSTEM_PROMPT =
  'You are a personal AI assistant. You are helpful, concise, and direct. ' +
  'You are communicating via Telegram, so keep responses reasonably short ' +
  'unless the user asks for detail.';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export class LLMClient {
  private client: Anthropic;

  constructor() {
    // The SDK reads ANTHROPIC_API_KEY from env automatically
    this.client = new Anthropic();
  }

  /**
   * Send a conversation to Claude and return the assistant's response.
   * Uses streaming internally for lower time-to-first-token.
   */
  async chat(messages: ChatMessage[]): Promise<string> {
    const stream = this.client.messages.stream({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    const response = await stream.finalMessage();

    // Extract text from content blocks
    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return text;
  }
}
