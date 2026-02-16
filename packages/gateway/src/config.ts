/**
 * Configuration loader — reads and validates secureclaw.yaml.
 *
 * Handles:
 * - YAML parsing
 * - ~ → home directory resolution for mount paths
 * - Validation of required fields
 * - Warnings for missing host paths (expected in Docker)
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

export interface ActionCondition {
  tool: string;
  conditions?: Record<string, string>;
}

export interface SecureClawConfig {
  llm: {
    provider: string;
    model: string;
    maxTokens: number;
  };
  executors: {
    shell: ExecutorConfig;
    file: ExecutorConfig;
  };
  mounts: MountConfig[];
  actionTiers: {
    autoApprove: ActionCondition[];
    notify: ActionCondition[];
    requireApproval: ActionCondition[];
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

  console.log(`[config] Configuration loaded:`);
  console.log(`[config]   LLM model: ${config.llm.model}`);
  console.log(`[config]   Mounts: ${config.mounts.map((m) => `${m.name} (${m.hostPath} → ${m.containerPath}${m.readOnly ? ', ro' : ''})`).join(', ')}`);
  console.log(`[config]   Shell executor: ${config.executors.shell.image} (timeout=${config.executors.shell.defaultTimeout}s, mem=${config.executors.shell.memoryLimit})`);
  console.log(`[config]   File executor: ${config.executors.file.image} (timeout=${config.executors.file.defaultTimeout}s, mem=${config.executors.file.memoryLimit})`);

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
