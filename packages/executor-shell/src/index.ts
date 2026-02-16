/**
 * SecureClaw Shell Executor
 *
 * Minimal container entry point that:
 * 1. Reads CAPABILITY_TOKEN and TASK from environment
 * 2. Verifies the capability token (rejects invalid/expired tokens)
 * 3. Validates the working directory is within a mounted path
 * 4. Spawns the command using /bin/sh (Alpine)
 * 5. Returns structured JSON output to stdout
 *
 * Security:
 * - Runs as non-root (UID 1000)
 * - No Linux capabilities (--cap-drop=ALL)
 * - No network access (--network=none)
 * - Timeout enforced by capability token
 * - Output size limited by maxOutputBytes
 */

import { verifyCapabilityToken } from '@secureclaw/shared';
import { spawn } from 'node:child_process';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Task {
  command: string;
  workingDir?: string;
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

    // Verify the capability token — rejects invalid, expired, or tampered tokens
    const capability = verifyCapabilityToken(tokenStr, secret);

    if (capability.executorType !== 'shell') {
      throw new Error(
        `Invalid executor type: expected 'shell', got '${capability.executorType}'`,
      );
    }

    // Parse the task from base64-encoded JSON
    const task: Task = JSON.parse(
      Buffer.from(taskBase64, 'base64').toString('utf-8'),
    );

    if (!task.command) {
      throw new Error('Task missing required field: command');
    }

    // Validate working directory is within a mounted path
    const workDir = task.workingDir ?? '/workspace';
    const validPaths = capability.mounts.map((m) => m.containerPath);
    const isValidPath = validPaths.some(
      (mp) => workDir === mp || workDir.startsWith(mp + '/'),
    );

    if (!isValidPath) {
      throw new Error(
        `Working directory '${workDir}' is not within any mounted path. ` +
        `Valid paths: ${validPaths.join(', ')}`,
      );
    }

    // Execute the command
    const result = await executeCommand(
      task.command,
      workDir,
      capability.timeoutSeconds * 1000,
      capability.maxOutputBytes,
    );

    const output: Result = {
      success: result.exitCode === 0,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
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
// Command Execution
// ---------------------------------------------------------------------------

function executeCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
  maxOutputBytes: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    const child = spawn('/bin/sh', ['-c', command], {
      cwd,
      timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout.on('data', (data: Buffer) => {
      if (killed) return;
      stdout += data.toString('utf-8');
      // Enforce output size limit
      if (stdout.length > maxOutputBytes) {
        stdout = stdout.slice(0, maxOutputBytes) + '\n[output truncated]';
        killed = true;
        child.kill('SIGKILL');
      }
    });

    child.stderr.on('data', (data: Buffer) => {
      if (killed) return;
      stderr += data.toString('utf-8');
      // Cap stderr too to prevent memory issues
      if (stderr.length > maxOutputBytes) {
        stderr = stderr.slice(0, maxOutputBytes) + '\n[stderr truncated]';
      }
    });

    child.on('close', (code) => {
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
      });
    });

    child.on('error', (err) => {
      resolve({
        exitCode: -1,
        stdout,
        stderr: err.message,
      });
    });
  });
}

main();
