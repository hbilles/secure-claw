/**
 * Audit logger — writes JSONL to daily-rotated files.
 *
 * File pattern: /data/audit/audit-YYYY-MM-DD.jsonl
 * Each line is a JSON-serialized AuditEntry.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AuditEntry } from '@secureclaw/shared';

const DEFAULT_AUDIT_DIR = '/data/audit';

export class AuditLogger {
  private auditDir: string;
  private currentDate: string = '';
  private stream: fs.WriteStream | null = null;

  constructor(auditDir?: string) {
    this.auditDir = auditDir ?? process.env['AUDIT_DIR'] ?? DEFAULT_AUDIT_DIR;
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
    const line = JSON.stringify({
      ...entry,
      timestamp: entry.timestamp.toISOString(),
    });
    this.stream!.write(line + '\n');
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

  /** Convenience: log an error event. */
  logError(sessionId: string, data: Record<string, unknown>): void {
    this.log({
      timestamp: new Date(),
      type: 'error',
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
