/**
 * HITL Gate — Human-in-the-Loop approval gate.
 *
 * Sits between the orchestrator and dispatcher. For each tool call:
 * 1. Classifies the action into a tier (auto-approve / notify / require-approval)
 * 2. Auto-approve: returns immediately, orchestrator proceeds
 * 3. Notify: returns immediately + sends informational message to user
 * 4. Require-approval: pauses execution, sends approval request with inline
 *    buttons, awaits user decision (or timeout), then resumes or rejects
 *
 * The gate does NOT execute tools — it only decides whether execution should
 * proceed. The orchestrator handles actual dispatching.
 */

import { randomUUID } from 'node:crypto';
import { classifyAction } from './classifier.js';
import type { ApprovalStore } from './approval-store.js';
import type { AuditLogger } from './audit.js';
import type { SecureClawConfig } from './config.js';
import type { DomainManager } from './domain-manager.js';
import type { ActionTier, ApprovalRequest, BridgeNotification, ApprovalExpired } from '@secureclaw/shared';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface GateResult {
  tier: ActionTier;
  proceed: boolean;
  approvalId?: string;
}

export interface GateParams {
  sessionId: string;
  userId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  chatId: string;
  reason: string;
  planContext?: string;
  /** Optional metadata passed through to the approval request (e.g., domain-request info). */
  metadata?: {
    type?: 'domain-request';
    domain?: string;
  };
}

type SendToBridgeFn = (message: ApprovalRequest | BridgeNotification | ApprovalExpired) => void;

interface PendingDecision {
  resolve: (decision: 'approved' | 'rejected') => void;
  timer: ReturnType<typeof setTimeout>;
  chatId: string;
  userId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

/** A session-scoped permission grant that auto-approves matching future actions. */
interface SessionGrant {
  toolName: string;
  /** Normalized key: domain for browse_web, dir prefix for write_file, '*' for generic */
  patternKey: string;
  grantedAt: Date;
  approvalId: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

// ---------------------------------------------------------------------------
// HITLGate
// ---------------------------------------------------------------------------

export class HITLGate {
  private approvalStore: ApprovalStore;
  private auditLogger: AuditLogger;
  private config: SecureClawConfig;
  private sendToBridge: SendToBridgeFn;

  /** Map of approval ID → pending promise resolver + timeout */
  private pendingDecisions: Map<string, PendingDecision> = new Map();

  /** Session-scoped permission grants: Map<userId, SessionGrant[]> */
  private sessionGrants: Map<string, SessionGrant[]> = new Map();

  /** Optional DomainManager for dynamic trusted domain checks. */
  private domainManager: DomainManager | null = null;

  constructor(
    approvalStore: ApprovalStore,
    auditLogger: AuditLogger,
    config: SecureClawConfig,
    sendToBridge: SendToBridgeFn,
  ) {
    this.approvalStore = approvalStore;
    this.auditLogger = auditLogger;
    this.config = config;
    this.sendToBridge = sendToBridge;
  }

  /** Attach domain manager for dynamic trusted domain resolution. */
  setDomainManager(domainManager: DomainManager): void {
    this.domainManager = domainManager;
  }

  /**
   * Gate a tool call through the HITL approval system.
   *
   * Returns { proceed: true } if the tool should be executed,
   * or { proceed: false } if the user rejected or the approval expired.
   */
  async gate(params: GateParams): Promise<GateResult> {
    const { sessionId, userId, toolName, toolInput, chatId, reason, planContext, metadata } = params;

    // 1. Classify the action
    let tier = classifyAction(toolName, toolInput, this.config);

    // Phase 5: Override for trusted web domains
    // browse_web calls to trusted domains use "notify" tier instead of "require-approval"
    if (toolName === 'browse_web' && tier === 'require-approval') {
      const url = toolInput['url'] as string | undefined;
      if (url && this.isURLTrusted(url, userId)) {
        tier = 'notify';
      }
    }

    // Session grant override: if a matching session grant exists, downgrade to notify
    if (tier === 'require-approval' && this.checkSessionGrant(userId, toolName, toolInput)) {
      tier = 'notify';
      console.log(`[hitl-gate] Session grant matched for ${toolName}, downgrading to notify`);
    }

    // 2. Audit the classification decision
    this.auditLogger.logActionClassified(sessionId, {
      toolName,
      toolInput,
      tier,
    });

    console.log(`[hitl-gate] Classified ${toolName} → ${tier}`);

    // 3. Handle based on tier
    switch (tier) {
      case 'auto-approve':
        return { tier, proceed: true };

      case 'notify': {
        // Send informational notification to the user
        const notifyMessage: BridgeNotification = {
          type: 'notification',
          chatId,
          text: `ℹ️ ${toolName}: ${summarizeAction(toolName, toolInput)}`,
        };
        this.sendToBridge(notifyMessage);

        return { tier, proceed: true };
      }

      case 'require-approval': {
        const approvalId = randomUUID();

        // Create persistent approval record
        this.approvalStore.create({
          id: approvalId,
          sessionId,
          toolName,
          toolInput: JSON.stringify(toolInput),
          capability: JSON.stringify({}),
          reason,
          planContext: planContext ?? null,
          createdAt: new Date().toISOString(),
          telegramChatId: chatId,
        });

        // Audit the request
        this.auditLogger.logApprovalRequested(sessionId, {
          approvalId,
          toolName,
          toolInput,
          reason,
        });

        // Send approval request to bridge (Telegram inline buttons)
        const approvalRequest: ApprovalRequest = {
          type: 'approval-request',
          approvalId,
          toolName,
          toolInput,
          reason,
          planContext,
          chatId,
          metadata,
        };
        this.sendToBridge(approvalRequest);

        console.log(`[hitl-gate] Awaiting approval ${approvalId} for ${toolName}`);

        // Await user decision (with timeout)
        const decision = await this.awaitDecision(approvalId, chatId, userId, toolName, toolInput);

        // Update store and audit
        this.approvalStore.resolve(approvalId, decision === 'approved' ? 'approved' : 'rejected');

        this.auditLogger.logApprovalResolved(sessionId, {
          approvalId,
          decision,
          toolName,
        });

        console.log(`[hitl-gate] Approval ${approvalId} → ${decision}`);

        return {
          tier,
          proceed: decision === 'approved',
          approvalId,
        };
      }
    }
  }

  /**
   * Called when an approval decision arrives from the bridge.
   * Resolves the pending promise so the orchestrator can resume.
   */
  resolveApproval(approvalId: string, decision: 'approved' | 'rejected' | 'session-approved'): void {
    const pending = this.pendingDecisions.get(approvalId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingDecisions.delete(approvalId);

      if (decision === 'session-approved') {
        // Store a session grant so future matching actions auto-proceed
        const patternKey = this.extractPatternKey(pending.toolName, pending.toolInput);
        const grants = this.sessionGrants.get(pending.userId) ?? [];
        grants.push({
          toolName: pending.toolName,
          patternKey,
          grantedAt: new Date(),
          approvalId,
        });
        this.sessionGrants.set(pending.userId, grants);
        console.log(
          `[hitl-gate] Session grant stored: user=${pending.userId} tool=${pending.toolName} key=${patternKey}`,
        );
        // Resolve as approved so the current action proceeds
        pending.resolve('approved');
      } else {
        pending.resolve(decision);
      }
    } else {
      // Decision arrived for a non-pending approval (already expired or resolved)
      console.warn(`[hitl-gate] No pending decision for approval ${approvalId}`);
    }
  }

  /**
   * Check if a URL is on the trusted domains list.
   * Trusted domains use "notify" tier instead of "require-approval" for browse_web.
   *
   * Delegates to DomainManager if available (includes session-approved domains),
   * otherwise falls back to static config check.
   */
  private isURLTrusted(url: string, userId?: string): boolean {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();

      // Prefer DomainManager — includes base config + session-approved domains
      if (this.domainManager && userId) {
        return this.domainManager.isDomainTrusted(hostname, userId);
      }

      // Fallback: static config check
      const trustedDomains = this.config.trustedDomains || [];
      for (const domain of trustedDomains) {
        const lowerDomain = domain.toLowerCase();
        if (hostname === lowerDomain || hostname.endsWith(`.${lowerDomain}`)) {
          return true;
        }
      }
    } catch {
      // Invalid URL — not trusted
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Session Grant Management
  // -------------------------------------------------------------------------

  /**
   * Extract a normalized pattern key for session grant matching.
   *
   * - browse_web: hostname from URL (e.g., "github.com")
   * - write_file: directory prefix from path (e.g., "/sandbox")
   * - run_shell_command: working_directory prefix
   * - Default: '*' (matches all uses of the tool)
   */
  private extractPatternKey(toolName: string, toolInput: Record<string, unknown>): string {
    switch (toolName) {
      case 'browse_web': {
        const url = toolInput['url'] as string | undefined;
        if (url) {
          try {
            return new URL(url).hostname.toLowerCase();
          } catch {
            return '*';
          }
        }
        return '*';
      }
      case 'write_file': {
        const path = toolInput['path'] as string | undefined;
        if (path) {
          // Extract the first two path segments as the directory prefix
          const parts = path.split('/');
          return parts.length >= 2 ? `/${parts[1]}` : '*';
        }
        return '*';
      }
      case 'run_shell_command': {
        const wd = toolInput['working_directory'] as string | undefined;
        if (wd) {
          const parts = wd.split('/');
          return parts.length >= 2 ? `/${parts[1]}` : '*';
        }
        return '*';
      }
      default:
        return '*';
    }
  }

  /**
   * Check if a matching session grant exists for this action.
   */
  private checkSessionGrant(
    userId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): boolean {
    const grants = this.sessionGrants.get(userId);
    if (!grants || grants.length === 0) return false;

    const patternKey = this.extractPatternKey(toolName, toolInput);

    return grants.some(
      (g) =>
        g.toolName === toolName &&
        (g.patternKey === '*' || g.patternKey === patternKey),
    );
  }

  /**
   * Clear all session grants for a user (called on session expiry).
   */
  clearSessionGrants(userId: string): void {
    const had = this.sessionGrants.delete(userId);
    if (had) {
      console.log(`[hitl-gate] Cleared session grants for user ${userId}`);
    }
  }

  // -------------------------------------------------------------------------
  // Approval Waiting
  // -------------------------------------------------------------------------

  /**
   * Create a Promise that resolves when the user makes a decision
   * or rejects when the timeout fires.
   */
  private awaitDecision(
    approvalId: string,
    chatId: string,
    userId: string,
    toolName: string,
    toolInput: Record<string, unknown>,
  ): Promise<'approved' | 'rejected'> {
    return new Promise<'approved' | 'rejected'>((resolve) => {
      const timer = setTimeout(() => {
        // Timeout — auto-reject
        this.pendingDecisions.delete(approvalId);
        this.approvalStore.resolve(approvalId, 'expired');

        // Notify bridge to update the Telegram message
        const expiredMsg: ApprovalExpired = {
          type: 'approval-expired',
          approvalId,
          chatId,
        };
        this.sendToBridge(expiredMsg);

        console.log(`[hitl-gate] Approval ${approvalId} expired after timeout`);
        resolve('rejected');
      }, APPROVAL_TIMEOUT_MS);

      // Allow the process to exit even if the timer is still running
      if (timer.unref) {
        timer.unref();
      }

      this.pendingDecisions.set(approvalId, { resolve, timer, chatId, userId, toolName, toolInput });
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Generate a human-readable summary of a tool action for notifications. */
function summarizeAction(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case 'write_file':
      return `Writing to ${toolInput['path'] ?? 'unknown path'}`;
    case 'read_file':
      return `Reading ${toolInput['path'] ?? 'unknown path'}`;
    case 'list_directory':
      return `Listing ${toolInput['path'] ?? 'unknown path'}`;
    case 'search_files':
      return `Searching in ${toolInput['path'] ?? '.'} for "${toolInput['pattern'] ?? ''}"`;
    case 'run_shell_command': {
      const cmd = String(toolInput['command'] ?? '');
      return `Running: ${cmd.length > 80 ? cmd.slice(0, 80) + '…' : cmd}`;
    }
    // Phase 5: Web browsing
    case 'browse_web':
      return `Browsing: ${toolInput['url'] ?? 'unknown URL'} (${toolInput['action'] ?? 'navigate'})`;
    // Phase 5: Gmail
    case 'search_email':
      return `Searching email: "${toolInput['query'] ?? ''}"`;
    case 'read_email':
      return `Reading email: ${toolInput['id'] ?? 'unknown'}`;
    case 'send_email':
      return `Sending email to ${toolInput['to'] ?? 'unknown'}: "${toolInput['subject'] ?? ''}"`;
    case 'reply_email':
      return `Replying to email ${toolInput['id'] ?? 'unknown'}`;
    // Phase 5: Calendar
    case 'list_events':
      return `Listing calendar events`;
    case 'create_event':
      return `Creating event: "${toolInput['summary'] ?? ''}"`;
    case 'update_event':
      return `Updating event ${toolInput['id'] ?? 'unknown'}`;
    // Phase 5: GitHub
    case 'search_repos':
      return `Searching GitHub repos: "${toolInput['query'] ?? ''}"`;
    case 'list_issues':
      return `Listing issues for ${toolInput['repo'] ?? 'unknown'}`;
    case 'create_issue':
      return `Creating issue in ${toolInput['repo'] ?? 'unknown'}: "${toolInput['title'] ?? ''}"`;
    case 'create_pr':
      return `Creating PR in ${toolInput['repo'] ?? 'unknown'}: "${toolInput['title'] ?? ''}"`;
    case 'read_file_github':
      return `Reading file from ${toolInput['repo'] ?? 'unknown'}: ${toolInput['path'] ?? 'unknown'}`;
    default:
      return JSON.stringify(toolInput).slice(0, 100);
  }
}
