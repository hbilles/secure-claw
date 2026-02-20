/**
 * MCP (Model Context Protocol) integration module.
 *
 * Provides ecosystem tool server support by running community MCP servers
 * inside Docker containers with the same security hardening as existing executors.
 *
 * Architecture:
 * - McpProxy: HTTP CONNECT proxy with per-container domain filtering
 * - McpContainerManager: Docker lifecycle for long-lived MCP containers
 * - McpClient: MCP SDK wrapper adapted for Docker attach streams
 * - McpManager: Central coordinator — tool discovery, routing, lifecycle
 */

export { McpProxy } from './proxy.js';
export { McpContainerManager } from './container.js';
export type { McpContainerInfo } from './container.js';
export { McpClient } from './client.js';
export type { McpToolDefinition, McpToolResult } from './client.js';
export { McpManager } from './manager.js';
export type { McpServerState } from './manager.js';
