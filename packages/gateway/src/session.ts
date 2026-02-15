/**
 * In-memory session manager.
 *
 * - Keyed by userId
 * - Keeps the last 20 message pairs (40 messages) per session
 * - Expires sessions after 1 hour of inactivity
 * - Cleanup interval runs every 5 minutes
 */

import { randomUUID } from 'node:crypto';
import type { Session } from '@secureclaw/shared';

const MAX_MESSAGE_PAIRS = 20;
const MAX_MESSAGES = MAX_MESSAGE_PAIRS * 2;
const SESSION_TTL_MS = 60 * 60 * 1000;       // 1 hour
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;   // 5 minutes

export class SessionManager {
  private sessions: Map<string, Session> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
    // Allow the process to exit even if the timer is still running
    if (this.cleanupTimer.unref) {
      this.cleanupTimer.unref();
    }
  }

  /** Get an existing session or create a new one for the given userId. */
  getOrCreate(userId: string): Session {
    let session = this.sessions.get(userId);
    if (!session) {
      session = {
        id: randomUUID(),
        userId,
        messages: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.sessions.set(userId, session);
      console.log(`[session] Created new session ${session.id} for user ${userId}`);
    }
    return session;
  }

  /** Append a message to the user's session and trim to max length. */
  append(userId: string, role: 'user' | 'assistant', content: string): Session {
    const session = this.getOrCreate(userId);
    session.messages.push({ role, content });

    // Trim to keep last MAX_MESSAGES messages
    if (session.messages.length > MAX_MESSAGES) {
      session.messages = session.messages.slice(-MAX_MESSAGES);
    }

    session.updatedAt = new Date();
    return session;
  }

  /** Get a session by userId (may be undefined). */
  get(userId: string): Session | undefined {
    return this.sessions.get(userId);
  }

  /** Remove expired sessions. */
  private cleanup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [userId, session] of this.sessions) {
      if (now - session.updatedAt.getTime() > SESSION_TTL_MS) {
        this.sessions.delete(userId);
        removed++;
      }
    }
    if (removed > 0) {
      console.log(`[session] Cleaned up ${removed} expired session(s). Active: ${this.sessions.size}`);
    }
  }

  /** Stop the cleanup timer. */
  dispose(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }
}
