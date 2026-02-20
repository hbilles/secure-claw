/**
 * MCP Container Manager — Docker lifecycle for long-lived MCP server containers.
 *
 * Unlike the existing Dispatcher (which creates one-shot containers per tool call),
 * MCP containers are long-lived: they stay running across multiple tool calls and
 * are only stopped on Gateway shutdown or server error.
 *
 * Communication is via Docker attach (stdin/stdout streams) for JSON-RPC over stdio.
 *
 * Security model mirrors the existing executors:
 * - --cap-drop=ALL (except NET_ADMIN for network-enabled containers)
 * - --security-opt=no-new-privileges
 * - Memory and CPU limits
 * - Network-enabled containers: iptables restrict outbound to proxy only
 * - No-network containers: --network=none
 * - Credentials isolated per-container via env vars
 */

import Docker from 'dockerode';
import { PassThrough } from 'node:stream';
import type { McpServerConfig, MountConfig } from '../config.js';
import type { McpProxy } from './proxy.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpContainerInfo {
  containerId: string;
  serverName: string;
  ip: string;
  /** Writable stream to send JSON-RPC requests to the MCP server. */
  stdin: NodeJS.WritableStream;
  /** Readable stream to receive JSON-RPC responses from the MCP server. */
  stdout: NodeJS.ReadableStream;
  /** Readable stream for MCP server stderr (for diagnostics). */
  stderr: NodeJS.ReadableStream;
  status: 'starting' | 'running' | 'stopped' | 'error';
}

const MAX_RESTART_ATTEMPTS = 3;
const HEALTH_CHECK_INTERVAL_MS = 30_000;

// ---------------------------------------------------------------------------
// McpContainerManager
// ---------------------------------------------------------------------------

export class McpContainerManager {
  private docker: Docker;
  private proxy: McpProxy | null;
  private containers: Map<string, McpContainerInfo> = new Map();
  private healthChecks: Map<string, ReturnType<typeof setInterval>> = new Map();
  private restartCounts: Map<string, number> = new Map();
  private configs: Map<string, McpServerConfig> = new Map();

  constructor(docker: Docker, proxy: McpProxy | null) {
    this.docker = docker;
    this.proxy = proxy;
  }

  // -------------------------------------------------------------------------
  // Container Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Start an MCP server container.
   *
   * The container runs the MCP server command and stays alive.
   * Communication is via Docker attach (stdin/stdout streams).
   */
  async startContainer(config: McpServerConfig): Promise<McpContainerInfo> {
    const serverName = config.name;
    console.log(`[mcp-container] Starting MCP server: ${serverName} (${config.image})`);

    this.configs.set(serverName, config);

    const hasNetwork = config.allowedDomains && config.allowedDomains.length > 0;
    const resolvedEnv = this.resolveEnvVars(config.env ?? {});

    // Build the command + args
    const cmd = [config.command, ...(config.args ?? [])];

    // Build container configuration with security constraints
    const containerConfig: Docker.ContainerCreateOptions = {
      Image: config.image,
      Cmd: hasNetwork ? ['/entrypoint-mcp.sh'] : cmd,
      Env: [
        ...resolvedEnv,
        // For network-enabled containers, pass the MCP command through env vars
        // so the entrypoint can set up iptables first, then exec the MCP server.
        ...(hasNetwork ? [
          `MCP_COMMAND=${config.command}`,
          `MCP_ARGS=${JSON.stringify(config.args ?? [])}`,
          `HTTPS_PROXY=http://${this.proxy?.getAddress() ?? 'localhost:8443'}`,
          `HTTP_PROXY=http://${this.proxy?.getAddress() ?? 'localhost:8443'}`,
          `NO_PROXY=localhost,127.0.0.1`,
        ] : []),
      ],
      WorkingDir: '/workspace',
      // Keep stdin open for JSON-RPC communication
      OpenStdin: true,
      StdinOnce: false,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      HostConfig: {
        SecurityOpt: ['no-new-privileges'],
        Memory: parseMemoryLimit(config.memoryLimit ?? '512m'),
        NanoCpus: Math.floor((config.cpuLimit ?? 1) * 1e9),
      },
      Labels: {
        'secureclaw.type': 'mcp',
        'secureclaw.server': serverName,
      },
    };

    if (hasNetwork) {
      // Network-enabled: needs NET_ADMIN for iptables, starts as root.
      // Entrypoint sets iptables rules then drops to non-root user.
      containerConfig.User = '0';
      containerConfig.NetworkDisabled = false;
      containerConfig.HostConfig!.CapAdd = ['NET_ADMIN', 'SETUID', 'SETGID'];
      containerConfig.HostConfig!.CapDrop = ['ALL'];
      containerConfig.HostConfig!.Binds = [];
    } else {
      // No-network: strict sandboxing identical to shell executor.
      containerConfig.User = '1000';
      containerConfig.NetworkDisabled = true;
      containerConfig.HostConfig!.CapDrop = ['ALL'];
      containerConfig.HostConfig!.NetworkMode = 'none';
      // Bind mounts for filesystem-based MCP servers
      containerConfig.HostConfig!.Binds = (config.mounts ?? []).map(
        (m: MountConfig) =>
          `${m.hostPath}:${m.containerPath}:${m.readOnly ? 'ro' : 'rw'}`,
      );
    }

    // Create and start the container
    const container = await this.docker.createContainer(containerConfig);
    const containerId = container.id;
    const shortId = containerId.slice(0, 12);
    console.log(`[mcp-container] Created container ${shortId} for ${serverName}`);

    // Attach stdin/stdout/stderr BEFORE starting
    const stream = await container.attach({
      stream: true,
      stdin: true,
      stdout: true,
      stderr: true,
      hijack: true,
    });

    // Demultiplex Docker's multiplexed stream into separate stdout/stderr
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();
    container.modem.demuxStream(stream, stdoutStream, stderrStream);

    // Log stderr for diagnostics
    stderrStream.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        console.log(`[mcp-container] ${serverName} stderr: ${text}`);
      }
    });

    await container.start();
    console.log(`[mcp-container] Started container ${shortId} for ${serverName}`);

    // Get container IP for proxy registration
    let containerIp = '';
    if (hasNetwork && this.proxy) {
      const inspectData = await container.inspect();
      // dockerode types don't expose IPAddress at the top level of NetworkSettings,
      // but Docker's API does return it there. Use a type assertion.
      const networkSettings = inspectData.NetworkSettings as {
        IPAddress?: string;
        Networks?: Record<string, { IPAddress?: string }>;
      };
      containerIp =
        networkSettings?.IPAddress ??
        networkSettings?.Networks?.bridge?.IPAddress ??
        '';

      if (containerIp) {
        this.proxy.registerContainer(
          containerIp,
          serverName,
          config.allowedDomains!,
        );
      } else {
        console.warn(
          `[mcp-container] WARNING: Could not determine IP for ${serverName}. ` +
          'Proxy domain filtering will not work for this container.',
        );
      }
    }

    const info: McpContainerInfo = {
      containerId,
      serverName,
      ip: containerIp,
      stdin: stream, // The raw stream is writable (stdin goes to container)
      stdout: stdoutStream,
      stderr: stderrStream,
      status: 'running',
    };

    this.containers.set(serverName, info);
    this.restartCounts.set(serverName, 0);

    // Start health monitoring
    this.startHealthCheck(serverName);

    return info;
  }

  /**
   * Stop and remove an MCP server container.
   */
  async stopContainer(serverName: string): Promise<void> {
    const info = this.containers.get(serverName);
    if (!info) return;

    console.log(`[mcp-container] Stopping MCP server: ${serverName}`);

    // Stop health check
    const healthCheck = this.healthChecks.get(serverName);
    if (healthCheck) {
      clearInterval(healthCheck);
      this.healthChecks.delete(serverName);
    }

    // Unregister from proxy
    if (info.ip && this.proxy) {
      this.proxy.unregisterContainer(info.ip);
    }

    // Stop and remove the container
    try {
      const container = this.docker.getContainer(info.containerId);
      await container.stop({ t: 5 }).catch(() => {});
      await container.remove({ force: true }).catch(() => {});
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.warn(`[mcp-container] Error stopping ${serverName}: ${error.message}`);
    }

    info.status = 'stopped';
    this.containers.delete(serverName);
    this.configs.delete(serverName);
    this.restartCounts.delete(serverName);

    console.log(`[mcp-container] Stopped MCP server: ${serverName}`);
  }

  /**
   * Stop all MCP containers. Called on Gateway shutdown.
   */
  async stopAll(): Promise<void> {
    const names = [...this.containers.keys()];
    if (names.length === 0) return;

    console.log(`[mcp-container] Stopping ${names.length} MCP server(s)...`);
    await Promise.all(names.map((name) => this.stopContainer(name)));
    console.log('[mcp-container] All MCP servers stopped');
  }

  /**
   * Restart a container after a crash.
   * Re-uses the stored config from the original start.
   */
  async restartContainer(serverName: string): Promise<McpContainerInfo | null> {
    const config = this.configs.get(serverName);
    if (!config) {
      console.error(`[mcp-container] No config found for ${serverName}, cannot restart`);
      return null;
    }

    const count = (this.restartCounts.get(serverName) ?? 0) + 1;
    this.restartCounts.set(serverName, count);

    if (count > MAX_RESTART_ATTEMPTS) {
      console.error(
        `[mcp-container] ${serverName} exceeded max restart attempts (${MAX_RESTART_ATTEMPTS})`,
      );
      return null;
    }

    console.log(
      `[mcp-container] Restarting ${serverName} (attempt ${count}/${MAX_RESTART_ATTEMPTS})`,
    );

    // Clean up the old container
    const oldInfo = this.containers.get(serverName);
    if (oldInfo) {
      if (oldInfo.ip && this.proxy) {
        this.proxy.unregisterContainer(oldInfo.ip);
      }
      try {
        const container = this.docker.getContainer(oldInfo.containerId);
        await container.remove({ force: true }).catch(() => {});
      } catch {
        // Container may already be removed
      }
      this.containers.delete(serverName);
    }

    // Re-store the config (stopContainer deletes it, but we still have it)
    return this.startContainer(config);
  }

  /**
   * Get container info by server name.
   */
  getContainer(serverName: string): McpContainerInfo | undefined {
    return this.containers.get(serverName);
  }

  // -------------------------------------------------------------------------
  // Health Monitoring
  // -------------------------------------------------------------------------

  /**
   * Start periodic health checks for a container.
   * Checks if the container is still running every 30 seconds.
   * On crash: attempts restart up to MAX_RESTART_ATTEMPTS times.
   */
  private startHealthCheck(serverName: string): void {
    // Clear any existing health check
    const existing = this.healthChecks.get(serverName);
    if (existing) clearInterval(existing);

    const interval = setInterval(async () => {
      const info = this.containers.get(serverName);
      if (!info) {
        clearInterval(interval);
        this.healthChecks.delete(serverName);
        return;
      }

      try {
        const container = this.docker.getContainer(info.containerId);
        const data = await container.inspect();

        if (!data.State?.Running) {
          console.warn(
            `[mcp-container] ${serverName} is no longer running ` +
            `(exit code: ${data.State?.ExitCode ?? 'unknown'})`,
          );
          info.status = 'error';

          // Clear this health check before restart (restart starts a new one)
          clearInterval(interval);
          this.healthChecks.delete(serverName);

          // Attempt restart (the onRestart callback is handled by McpManager)
          this.emit('crash', serverName);
        }
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.warn(`[mcp-container] Health check error for ${serverName}: ${error.message}`);
      }
    }, HEALTH_CHECK_INTERVAL_MS);

    this.healthChecks.set(serverName, interval);
  }

  // -------------------------------------------------------------------------
  // Events
  // -------------------------------------------------------------------------

  private crashListeners: Array<(serverName: string) => void> = [];

  /** Register a callback for container crash events. */
  onCrash(listener: (serverName: string) => void): void {
    this.crashListeners.push(listener);
  }

  private emit(event: 'crash', serverName: string): void {
    if (event === 'crash') {
      for (const listener of this.crashListeners) {
        listener(serverName);
      }
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Resolve environment variables for an MCP server.
   *
   * Values set to "from_env" are looked up from process.env.
   * This prevents plaintext secrets in the YAML config file.
   */
  private resolveEnvVars(envConfig: Record<string, string>): string[] {
    const resolved: string[] = [];

    for (const [key, value] of Object.entries(envConfig)) {
      if (value === 'from_env') {
        const envValue = process.env[key];
        if (envValue) {
          resolved.push(`${key}=${envValue}`);
        } else {
          console.warn(
            `[mcp-container] WARNING: env var ${key} set to "from_env" but ` +
            `not found in process.env. Skipping.`,
          );
        }
      } else {
        resolved.push(`${key}=${value}`);
      }
    }

    return resolved;
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Parse a memory limit string (e.g., "512m", "1g") to bytes.
 * Duplicated from dispatcher.ts to avoid tight coupling.
 */
function parseMemoryLimit(limit: string): number {
  const match = limit.match(/^(\d+(?:\.\d+)?)\s*([kmg]?)b?$/i);
  if (!match) {
    console.warn(`[mcp-container] Invalid memory limit "${limit}", using 512m`);
    return 512 * 1024 * 1024;
  }

  const value = parseFloat(match[1]!);
  const unit = (match[2] ?? '').toLowerCase();

  switch (unit) {
    case 'k': return Math.floor(value * 1024);
    case 'm': return Math.floor(value * 1024 * 1024);
    case 'g': return Math.floor(value * 1024 * 1024 * 1024);
    default: return Math.floor(value);
  }
}
