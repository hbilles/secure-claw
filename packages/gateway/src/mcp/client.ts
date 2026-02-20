/**
 * MCP Client — wrapper around the official @modelcontextprotocol/sdk Client.
 *
 * Provides a simplified interface for SecureClaw's use case:
 * - Connects to MCP servers via Docker attach stdin/stdout streams
 * - Discovers tools via tools/list
 * - Calls tools with per-call timeouts
 * - Handles graceful shutdown
 *
 * Uses a custom StreamTransport since the SDK's StdioClientTransport
 * spawns its own child process, but we manage containers via Docker.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport, TransportSendOptions } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Readable, Writable } from 'node:stream';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** MCP tool definition as returned by tools/list. */
export interface McpToolDefinition {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
}

/** MCP tool call result. */
export interface McpToolResult {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
    [key: string]: unknown;
  }>;
  isError?: boolean;
}

// ---------------------------------------------------------------------------
// StreamTransport — custom MCP transport for Docker attach streams
// ---------------------------------------------------------------------------

/**
 * MCP Transport implementation that works with raw stdin/stdout streams.
 *
 * The MCP protocol uses newline-delimited JSON over stdio. Each message
 * is a complete JSON-RPC object followed by a newline.
 */
class StreamTransport implements Transport {
  private stdin: Writable;
  private stdout: Readable;
  private buffer = '';
  private started = false;

  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  constructor(stdin: Writable, stdout: Readable) {
    this.stdin = stdin;
    this.stdout = stdout;
  }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    this.stdout.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf-8');
      this.processBuffer();
    });

    this.stdout.on('end', () => {
      this.onclose?.();
    });

    this.stdout.on('error', (err: Error) => {
      this.onerror?.(err);
    });

    this.stdin.on('error', (err: Error) => {
      this.onerror?.(err);
    });
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    const json = JSON.stringify(message) + '\n';
    return new Promise((resolve, reject) => {
      this.stdin.write(json, 'utf-8', (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    this.started = false;
    this.stdin.end();
    this.onclose?.();
  }

  /**
   * Process the buffer for complete JSON-RPC messages.
   * Messages are newline-delimited JSON.
   */
  private processBuffer(): void {
    while (true) {
      const newlineIndex = this.buffer.indexOf('\n');
      if (newlineIndex === -1) break;

      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);

      if (!line) continue;

      try {
        const message = JSON.parse(line) as JSONRPCMessage;
        this.onmessage?.(message);
      } catch (err) {
        // Skip non-JSON lines (e.g., MCP server startup messages on stdout).
        // This is common when MCP servers print banner messages before
        // the JSON-RPC protocol starts.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// McpClient
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 60_000;

export class McpClient {
  private client: Client;
  private transport: StreamTransport;
  private connected = false;

  constructor(stdin: Writable, stdout: Readable) {
    this.transport = new StreamTransport(stdin, stdout);
    this.client = new Client(
      { name: 'secureclaw-gateway', version: '1.0.0' },
      { capabilities: {} },
    );
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Initialize the MCP connection.
   * Performs the MCP handshake (initialize + initialized notification).
   */
  async initialize(): Promise<void> {
    await this.client.connect(this.transport);
    this.connected = true;
    console.log(
      `[mcp-client] Connected to MCP server: ` +
      `${this.client.getServerVersion()?.name ?? 'unknown'} ` +
      `v${this.client.getServerVersion()?.version ?? '?'}`,
    );
  }

  /**
   * Gracefully shut down the MCP connection.
   */
  async shutdown(): Promise<void> {
    if (this.connected) {
      await this.client.close();
      this.connected = false;
    }
  }

  /**
   * Clean up resources.
   */
  dispose(): void {
    this.connected = false;
  }

  // -------------------------------------------------------------------------
  // Tool Discovery
  // -------------------------------------------------------------------------

  /**
   * Discover available tools via tools/list.
   * Returns the raw MCP tool definitions.
   */
  async listTools(): Promise<McpToolDefinition[]> {
    const result = await this.client.listTools();
    return result.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema as McpToolDefinition['inputSchema'],
    }));
  }

  // -------------------------------------------------------------------------
  // Tool Execution
  // -------------------------------------------------------------------------

  /**
   * Call a tool on the MCP server.
   *
   * @param toolName - Tool name as known to the MCP server (without prefix)
   * @param args - Tool arguments
   * @param timeoutMs - Per-call timeout (default: 60s)
   * @returns The tool result
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<McpToolResult> {
    // Wrap in Promise.race for timeout enforcement
    const callPromise = this.client.callTool(
      { name: toolName, arguments: args },
    );

    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error(`MCP tool call timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
    });

    const result = await Promise.race([callPromise, timeoutPromise]);

    // Normalize the result to our McpToolResult shape
    if ('content' in result && Array.isArray(result.content)) {
      return {
        content: result.content as McpToolResult['content'],
        isError: 'isError' in result ? (result.isError as boolean) : false,
      };
    }

    // Fallback for unexpected result shapes
    return {
      content: [{ type: 'text', text: JSON.stringify(result) }],
      isError: false,
    };
  }
}
