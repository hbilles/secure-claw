/**
 * Memory Store — SQLite-backed persistent memory for SecureClaw.
 *
 * Two memory types:
 * 1. Long-term memories (facts, preferences, project context)
 *    - Full-text search via FTS5
 *    - Upsert on matching topic
 *    - Access tracking (count + last accessed)
 *
 * 2. Task sessions (multi-step task tracking for the Ralph Wiggum loop)
 *    - Stores original request, plan, assumptions, execution log
 *    - Tracks iteration count against max_iterations safety valve
 *
 * Database location: /data/memory.db
 *
 * Phase 4: Initial implementation.
 */

import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryCategory = 'user' | 'project' | 'preference' | 'fact' | 'environment';

export interface Memory {
  id: string;
  category: MemoryCategory;
  topic: string;
  content: string;
  createdAt: string;
  updatedAt: string;
  accessCount: number;
  lastAccessedAt: string | null;
}

export interface MemorySearchResult extends Memory {
  rank: number;
}

export type TaskSessionStatus = 'active' | 'completed' | 'failed' | 'paused';

export interface SessionPlanStep {
  id: number;
  description: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed' | 'skipped';
  result?: string;
}

export interface SessionLogEntry {
  iteration: number;
  step: number;
  action: string;
  result: string;
  timestamp: string;
}

export interface SessionPlan {
  goal: string;
  steps: SessionPlanStep[];
  assumptions: string[];
  log: SessionLogEntry[];
}

export interface TaskSession {
  id: string;
  userId: string;
  status: TaskSessionStatus;
  originalRequest: string;
  plan: SessionPlan | null;
  iteration: number;
  maxIterations: number;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Memory Store
// ---------------------------------------------------------------------------

const DEFAULT_DB_PATH = '/data/memory.db';

export class MemoryStore {
  private db: Database.Database;

  // Prepared statements — created after schema init
  private stmtUpsert!: Database.Statement;
  private stmtSearch!: Database.Statement;
  private stmtGetByCategory!: Database.Statement;
  private stmtGetRecent!: Database.Statement;
  private stmtDeleteById!: Database.Statement;
  private stmtDeleteByTopic!: Database.Statement;
  private stmtGetAll!: Database.Statement;
  private stmtUpdateAccess!: Database.Statement;
  private stmtGetByTopic!: Database.Statement;

  // Session statements
  private stmtSessionInsert!: Database.Statement;
  private stmtSessionUpdate!: Database.Statement;
  private stmtSessionGetActive!: Database.Statement;
  private stmtSessionGetById!: Database.Statement;
  private stmtSessionComplete!: Database.Statement;
  private stmtSessionRecent!: Database.Statement;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.createSchema();
    this.prepareStatements();

    console.log(`[memory] Database initialized at ${dbPath}`);
  }

  // -------------------------------------------------------------------------
  // Schema
  // -------------------------------------------------------------------------

  private createSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id              TEXT PRIMARY KEY,
        category        TEXT NOT NULL,
        topic           TEXT NOT NULL,
        content         TEXT NOT NULL,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        access_count    INTEGER DEFAULT 0,
        last_accessed_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_memories_topic ON memories(topic);
      CREATE INDEX IF NOT EXISTS idx_memories_updated_at ON memories(updated_at);
    `);

    // FTS5 virtual table for full-text search
    // Check if the FTS table already exists before creating
    const ftsExists = this.db.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='memories_fts'`,
    ).get();

    if (!ftsExists) {
      this.db.exec(`
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          topic, content,
          content=memories, content_rowid=rowid
        );

        -- Triggers to keep FTS in sync
        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, topic, content)
          VALUES (new.rowid, new.topic, new.content);
        END;

        CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, topic, content)
          VALUES ('delete', old.rowid, old.topic, old.content);
        END;

        CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, topic, content)
          VALUES ('delete', old.rowid, old.topic, old.content);
          INSERT INTO memories_fts(rowid, topic, content)
          VALUES (new.rowid, new.topic, new.content);
        END;
      `);
    }

    // Sessions table for multi-step task tracking
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS task_sessions (
        id                TEXT PRIMARY KEY,
        user_id           TEXT NOT NULL,
        status            TEXT DEFAULT 'active',
        original_request  TEXT NOT NULL,
        plan              TEXT,
        iteration         INTEGER DEFAULT 0,
        max_iterations    INTEGER DEFAULT 10,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON task_sessions(user_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status ON task_sessions(status);
    `);
  }

  private prepareStatements(): void {
    // Memory statements
    this.stmtGetByTopic = this.db.prepare(`
      SELECT id, category, topic, content, created_at AS createdAt,
             updated_at AS updatedAt, access_count AS accessCount,
             last_accessed_at AS lastAccessedAt
      FROM memories WHERE topic = ? AND category = ?
    `);

    this.stmtUpsert = this.db.prepare(`
      INSERT INTO memories (id, category, topic, content, created_at, updated_at, access_count)
      VALUES (@id, @category, @topic, @content, @now, @now, 0)
      ON CONFLICT(id) DO UPDATE SET
        content = @content,
        updated_at = @now
    `);

    this.stmtSearch = this.db.prepare(`
      SELECT m.id, m.category, m.topic, m.content,
             m.created_at AS createdAt, m.updated_at AS updatedAt,
             m.access_count AS accessCount, m.last_accessed_at AS lastAccessedAt,
             rank
      FROM memories_fts fts
      JOIN memories m ON m.rowid = fts.rowid
      WHERE memories_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `);

    this.stmtGetByCategory = this.db.prepare(`
      SELECT id, category, topic, content,
             created_at AS createdAt, updated_at AS updatedAt,
             access_count AS accessCount, last_accessed_at AS lastAccessedAt
      FROM memories WHERE category = ?
      ORDER BY updated_at DESC
    `);

    this.stmtGetRecent = this.db.prepare(`
      SELECT id, category, topic, content,
             created_at AS createdAt, updated_at AS updatedAt,
             access_count AS accessCount, last_accessed_at AS lastAccessedAt
      FROM memories
      ORDER BY COALESCE(last_accessed_at, updated_at) DESC
      LIMIT ?
    `);

    this.stmtDeleteById = this.db.prepare(`DELETE FROM memories WHERE id = ?`);
    this.stmtDeleteByTopic = this.db.prepare(`DELETE FROM memories WHERE topic = ?`);

    this.stmtGetAll = this.db.prepare(`
      SELECT id, category, topic, content,
             created_at AS createdAt, updated_at AS updatedAt,
             access_count AS accessCount, last_accessed_at AS lastAccessedAt
      FROM memories
      ORDER BY category, updated_at DESC
    `);

    this.stmtUpdateAccess = this.db.prepare(`
      UPDATE memories
      SET access_count = access_count + 1, last_accessed_at = ?
      WHERE id = ?
    `);

    // Session statements
    this.stmtSessionInsert = this.db.prepare(`
      INSERT INTO task_sessions
        (id, user_id, status, original_request, plan, iteration, max_iterations, created_at, updated_at)
      VALUES
        (@id, @userId, 'active', @originalRequest, @plan, 0, @maxIterations, @now, @now)
    `);

    this.stmtSessionUpdate = this.db.prepare(`
      UPDATE task_sessions
      SET plan = @plan, iteration = @iteration, status = @status, updated_at = @now
      WHERE id = @id
    `);

    this.stmtSessionGetActive = this.db.prepare(`
      SELECT id, user_id AS userId, status, original_request AS originalRequest,
             plan, iteration, max_iterations AS maxIterations,
             created_at AS createdAt, updated_at AS updatedAt
      FROM task_sessions
      WHERE user_id = ? AND status = 'active'
      ORDER BY created_at DESC
      LIMIT 1
    `);

    this.stmtSessionGetById = this.db.prepare(`
      SELECT id, user_id AS userId, status, original_request AS originalRequest,
             plan, iteration, max_iterations AS maxIterations,
             created_at AS createdAt, updated_at AS updatedAt
      FROM task_sessions
      WHERE id = ?
    `);

    this.stmtSessionComplete = this.db.prepare(`
      UPDATE task_sessions
      SET status = @status, updated_at = @now
      WHERE id = @id
    `);

    this.stmtSessionRecent = this.db.prepare(`
      SELECT id, user_id AS userId, status, original_request AS originalRequest,
             plan, iteration, max_iterations AS maxIterations,
             created_at AS createdAt, updated_at AS updatedAt
      FROM task_sessions
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
  }

  // -------------------------------------------------------------------------
  // Memory API
  // -------------------------------------------------------------------------

  /**
   * Save a memory. Upserts: if a memory with the same topic+category exists,
   * updates its content; otherwise inserts a new one.
   */
  save(category: MemoryCategory, topic: string, content: string): Memory {
    const existing = this.stmtGetByTopic.get(topic, category) as Memory | undefined;
    const now = new Date().toISOString();

    if (existing) {
      // Update existing memory
      this.db.prepare(`
        UPDATE memories SET content = ?, updated_at = ? WHERE id = ?
      `).run(content, now, existing.id);

      console.log(`[memory] Updated memory: [${category}] ${topic}`);
      return { ...existing, content, updatedAt: now };
    }

    const id = randomUUID();
    this.stmtUpsert.run({ id, category, topic, content, now });
    console.log(`[memory] Saved new memory: [${category}] ${topic}`);

    return {
      id,
      category,
      topic,
      content,
      createdAt: now,
      updatedAt: now,
      accessCount: 0,
      lastAccessedAt: null,
    };
  }

  /**
   * Full-text search over memories.
   * Returns results ranked by FTS5 relevance.
   */
  search(query: string, limit: number = 10): MemorySearchResult[] {
    // FTS5 query: escape special chars and add wildcards for partial matching
    const ftsQuery = query
      .replace(/['"]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 0)
      .map((w) => `"${w}"*`)
      .join(' OR ');

    if (!ftsQuery) return [];

    try {
      const results = this.stmtSearch.all(ftsQuery, limit) as MemorySearchResult[];

      // Update access tracking for retrieved memories
      const now = new Date().toISOString();
      for (const r of results) {
        this.stmtUpdateAccess.run(now, r.id);
      }

      return results;
    } catch {
      // FTS5 query syntax errors are possible with unusual input
      console.warn(`[memory] FTS5 search failed for query: "${query}"`);
      return [];
    }
  }

  /** Get all memories in a category. */
  getByCategory(category: MemoryCategory): Memory[] {
    return this.stmtGetByCategory.all(category) as Memory[];
  }

  /** Get the most recently accessed memories. */
  getRecent(limit: number = 10): Memory[] {
    return this.stmtGetRecent.all(limit) as Memory[];
  }

  /** Get all memories (for the /memories command). */
  getAll(): Memory[] {
    return this.stmtGetAll.all() as Memory[];
  }

  /** Delete a memory by ID. */
  deleteById(id: string): boolean {
    const result = this.stmtDeleteById.run(id);
    return result.changes > 0;
  }

  /** Delete a memory by topic. Returns true if a memory was deleted. */
  deleteByTopic(topic: string): boolean {
    const result = this.stmtDeleteByTopic.run(topic);
    if (result.changes > 0) {
      console.log(`[memory] Deleted memory with topic: ${topic}`);
    }
    return result.changes > 0;
  }

  // -------------------------------------------------------------------------
  // Session API
  // -------------------------------------------------------------------------

  /** Create a new task session. */
  createSession(userId: string, originalRequest: string, maxIterations: number = 10): TaskSession {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.stmtSessionInsert.run({
      id,
      userId,
      originalRequest,
      plan: null,
      maxIterations,
      now,
    });

    console.log(`[memory] Created task session ${id} for user ${userId}`);

    return {
      id,
      userId,
      status: 'active',
      originalRequest,
      plan: null,
      iteration: 0,
      maxIterations,
      createdAt: now,
      updatedAt: now,
    };
  }

  /** Update a task session's plan and iteration. */
  updateSession(id: string, plan: SessionPlan, iteration: number, status: TaskSessionStatus = 'active'): void {
    const now = new Date().toISOString();
    this.stmtSessionUpdate.run({
      id,
      plan: JSON.stringify(plan),
      iteration,
      status,
      now,
    });
  }

  /** Get the active task session for a user. */
  getActiveSession(userId: string): TaskSession | null {
    const row = this.stmtSessionGetActive.get(userId) as
      | (Omit<TaskSession, 'plan'> & { plan: string | null })
      | undefined;

    if (!row) return null;

    return {
      ...row,
      plan: row.plan ? (JSON.parse(row.plan) as SessionPlan) : null,
    };
  }

  /** Get a task session by ID. */
  getSessionById(id: string): TaskSession | null {
    const row = this.stmtSessionGetById.get(id) as
      | (Omit<TaskSession, 'plan'> & { plan: string | null })
      | undefined;

    if (!row) return null;

    return {
      ...row,
      plan: row.plan ? (JSON.parse(row.plan) as SessionPlan) : null,
    };
  }

  /** Mark a session as completed/failed/paused. */
  completeSession(id: string, status: 'completed' | 'failed' | 'paused'): void {
    const now = new Date().toISOString();
    this.stmtSessionComplete.run({ id, status, now });
    console.log(`[memory] Session ${id} → ${status}`);
  }

  /** Get recent sessions for a user. */
  getRecentSessions(userId: string, limit: number = 10): TaskSession[] {
    const rows = this.stmtSessionRecent.all(userId, limit) as Array<
      Omit<TaskSession, 'plan'> & { plan: string | null }
    >;

    return rows.map((row) => ({
      ...row,
      plan: row.plan ? (JSON.parse(row.plan) as SessionPlan) : null,
    }));
  }

  /** Get all recent sessions regardless of user (for the dashboard). */
  getAllRecentSessions(limit: number = 50): TaskSession[] {
    const rows = this.db.prepare(`
      SELECT id, user_id AS userId, status, original_request AS originalRequest,
             plan, iteration, max_iterations AS maxIterations,
             created_at AS createdAt, updated_at AS updatedAt
      FROM task_sessions
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit) as Array<
      Omit<TaskSession, 'plan'> & { plan: string | null }
    >;

    return rows.map((row) => ({
      ...row,
      plan: row.plan ? (JSON.parse(row.plan) as SessionPlan) : null,
    }));
  }

  /** Cancel any active session for a user. Returns the cancelled session ID or null. */
  cancelActiveSession(userId: string): string | null {
    const active = this.getActiveSession(userId);
    if (!active) return null;

    this.completeSession(active.id, 'failed');
    console.log(`[memory] Cancelled active session ${active.id} for user ${userId}`);
    return active.id;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Close the database. */
  close(): void {
    this.db.close();
    console.log('[memory] Database closed');
  }
}
