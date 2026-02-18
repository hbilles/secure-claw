/**
 * Approval Store — SQLite-based queue for HITL approval requests.
 *
 * Stores pending approval records so they survive process restarts.
 * Runs a periodic expiry check to auto-reject stale approvals.
 *
 * Database location: /data/approvals.db (same Docker volume as audit logs).
 */

import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PendingApproval {
  id: string;
  sessionId: string;
  toolName: string;
  toolInput: string;           // JSON string of tool call arguments
  capability: string;          // JSON string of the capability that would be issued
  reason: string;              // LLM's explanation of why it wants to do this
  planContext?: string | null;  // What the agent is trying to accomplish overall
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: string;           // ISO 8601
  resolvedAt?: string | null;
  telegramMessageId?: string | null;
  telegramChatId?: string | null;
}

export type CreateApprovalInput = Omit<PendingApproval, 'status' | 'resolvedAt'>;

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

const DEFAULT_DB_PATH = '/data/approvals.db';
const DEFAULT_EXPIRY_INTERVAL_MS = 60_000;     // Check every 60 seconds
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;      // 5 minutes

export class ApprovalStore {
  private db: Database.Database;
  private expiryTimer: ReturnType<typeof setInterval> | null = null;

  private stmtInsert: Database.Statement;
  private stmtResolve: Database.Statement;
  private stmtGetById: Database.Statement;
  private stmtExpire: Database.Statement;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.createSchema();

    // Prepare statements for performance
    this.stmtInsert = this.db.prepare(`
      INSERT INTO pending_approvals
        (id, session_id, tool_name, tool_input, capability, reason,
         plan_context, status, created_at, telegram_message_id, telegram_chat_id)
      VALUES
        (@id, @sessionId, @toolName, @toolInput, @capability, @reason,
         @planContext, 'pending', @createdAt, @telegramMessageId, @telegramChatId)
    `);

    this.stmtResolve = this.db.prepare(`
      UPDATE pending_approvals
      SET status = @status, resolved_at = @resolvedAt
      WHERE id = @id
    `);

    this.stmtGetById = this.db.prepare(`
      SELECT
        id,
        session_id       AS sessionId,
        tool_name        AS toolName,
        tool_input       AS toolInput,
        capability,
        reason,
        plan_context     AS planContext,
        status,
        created_at       AS createdAt,
        resolved_at      AS resolvedAt,
        telegram_message_id AS telegramMessageId,
        telegram_chat_id    AS telegramChatId
      FROM pending_approvals
      WHERE id = ?
    `);

    this.stmtExpire = this.db.prepare(`
      UPDATE pending_approvals
      SET status = 'expired', resolved_at = @resolvedAt
      WHERE status = 'pending' AND created_at < @cutoff
    `);

    console.log(`[approval-store] Database initialized at ${dbPath}`);
  }

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pending_approvals (
        id                  TEXT PRIMARY KEY,
        session_id          TEXT NOT NULL,
        tool_name           TEXT NOT NULL,
        tool_input          TEXT NOT NULL,
        capability          TEXT NOT NULL,
        reason              TEXT NOT NULL,
        plan_context        TEXT,
        status              TEXT DEFAULT 'pending',
        created_at          TEXT NOT NULL,
        resolved_at         TEXT,
        telegram_message_id TEXT,
        telegram_chat_id    TEXT
      )
    `);
  }

  /** Insert a new pending approval. */
  create(input: CreateApprovalInput): PendingApproval {
    this.stmtInsert.run({
      id: input.id,
      sessionId: input.sessionId,
      toolName: input.toolName,
      toolInput: input.toolInput,
      capability: input.capability,
      reason: input.reason,
      planContext: input.planContext ?? null,
      createdAt: input.createdAt,
      telegramMessageId: input.telegramMessageId ?? null,
      telegramChatId: input.telegramChatId ?? null,
    });

    return { ...input, status: 'pending', resolvedAt: null };
  }

  /** Mark an approval as approved, rejected, or expired. */
  resolve(id: string, status: 'approved' | 'rejected' | 'expired'): void {
    this.stmtResolve.run({
      id,
      status,
      resolvedAt: new Date().toISOString(),
    });
  }

  /** Look up an approval by ID. */
  getById(id: string): PendingApproval | undefined {
    return this.stmtGetById.get(id) as PendingApproval | undefined;
  }

  /**
   * Expire all pending approvals older than maxAgeMs.
   * Returns the number of records expired.
   */
  expireStalePending(maxAgeMs: number = DEFAULT_MAX_AGE_MS): number {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const result = this.stmtExpire.run({
      resolvedAt: new Date().toISOString(),
      cutoff,
    });
    return result.changes;
  }

  /**
   * Start periodic expiry checks.
   * Returns expired approval IDs so callers can notify bridges.
   */
  startExpiryCheck(
    intervalMs: number = DEFAULT_EXPIRY_INTERVAL_MS,
    maxAgeMs: number = DEFAULT_MAX_AGE_MS,
    onExpired?: (count: number) => void,
  ): void {
    this.expiryTimer = setInterval(() => {
      const expired = this.expireStalePending(maxAgeMs);
      if (expired > 0) {
        console.log(`[approval-store] Expired ${expired} stale approval(s)`);
        onExpired?.(expired);
      }
    }, intervalMs);

    if (this.expiryTimer.unref) {
      this.expiryTimer.unref();
    }
  }

  /** Get recent approvals (for the dashboard). */
  getRecent(limit: number = 50): PendingApproval[] {
    return this.db.prepare(`
      SELECT
        id,
        session_id       AS sessionId,
        tool_name        AS toolName,
        tool_input       AS toolInput,
        capability,
        reason,
        plan_context     AS planContext,
        status,
        created_at       AS createdAt,
        resolved_at      AS resolvedAt,
        telegram_message_id AS telegramMessageId,
        telegram_chat_id    AS telegramChatId
      FROM pending_approvals
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as PendingApproval[];
  }

  /** Close the database and stop the expiry timer. */
  close(): void {
    if (this.expiryTimer) {
      clearInterval(this.expiryTimer);
      this.expiryTimer = null;
    }
    this.db.close();
  }
}
