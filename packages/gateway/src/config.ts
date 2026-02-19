/**
 * Configuration loader — reads and validates secureclaw.yaml.
 *
 * Handles:
 * - YAML parsing
 * - ~ → home directory resolution for mount paths
 * - Validation of required fields
 * - Warnings for missing host paths (expected in Docker)
 *
 * Phase 5: Added web executor config, heartbeats, trustedDomains, service config.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse as parseYAML } from 'yaml';

// ---------------------------------------------------------------------------
// Configuration Types
// ---------------------------------------------------------------------------

export interface MountConfig {
  name: string;
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

export interface ExecutorConfig {
  image: string;
  memoryLimit: string;
  cpuLimit: number;
  defaultTimeout: number;
  defaultMaxOutput: number;
}

export interface WebExecutorConfig extends ExecutorConfig {
  allowedDomains: string[];
}

export interface ActionCondition {
  tool: string;
  conditions?: Record<string, string>;
}

export interface HeartbeatConfig {
  name: string;
  schedule: string;
  prompt: string;
  enabled: boolean;
}

export interface OAuthServiceConfig {
  clientId: string;
  clientSecret: string;
  callbackPort: number;
}

export interface SecureClawConfig {
  llm: {
    provider: string;
    model: string;
    maxTokens: number;
    /** Custom API base URL (for LM Studio, Azure OpenAI, etc.). */
    baseURL?: string;
  };
  executors: {
    shell: ExecutorConfig;
    file: ExecutorConfig;
    web: WebExecutorConfig;
  };
  mounts: MountConfig[];
  actionTiers: {
    autoApprove: ActionCondition[];
    notify: ActionCondition[];
    requireApproval: ActionCondition[];
  };
  /** Domains trusted for web browsing (notify tier instead of require-approval). */
  trustedDomains: string[];
  /** Heartbeat schedules. */
  heartbeats: HeartbeatConfig[];
  /** GitHub repos owned by the user (for auto-approve tier). */
  ownGitHubRepos: string[];
  /** OAuth service configurations. */
  oauth?: {
    google?: OAuthServiceConfig;
    github?: OAuthServiceConfig;
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG_PATH = 'config/secureclaw.yaml';

/**
 * Load and validate the SecureClaw configuration file.
 *
 * Resolves ~ to the actual home directory in mount paths.
 * Warns (but does not error) if host paths don't exist, since the
 * Gateway may run inside Docker where host paths aren't visible.
 */
export function loadConfig(configPath?: string): SecureClawConfig {
  const filePath = configPath ?? process.env['SECURECLAW_CONFIG'] ?? DEFAULT_CONFIG_PATH;

  console.log(`[config] Loading configuration from ${filePath}`);

  if (!fs.existsSync(filePath)) {
    throw new Error(`Configuration file not found: ${filePath}`);
  }

  const raw = fs.readFileSync(filePath, 'utf-8');
  const config = parseYAML(raw) as SecureClawConfig;

  // Resolve ~ in mount host paths to the actual home directory
  for (const mount of config.mounts) {
    mount.hostPath = resolveTilde(mount.hostPath);
  }

  // Validate mount host paths (warn only — they may not be visible in Docker)
  for (const mount of config.mounts) {
    if (!fs.existsSync(mount.hostPath)) {
      console.warn(
        `[config] WARNING: Mount host path does not exist: ${mount.hostPath} (${mount.name}).`,
      );
      console.warn(
        `[config]   This is expected when running in Docker. Paths must exist on the Docker host.`,
      );
    }
  }

  // Validate required fields
  if (!config.llm?.model) {
    throw new Error('Configuration missing: llm.model');
  }
  if (!config.executors?.shell?.image) {
    throw new Error('Configuration missing: executors.shell.image');
  }
  if (!config.executors?.file?.image) {
    throw new Error('Configuration missing: executors.file.image');
  }
  if (!config.mounts || config.mounts.length === 0) {
    throw new Error('Configuration missing: at least one mount must be defined');
  }

  // Defaults for Phase 5 fields
  if (!config.executors.web) {
    config.executors.web = {
      image: 'secureclaw-executor-web',
      memoryLimit: '1g',
      cpuLimit: 2,
      defaultTimeout: 120,
      defaultMaxOutput: 2097152, // 2MB
      allowedDomains: [],
    };
  }
  if (!config.trustedDomains) {
    config.trustedDomains = [];
  }
  if (!config.heartbeats) {
    config.heartbeats = [];
  }
  if (!config.ownGitHubRepos) {
    config.ownGitHubRepos = [];
  }

  console.log(`[config] Configuration loaded:`);
  console.log(`[config]   LLM model: ${config.llm.model}`);
  console.log(`[config]   Mounts: ${config.mounts.map((m) => `${m.name} (${m.hostPath} → ${m.containerPath}${m.readOnly ? ', ro' : ''})`).join(', ')}`);
  console.log(`[config]   Shell executor: ${config.executors.shell.image} (timeout=${config.executors.shell.defaultTimeout}s, mem=${config.executors.shell.memoryLimit})`);
  console.log(`[config]   File executor: ${config.executors.file.image} (timeout=${config.executors.file.defaultTimeout}s, mem=${config.executors.file.memoryLimit})`);
  console.log(`[config]   Web executor: ${config.executors.web.image} (timeout=${config.executors.web.defaultTimeout}s, domains=${config.executors.web.allowedDomains.length})`);
  console.log(`[config]   Trusted domains: ${config.trustedDomains.length > 0 ? config.trustedDomains.join(', ') : '(none)'}`);
  console.log(`[config]   Heartbeats: ${config.heartbeats.length} (${config.heartbeats.filter((h) => h.enabled).length} enabled)`);

  return config;
}

/**
 * Resolve ~ or ~/ at the start of a path to the home directory.
 *
 * When running in Docker, os.homedir() returns the container user's home
 * (e.g., /home/app), but mount hostPaths must reference the Docker HOST
 * filesystem. The HOST_HOME env var (set in docker-compose.yml) provides
 * the host machine's actual home directory for correct resolution.
 */
function resolveTilde(filePath: string): string {
  if (filePath === '~') {
    return getHomeDir();
  }
  if (filePath.startsWith('~/')) {
    return path.join(getHomeDir(), filePath.slice(2));
  }
  return filePath;
}

function getHomeDir(): string {
  return process.env['HOST_HOME'] ?? os.homedir();
}
