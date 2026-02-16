/**
 * SecureClaw File Executor
 *
 * Provides a JSON API for file operations, scoped to declared mounts.
 *
 * Behavior:
 * 1. Reads CAPABILITY_TOKEN and TASK from environment
 * 2. Verifies the capability token
 * 3. Parses the task: { operation, params }
 * 4. CRITICAL: Validates all paths fall within declared mounts
 * 5. Executes the operation
 * 6. Returns structured JSON to stdout
 *
 * Operations: list, read, write, search, stat
 *
 * Security:
 * - Path traversal prevention (resolves absolute paths, checks mount boundaries)
 * - Write operations additionally check mount is NOT readOnly
 * - Runs as non-root (UID 1000)
 * - No network access
 */

import { verifyCapabilityToken } from '@secureclaw/shared';
import type { Capability, Mount } from '@secureclaw/shared';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Task {
  operation: string;
  params: Record<string, unknown>;
}

interface Result {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const startTime = Date.now();

  try {
    // Read required environment variables
    const tokenStr = process.env['CAPABILITY_TOKEN'];
    const taskBase64 = process.env['TASK'];
    const secret = process.env['CAPABILITY_SECRET'];

    if (!tokenStr || !taskBase64 || !secret) {
      throw new Error(
        'Missing required environment variables: CAPABILITY_TOKEN, TASK, CAPABILITY_SECRET',
      );
    }

    // Verify the capability token
    const capability = verifyCapabilityToken(tokenStr, secret);

    if (capability.executorType !== 'file') {
      throw new Error(
        `Invalid executor type: expected 'file', got '${capability.executorType}'`,
      );
    }

    // Parse the task from base64-encoded JSON
    const task: Task = JSON.parse(
      Buffer.from(taskBase64, 'base64').toString('utf-8'),
    );

    if (!task.operation) {
      throw new Error('Task missing required field: operation');
    }

    // Execute the file operation
    const resultData = await executeOperation(task, capability);

    const output: Result = {
      success: true,
      exitCode: 0,
      stdout: JSON.stringify(resultData),
      stderr: '',
      durationMs: Date.now() - startTime,
    };

    process.stdout.write(JSON.stringify(output));

  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    const output: Result = {
      success: false,
      error: error.message,
      exitCode: -1,
      stdout: '',
      stderr: error.message,
      durationMs: Date.now() - startTime,
    };
    process.stdout.write(JSON.stringify(output));
  }
}

// ---------------------------------------------------------------------------
// Path Validation
// ---------------------------------------------------------------------------

/**
 * CRITICAL: Validate that a target path falls within one of the declared mounts.
 *
 * Prevents path traversal attacks by:
 * 1. Resolving the path to an absolute path (eliminates ../ sequences)
 * 2. Checking the resolved path starts with a declared mount's containerPath
 *
 * For write operations, additionally checks the mount is NOT readOnly.
 *
 * @throws Error if the path is outside all mounts or mount is read-only
 */
function validatePath(
  targetPath: string,
  mounts: Mount[],
  requireWritable = false,
): Mount {
  // Resolve to absolute path to neutralize ../ traversal attempts
  const resolved = path.resolve(targetPath);

  for (const mount of mounts) {
    const mountPath = path.resolve(mount.containerPath);
    if (resolved === mountPath || resolved.startsWith(mountPath + '/')) {
      if (requireWritable && mount.readOnly) {
        throw new Error(
          `Write access denied: mount '${mount.containerPath}' is read-only`,
        );
      }
      return mount;
    }
  }

  const validPaths = mounts.map((m) => m.containerPath).join(', ');
  throw new Error(
    `Access denied: path '${targetPath}' (resolved: '${resolved}') is not within ` +
    `any mounted directory. Valid mount points: ${validPaths}`,
  );
}

// ---------------------------------------------------------------------------
// File Operations
// ---------------------------------------------------------------------------

async function executeOperation(
  task: Task,
  capability: Capability,
): Promise<unknown> {
  const { operation, params } = task;

  switch (operation) {
    case 'list':
      return opList(params['path'] as string, capability.mounts);

    case 'read':
      return opRead(params['path'] as string, capability.mounts);

    case 'write':
      return opWrite(
        params['path'] as string,
        params['content'] as string,
        capability.mounts,
      );

    case 'search':
      return opSearch(
        params['path'] as string,
        params['pattern'] as string,
        capability.mounts,
      );

    case 'stat':
      return opStat(params['path'] as string, capability.mounts);

    default:
      throw new Error(`Unknown operation: ${operation}`);
  }
}

/** List files and directories at a path. */
function opList(
  targetPath: string,
  mounts: Mount[],
): { entries: Array<{ name: string; type: string; size: number; modified: string | null }> } {
  validatePath(targetPath, mounts);

  const entries = fs.readdirSync(targetPath, { withFileTypes: true });

  return {
    entries: entries.map((entry) => {
      const fullPath = path.join(targetPath, entry.name);
      try {
        const stat = fs.statSync(fullPath);
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: stat.size,
          modified: stat.mtime.toISOString(),
        };
      } catch {
        return {
          name: entry.name,
          type: entry.isDirectory() ? 'directory' : 'file',
          size: 0,
          modified: null,
        };
      }
    }),
  };
}

/** Read the contents of a file. */
function opRead(
  targetPath: string,
  mounts: Mount[],
): { content: string; size: number } {
  validatePath(targetPath, mounts);

  const content = fs.readFileSync(targetPath, 'utf-8');
  const stat = fs.statSync(targetPath);

  return { content, size: stat.size };
}

/** Write content to a file. Requires the mount to be writable. */
function opWrite(
  targetPath: string,
  content: string,
  mounts: Mount[],
): { bytesWritten: number } {
  // requireWritable=true: rejects if mount is readOnly
  validatePath(targetPath, mounts, true);

  // Ensure parent directory exists
  const dir = path.dirname(targetPath);
  fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(targetPath, content, 'utf-8');

  return {
    bytesWritten: Buffer.byteLength(content, 'utf-8'),
  };
}

/** Search for a pattern in files using ripgrep (fallback to Node). */
function opSearch(
  targetPath: string,
  pattern: string,
  mounts: Mount[],
): { matches: Array<{ file: string; line: number; content: string }> } {
  validatePath(targetPath, mounts);

  const matches: Array<{ file: string; line: number; content: string }> = [];

  try {
    // Try ripgrep first — faster and more capable
    const escaped = pattern.replace(/"/g, '\\"');
    const rgOutput = execSync(
      `rg --json "${escaped}" "${targetPath}"`,
      {
        maxBuffer: 5 * 1024 * 1024,
        timeout: 30000,
        encoding: 'utf-8',
      },
    );

    for (const line of rgOutput.split('\n')) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'match') {
          matches.push({
            file: entry.data.path.text,
            line: entry.data.line_number,
            content: entry.data.lines.text.trim(),
          });
        }
      } catch {
        // Skip unparseable lines
      }
    }
  } catch {
    // Fallback: basic recursive search using Node's fs
    searchFilesRecursive(targetPath, new RegExp(pattern), matches);
  }

  return { matches };
}

/** Recursive fallback search when ripgrep is not available. */
function searchFilesRecursive(
  dirPath: string,
  pattern: RegExp,
  matches: Array<{ file: string; line: number; content: string }>,
): void {
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        // Skip hidden directories and node_modules
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
          searchFilesRecursive(fullPath, pattern, matches);
        }
      } else if (entry.isFile()) {
        try {
          const content = fs.readFileSync(fullPath, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            if (pattern.test(lines[i]!)) {
              matches.push({
                file: fullPath,
                line: i + 1,
                content: lines[i]!.trim(),
              });
            }
          }
        } catch {
          // Skip unreadable files (binary, permissions, etc.)
        }
      }
    }
  } catch {
    // Skip unreadable directories
  }
}

/** Get file/directory stat information. */
function opStat(
  targetPath: string,
  mounts: Mount[],
): {
  exists: boolean;
  type: string | null;
  size: number;
  modified: string | null;
  permissions: string | null;
} {
  validatePath(targetPath, mounts);

  try {
    const stat = fs.statSync(targetPath);
    return {
      exists: true,
      type: stat.isDirectory() ? 'directory' : 'file',
      size: stat.size,
      modified: stat.mtime.toISOString(),
      permissions: stat.mode.toString(8),
    };
  } catch {
    return {
      exists: false,
      type: null,
      size: 0,
      modified: null,
      permissions: null,
    };
  }
}

main();
