/**
 * MCP Manager — central coordinator for MCP server integration.
 *
 * Ties together:
 * - Container lifecycle (McpContainerManager)
 * - JSON-RPC clients (McpClient)
 * - Tool discovery and name-prefixing
 * - Tool call routing
 * - Crash recovery
 *
 * Tool naming convention:
 *   MCP tools are prefixed with "mcp_{serverName}__" (double underscore).
 *   Example: GitHub MCP server's "list_issues" → "mcp_github__list_issues".
 *   This avoids collisions with built-in tools and between MCP servers.
 */

import type { ToolDefinition } from '../llm-provider.js';
import type { McpServerConfig } from '../config.js';
import type { AuditLogger } from '../audit.js';
import type { McpContainerManager, McpContainerInfo } from './container.js';
import { McpClient } from './client.js';
import type { McpToolDefinition, McpToolResult } from './client.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Separator between server name and tool name in prefixed tool names. */
const TOOL_PREFIX_SEPARATOR = '__';

/** Prefix for all MCP tool names. */
const TOOL_PREFIX = 'mcp_';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpServerState {
  config: McpServerConfig;
  client: McpClient | null;
  containerInfo: McpContainerInfo | null;
  tools: ToolDefinition[];
  rawTools: McpToolDefinition[];
  status: 'starting' | 'ready' | 'error' | 'stopped';
  lastError?: string;
}

// ---------------------------------------------------------------------------
// McpManager
// ---------------------------------------------------------------------------

export class McpManager {
  private containerManager: McpContainerManager;
  private servers: Map<string, McpServerState> = new Map();
  private auditLogger: AuditLogger;

  constructor(containerManager: McpContainerManager, auditLogger: AuditLogger) {
    this.containerManager = containerManager;
    this.auditLogger = auditLogger;

    // Listen for container crashes and attempt recovery
    this.containerManager.onCrash((serverName) => {
      this.handleCrash(serverName).catch((err) => {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error(`[mcp-manager] Crash recovery failed for ${serverName}: ${error.message}`);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start all configured MCP servers.
   * Called during Gateway startup.
   */
  async startAll(configs: McpServerConfig[]): Promise<void> {
    const enabled = configs.filter((c) => c.enabled !== false);

    for (const config of enabled) {
      try {
        await this.startServer(config);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error(
          `[mcp-manager] Failed to start MCP server "${config.name}": ${error.message}`,
        );
        this.servers.set(config.name, {
          config,
          client: null,
          containerInfo: null,
          tools: [],
          rawTools: [],
          status: 'error',
          lastError: error.message,
        });
      }
    }
  }

  /**
   * Start a single MCP server.
   *
   * 1. Start the Docker container
   * 2. Create McpClient from the container's stdin/stdout
   * 3. Initialize the MCP connection (handshake)
   * 4. Discover tools via tools/list
   * 5. Translate and filter tools into SecureClaw ToolDefinition[]
   */
  async startServer(config: McpServerConfig): Promise<void> {
    const serverName = config.name;
    console.log(`[mcp-manager] Starting MCP server: ${serverName}`);

    // Initialize state
    this.servers.set(serverName, {
      config,
      client: null,
      containerInfo: null,
      tools: [],
      rawTools: [],
      status: 'starting',
    });

    // Start the Docker container
    const containerInfo = await this.containerManager.startContainer(config);

    // Create MCP client from the container's attached streams
    const client = new McpClient(
      containerInfo.stdin as NodeJS.WritableStream & import('node:stream').Writable,
      containerInfo.stdout as NodeJS.ReadableStream & import('node:stream').Readable,
    );

    // Initialize MCP connection (handshake)
    await client.initialize();

    // Discover tools
    const rawTools = await client.listTools();
    console.log(
      `[mcp-manager] ${serverName}: discovered ${rawTools.length} tool(s)`,
    );

    // Translate to SecureClaw ToolDefinition[] with prefix and filtering
    const tools = this.translateTools(serverName, rawTools, config);
    console.log(
      `[mcp-manager] ${serverName}: exposing ${tools.length} tool(s) to LLM`,
    );

    // Update state
    const state = this.servers.get(serverName)!;
    state.client = client;
    state.containerInfo = containerInfo;
    state.tools = tools;
    state.rawTools = rawTools;
    state.status = 'ready';
  }

  /**
   * Stop a single MCP server.
   */
  async stopServer(serverName: string): Promise<void> {
    const state = this.servers.get(serverName);
    if (!state) return;

    console.log(`[mcp-manager] Stopping MCP server: ${serverName}`);

    // Shut down the MCP client
    if (state.client) {
      try {
        await state.client.shutdown();
      } catch {
        // Ignore shutdown errors
      }
      state.client.dispose();
    }

    // Stop the container
    await this.containerManager.stopContainer(serverName);

    state.status = 'stopped';
    state.client = null;
    state.containerInfo = null;
    state.tools = [];
    this.servers.delete(serverName);
  }

  /**
   * Stop all MCP servers. Called on Gateway shutdown.
   */
  async stopAll(): Promise<void> {
    const names = [...this.servers.keys()];
    if (names.length === 0) return;

    console.log(`[mcp-manager] Stopping ${names.length} MCP server(s)...`);
    await Promise.all(names.map((name) => this.stopServer(name)));
    console.log('[mcp-manager] All MCP servers stopped');
  }

  // -------------------------------------------------------------------------
  // Tool Interface (used by Orchestrator)
  // -------------------------------------------------------------------------

  /**
   * Get all discovered MCP tools (translated to ToolDefinition[]).
   * These are merged into the orchestrator's allTools list.
   */
  getAllTools(): ToolDefinition[] {
    const allTools: ToolDefinition[] = [];
    for (const state of this.servers.values()) {
      if (state.status === 'ready') {
        allTools.push(...state.tools);
      }
    }
    return allTools;
  }

  /**
   * Get the set of all MCP tool names (prefixed).
   * Used for routing in the orchestrator's tool call loop.
   */
  getMcpToolNames(): Set<string> {
    const names = new Set<string>();
    for (const state of this.servers.values()) {
      if (state.status === 'ready') {
        for (const tool of state.tools) {
          names.add(tool.name);
        }
      }
    }
    return names;
  }

  /**
   * Call an MCP tool.
   *
   * Parses the prefixed tool name to identify the server and original tool name,
   * routes to the correct McpClient, and formats the result.
   *
   * @param prefixedToolName - e.g., "mcp_github__list_issues"
   * @param args - Tool arguments from the LLM
   * @returns Tool result as a string (for ToolResultContent.content)
   */
  async callTool(
    prefixedToolName: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const serverName = this.getServerName(prefixedToolName);
    if (!serverName) {
      return `Error: Could not determine MCP server from tool name "${prefixedToolName}"`;
    }

    const state = this.servers.get(serverName);
    if (!state || state.status !== 'ready' || !state.client) {
      return `Error: MCP server "${serverName}" is not available (status: ${state?.status ?? 'unknown'})`;
    }

    // Extract the original (unprefixed) tool name
    const originalName = this.stripPrefix(prefixedToolName, serverName);

    const timeoutMs = (state.config.toolTimeout ?? 60) * 1000;

    // Audit the MCP tool call
    this.auditLogger.log({
      timestamp: new Date(),
      type: 'tool_call',
      sessionId: 'mcp',
      data: {
        mcpServer: serverName,
        mcpTool: originalName,
        prefixedName: prefixedToolName,
        args,
      },
    });

    try {
      const result = await state.client.callTool(originalName, args, timeoutMs);
      return this.formatToolResult(result);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      return `Error calling MCP tool "${originalName}" on server "${serverName}": ${error.message}`;
    }
  }

  /**
   * Get the server name from a prefixed tool name.
   *
   * "mcp_github__list_issues" → "github"
   */
  getServerName(prefixedToolName: string): string | null {
    if (!prefixedToolName.startsWith(TOOL_PREFIX)) return null;

    const withoutPrefix = prefixedToolName.slice(TOOL_PREFIX.length);
    const separatorIndex = withoutPrefix.indexOf(TOOL_PREFIX_SEPARATOR);
    if (separatorIndex === -1) return null;

    return withoutPrefix.slice(0, separatorIndex);
  }

  /**
   * Get server states (for dashboard/status reporting).
   */
  getServerStates(): Map<string, McpServerState> {
    return this.servers;
  }

  // -------------------------------------------------------------------------
  // Tool Translation
  // -------------------------------------------------------------------------

  /**
   * Translate MCP tool definitions into SecureClaw ToolDefinition[].
   *
   * - Prefixes tool names with "mcp_{serverName}__"
   * - Converts MCP inputSchema to ToolDefinition.parameters
   * - Applies filtering: includeTools, excludeTools, maxTools cap
   */
  private translateTools(
    serverName: string,
    mcpTools: McpToolDefinition[],
    config: McpServerConfig,
  ): ToolDefinition[] {
    let filtered = mcpTools;

    // Apply include filter (whitelist)
    if (config.includeTools && config.includeTools.length > 0) {
      const includeSet = new Set(config.includeTools);
      filtered = filtered.filter((t) => includeSet.has(t.name));
    }

    // Apply exclude filter (blacklist)
    if (config.excludeTools && config.excludeTools.length > 0) {
      const excludeSet = new Set(config.excludeTools);
      filtered = filtered.filter((t) => !excludeSet.has(t.name));
    }

    // Apply maxTools cap
    const maxTools = config.maxTools ?? 30;
    if (filtered.length > maxTools) {
      console.warn(
        `[mcp-manager] ${serverName}: capping tools from ${filtered.length} to ${maxTools}`,
      );
      filtered = filtered.slice(0, maxTools);
    }

    return filtered.map((mcpTool): ToolDefinition => ({
      name: `${TOOL_PREFIX}${serverName}${TOOL_PREFIX_SEPARATOR}${mcpTool.name}`,
      description:
        `[MCP: ${serverName}] ${mcpTool.description ?? mcpTool.name}`,
      parameters: {
        type: 'object',
        properties: (mcpTool.inputSchema.properties ?? {}) as Record<
          string,
          { type: string; description?: string }
        >,
        required: mcpTool.inputSchema.required ?? [],
      },
    }));
  }

  // -------------------------------------------------------------------------
  // Result Formatting
  // -------------------------------------------------------------------------

  /**
   * Format an MCP tool result as a string for the LLM.
   *
   * MCP results contain content[] with type: 'text' | 'image' | 'resource'.
   * We concatenate text content and note the presence of other types.
   */
  private formatToolResult(result: McpToolResult): string {
    const parts: string[] = [];

    if (result.isError) {
      parts.push('Error: ');
    }

    for (const item of result.content) {
      switch (item.type) {
        case 'text':
          if (item.text) parts.push(item.text);
          break;
        case 'image':
          parts.push(`[Image: ${item.mimeType ?? 'unknown type'}]`);
          break;
        case 'resource':
          parts.push(`[Resource: ${item.mimeType ?? 'embedded resource'}]`);
          break;
        default:
          parts.push(`[${item.type}: unsupported content type]`);
      }
    }

    return parts.join('\n') || '(empty result)';
  }

  // -------------------------------------------------------------------------
  // Crash Recovery
  // -------------------------------------------------------------------------

  /**
   * Handle a container crash by attempting restart and re-initialization.
   */
  private async handleCrash(serverName: string): Promise<void> {
    const state = this.servers.get(serverName);
    if (!state) return;

    console.warn(`[mcp-manager] Handling crash for ${serverName}`);
    state.status = 'error';

    // Clean up old client
    if (state.client) {
      state.client.dispose();
      state.client = null;
    }

    // Attempt container restart
    const newContainerInfo = await this.containerManager.restartContainer(serverName);
    if (!newContainerInfo) {
      state.lastError = 'Max restart attempts exceeded';
      console.error(`[mcp-manager] ${serverName}: giving up after max restart attempts`);
      return;
    }

    // Re-create MCP client
    try {
      const client = new McpClient(
        newContainerInfo.stdin as NodeJS.WritableStream & import('node:stream').Writable,
        newContainerInfo.stdout as NodeJS.ReadableStream & import('node:stream').Readable,
      );

      await client.initialize();
      const rawTools = await client.listTools();
      const tools = this.translateTools(serverName, rawTools, state.config);

      state.client = client;
      state.containerInfo = newContainerInfo;
      state.tools = tools;
      state.rawTools = rawTools;
      state.status = 'ready';
      state.lastError = undefined;

      console.log(`[mcp-manager] ${serverName}: successfully recovered from crash`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      state.lastError = error.message;
      console.error(`[mcp-manager] ${serverName}: crash recovery failed: ${error.message}`);
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Strip the prefix from a tool name to get the original MCP tool name.
   * "mcp_github__list_issues" → "list_issues"
   */
  private stripPrefix(prefixedName: string, serverName: string): string {
    const prefix = `${TOOL_PREFIX}${serverName}${TOOL_PREFIX_SEPARATOR}`;
    return prefixedName.startsWith(prefix)
      ? prefixedName.slice(prefix.length)
      : prefixedName;
  }
}
