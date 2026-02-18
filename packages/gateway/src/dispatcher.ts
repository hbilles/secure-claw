/**
 * Dispatcher — manages sandboxed executor container lifecycle.
 *
 * IMPORTANT: This module requires access to the Docker socket
 * (/var/run/docker.sock). This is the ONE privileged operation in the
 * entire SecureClaw system. The Gateway needs Docker socket access to
 * create, start, monitor, and remove executor containers.
 * No other component touches Docker directly.
 *
 * Uses `dockerode` to interact with the Docker daemon API.
 *
 * Container lifecycle for each tool execution:
 * 1. Determine executor type from tool call
 * 2. Look up capability policy in config
 * 3. Mint a JWT capability token with appropriate permissions
 * 4. Create a Docker container with strict security constraints
 * 5. Start the container
 * 6. Wait for exit (with timeout enforcement — kill if exceeds limit)
 * 7. Read stdout as JSON result
 * 8. Remove the container
 * 9. Return the result to the orchestrator
 */

import Docker from 'dockerode';
import { mintCapabilityToken } from '@secureclaw/shared';
import type { Capability, Mount, ExecutorResult } from '@secureclaw/shared';
import type { SecureClawConfig, MountConfig, WebExecutorConfig } from './config.js';

export type { ExecutorResult };

export interface TaskPayload {
  [key: string]: unknown;
}

export class Dispatcher {
  private docker: Docker;
  private config: SecureClawConfig;
  private capabilitySecret: string;

  constructor(config: SecureClawConfig) {
    // Connect to the Docker daemon via the Unix socket.
    // ⚠️  This is the single point of privilege in the system.
    // The gateway must have /var/run/docker.sock mounted to function.
    this.docker = new Docker({ socketPath: '/var/run/docker.sock' });
    this.config = config;

    const secret = process.env['CAPABILITY_SECRET'];
    if (!secret) {
      throw new Error('CAPABILITY_SECRET environment variable is required');
    }
    this.capabilitySecret = secret;
  }

  /**
   * Execute a task in a sandboxed Docker container.
   *
   * Security constraints applied to every container:
   * - --cap-drop=ALL (no Linux capabilities) — except web executor (needs NET_ADMIN temporarily)
   * - --security-opt=no-new-privileges
   * - Runs as non-root (UID 1000)
   * - --network=none (no network access) — except web executor (HTTPS only)
   * - Memory and CPU limits from config
   * - Only declared mount volumes accessible
   */
  async execute(
    executorType: 'shell' | 'file' | 'web',
    task: TaskPayload,
    mounts?: MountConfig[],
  ): Promise<ExecutorResult> {
    const executorConfig = executorType === 'shell'
      ? this.config.executors.shell
      : executorType === 'file'
        ? this.config.executors.file
        : this.config.executors.web;

    // Web executor doesn't get filesystem mounts (no host filesystem access)
    const mountConfigs = executorType === 'web' ? [] : (mounts ?? this.config.mounts);

    // Build capability object for the token
    const isWeb = executorType === 'web';
    const capability: Capability = {
      executorType,
      mounts: mountConfigs.map((m): Mount => ({
        hostPath: m.hostPath,
        containerPath: m.containerPath,
        readOnly: m.readOnly,
      })),
      network: isWeb
        ? { allowedDomains: (executorConfig as WebExecutorConfig).allowedDomains || [] }
        : 'none',
      timeoutSeconds: executorConfig.defaultTimeout,
      maxOutputBytes: executorConfig.defaultMaxOutput,
    };

    // Mint a short-lived capability token
    const token = mintCapabilityToken(capability, this.capabilitySecret);

    // Encode the task payload as base64 for safe transport via env var
    const taskBase64 = Buffer.from(JSON.stringify(task)).toString('base64');

    // Build Docker container configuration with security constraints
    const containerConfig: Docker.ContainerCreateOptions = {
      Image: executorConfig.image,
      Env: [
        `CAPABILITY_TOKEN=${token}`,
        `TASK=${taskBase64}`,
        `CAPABILITY_SECRET=${this.capabilitySecret}`,
      ],
      WorkingDir: '/workspace',
      HostConfig: {
        // Security: prevent privilege escalation
        SecurityOpt: ['no-new-privileges'],
        // Resource limits
        Memory: parseMemoryLimit(executorConfig.memoryLimit),
        NanoCpus: Math.floor(executorConfig.cpuLimit * 1e9),
      },
    };

    if (isWeb) {
      // Web executor: needs network for HTTPS and NET_ADMIN for iptables setup
      // The entrypoint script sets iptables rules and then drops to non-root
      containerConfig.NetworkDisabled = false;
      containerConfig.User = '0'; // Root for iptables setup; entrypoint drops to node
      containerConfig.HostConfig!.CapAdd = ['NET_ADMIN', 'SETUID', 'SETGID'];
      containerConfig.HostConfig!.CapDrop = ['ALL'];
      // DNS: use Docker's default (mirrors host DNS).
      // The entrypoint's iptables allow DNS (port 53) BEFORE blocking private
      // IPs, so Docker's internal DNS DNAT (127.0.0.11 → 172.x.x.x) works.
      // No filesystem mounts — web executor cannot access host filesystem
      containerConfig.HostConfig!.Binds = [];
    } else {
      // Shell/file executors: strict sandboxing
      containerConfig.User = '1000';
      containerConfig.NetworkDisabled = true;
      containerConfig.HostConfig!.CapDrop = ['ALL'];
      containerConfig.HostConfig!.Binds = mountConfigs.map(
        (m) => `${m.hostPath}:${m.containerPath}:${m.readOnly ? 'ro' : 'rw'}`,
      );
      containerConfig.HostConfig!.NetworkMode = 'none';
    }

    const startTime = Date.now();
    let container: Docker.Container | null = null;

    try {
      // Create the container
      container = await this.docker.createContainer(containerConfig);
      const shortId = container.id.slice(0, 12);
      console.log(`[dispatcher] Created container ${shortId} (${executorType})`);

      // Start the container
      await container.start();
      console.log(`[dispatcher] Started container ${shortId}`);

      // Wait for container to exit with timeout enforcement
      const timeoutMs = executorConfig.defaultTimeout * 1000;
      const exitResult = await this.waitWithTimeout(container, timeoutMs);

      if (exitResult.timedOut) {
        // Container exceeded timeout — kill it
        console.warn(
          `[dispatcher] Container ${shortId} timed out after ${executorConfig.defaultTimeout}s, killing`,
        );
        try {
          await container.kill();
        } catch {
          // May already be stopped
        }
        return {
          success: false,
          exitCode: -1,
          stdout: '',
          stderr: `Execution timed out after ${executorConfig.defaultTimeout} seconds`,
          durationMs: Date.now() - startTime,
          error: 'timeout',
        };
      }

      // Read container output (stdout + stderr are multiplexed)
      const rawLogs = await container.logs({
        stdout: true,
        stderr: true,
        follow: false,
      });

      const output = demuxDockerLogs(rawLogs as unknown as Buffer);
      const durationMs = Date.now() - startTime;

      console.log(
        `[dispatcher] Container ${shortId} exited with code ${exitResult.statusCode} in ${durationMs}ms`,
      );

      // Log stderr for debugging (entrypoint messages and errors)
      if (output.stderr.trim()) {
        console.log(`[dispatcher] Container ${shortId} stderr: ${output.stderr.trim()}`);
      }

      // Log raw stdout for debugging
      if (output.stdout.trim()) {
        console.log(`[dispatcher] Container ${shortId} stdout: ${output.stdout.trim().slice(0, 500)}`);
      }

      // Parse stdout as JSON result from the executor
      try {
        const result = JSON.parse(output.stdout.trim()) as ExecutorResult;
        result.durationMs = durationMs;
        return result;
      } catch {
        // If stdout isn't valid JSON, wrap raw output
        return {
          success: exitResult.statusCode === 0,
          exitCode: exitResult.statusCode,
          stdout: output.stdout,
          stderr: output.stderr,
          durationMs,
          error: exitResult.statusCode !== 0 ? 'non-zero exit code' : undefined,
        };
      }

    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[dispatcher] Executor error:`, error.message);
      return {
        success: false,
        exitCode: -1,
        stdout: '',
        stderr: error.message,
        durationMs: Date.now() - startTime,
        error: error.message,
      };
    } finally {
      // Always clean up the container
      if (container) {
        try {
          await container.remove({ force: true });
          console.log(`[dispatcher] Removed container ${container.id.slice(0, 12)}`);
        } catch {
          // Container may already be removed
        }
      }
    }
  }

  /**
   * Wait for a container to exit, with a hard timeout.
   * If the container doesn't exit within timeoutMs, returns timedOut: true.
   */
  private async waitWithTimeout(
    container: Docker.Container,
    timeoutMs: number,
  ): Promise<{ timedOut: boolean; statusCode: number }> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolve({ timedOut: true, statusCode: -1 });
      }, timeoutMs);

      container.wait()
        .then((data: { StatusCode: number }) => {
          clearTimeout(timer);
          resolve({ timedOut: false, statusCode: data.StatusCode });
        })
        .catch(() => {
          clearTimeout(timer);
          resolve({ timedOut: true, statusCode: -1 });
        });
    });
  }

  /**
   * Check if the Docker daemon is accessible.
   * Useful for startup validation.
   */
  async ping(): Promise<boolean> {
    try {
      await this.docker.ping();
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse memory limit string (e.g., "512m", "1g", "256k") to bytes.
 */
function parseMemoryLimit(limit: string): number {
  const match = limit.match(/^(\d+)([mgk]?)$/i);
  if (!match) {
    throw new Error(`Invalid memory limit format: ${limit}`);
  }
  const value = parseInt(match[1]!, 10);
  const unit = (match[2] ?? '').toLowerCase();
  switch (unit) {
    case 'g': return value * 1024 * 1024 * 1024;
    case 'm': return value * 1024 * 1024;
    case 'k': return value * 1024;
    default: return value;
  }
}

/**
 * Demux Docker multiplexed stream output.
 *
 * Docker multiplexes stdout and stderr into a single stream with an
 * 8-byte header per frame:
 *   - Byte 0: stream type (1=stdout, 2=stderr)
 *   - Bytes 1-3: padding (zero)
 *   - Bytes 4-7: frame size (big-endian uint32)
 *   - Remaining: frame payload
 */
function demuxDockerLogs(buffer: Buffer | string): { stdout: string; stderr: string } {
  if (typeof buffer === 'string') {
    return { stdout: buffer, stderr: '' };
  }

  let stdout = '';
  let stderr = '';
  let offset = 0;

  while (offset < buffer.length) {
    // Need at least 8 bytes for the header
    if (offset + 8 > buffer.length) break;

    const streamType = buffer[offset]!; // 1=stdout, 2=stderr
    const size = buffer.readUInt32BE(offset + 4);
    offset += 8;

    if (offset + size > buffer.length) break;

    const chunk = buffer.subarray(offset, offset + size).toString('utf-8');

    if (streamType === 1) {
      stdout += chunk;
    } else if (streamType === 2) {
      stderr += chunk;
    }

    offset += size;
  }

  return { stdout, stderr };
}
