/**
 * Audit logger — writes JSONL to daily-rotated files.
 *
 * File pattern: /data/audit/audit-YYYY-MM-DD.jsonl
 * Each line is a JSON-serialized AuditEntry.
 *
 * Phase 2 additions:
 * - tool_call events (when a tool is invoked)
 * - tool_result events (when a tool returns)
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AuditEntry } from '@secureclaw/shared';

const DEFAULT_AUDIT_DIR = '/data/audit';

export class AuditLogger {
  private auditDir: string;
  private currentDate: string = '';
  private stream: fs.WriteStream | null = null;
  private onLog: ((entry: Record<string, unknown>) => void) | null = null;

  constructor(auditDir?: string) {
    this.auditDir = auditDir ?? process.env['AUDIT_DIR'] ?? DEFAULT_AUDIT_DIR;
  }

  /** Register a callback for new log entries (used by dashboard SSE). */
  setOnLog(callback: (entry: Record<string, unknown>) => void): void {
    this.onLog = callback;
  }

  /** Ensure the audit directory exists and open the initial stream. */
  async init(): Promise<void> {
    fs.mkdirSync(this.auditDir, { recursive: true });
    this.ensureStream();
    console.log(`[audit] Writing audit logs to ${this.auditDir}`);
  }

  /** Log an audit entry. */
  log(entry: AuditEntry): void {
    this.ensureStream();
    const serialized = {
      ...entry,
      timestamp: entry.timestamp.toISOString(),
    };
    const line = JSON.stringify(serialized);
    this.stream!.write(line + '\n');

    // Phase 5: Push to dashboard SSE clients
    if (this.onLog) {
      try {
        this.onLog(serialized);
      } catch {
        // Dashboard error — ignore
      }
    }
  }

  /** Convenience: log a message_received event. */
  logMessageReceived(sessionId: string, data: Record<string, unknown>): void {
    this.log({
      timestamp: new Date(),
      type: 'message_received',
      sessionId,
      data,
    });
  }

  /** Convenience: log an llm_request event. */
  logLLMRequest(sessionId: string, data: Record<string, unknown>): void {
    this.log({
      timestamp: new Date(),
      type: 'llm_request',
      sessionId,
      data,
    });
  }

  /** Convenience: log an llm_response event. */
  logLLMResponse(sessionId: string, data: Record<string, unknown>): void {
    this.log({
      timestamp: new Date(),
      type: 'llm_response',
      sessionId,
      data,
    });
  }

  /** Convenience: log a message_sent event. */
  logMessageSent(sessionId: string, data: Record<string, unknown>): void {
    this.log({
      timestamp: new Date(),
      type: 'message_sent',
      sessionId,
      data,
    });
  }

  /** Convenience: log a tool_call event. */
  logToolCall(sessionId: string, data: Record<string, unknown>): void {
    this.log({
      timestamp: new Date(),
      type: 'tool_call',
      sessionId,
      data,
    });
  }

  /** Convenience: log a tool_result event. */
  logToolResult(sessionId: string, data: Record<string, unknown>): void {
    this.log({
      timestamp: new Date(),
      type: 'tool_result',
      sessionId,
      data,
    });
  }

  /** Convenience: log an error event. */
  logError(sessionId: string, data: Record<string, unknown>): void {
    this.log({
      timestamp: new Date(),
      type: 'error',
      sessionId,
      data,
    });
  }

  /** Convenience: log an action classification decision. */
  logActionClassified(sessionId: string, data: Record<string, unknown>): void {
    this.log({
      timestamp: new Date(),
      type: 'action_classified',
      sessionId,
      data,
    });
  }

  /** Convenience: log an approval request. */
  logApprovalRequested(sessionId: string, data: Record<string, unknown>): void {
    this.log({
      timestamp: new Date(),
      type: 'approval_requested',
      sessionId,
      data,
    });
  }

  /** Convenience: log an approval resolution. */
  logApprovalResolved(sessionId: string, data: Record<string, unknown>): void {
    this.log({
      timestamp: new Date(),
      type: 'approval_resolved',
      sessionId,
      data,
    });
  }

  /** Close the current write stream. */
  close(): void {
    if (this.stream) {
      this.stream.end();
      this.stream = null;
    }
  }

  /** Ensure we have a stream open for today's date. */
  private ensureStream(): void {
    const today = this.getDateString();
    if (today !== this.currentDate || !this.stream) {
      // Close the previous stream if date rolled over
      if (this.stream) {
        this.stream.end();
      }
      this.currentDate = today;
      const filePath = path.join(this.auditDir, `audit-${today}.jsonl`);
      this.stream = fs.createWriteStream(filePath, { flags: 'a' });
      this.stream.on('error', (err) => {
        console.error('[audit] Write error:', err.message);
      });
    }
  }

  private getDateString(): string {
    const now = new Date();
    return now.toISOString().split('T')[0]!;
  }
}
