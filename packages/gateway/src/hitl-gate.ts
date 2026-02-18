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
  toolName: string;
  toolInput: Record<string, unknown>;
  chatId: string;
  reason: string;
  planContext?: string;
}

type SendToBridgeFn = (message: ApprovalRequest | BridgeNotification | ApprovalExpired) => void;

interface PendingDecision {
  resolve: (decision: 'approved' | 'rejected') => void;
  timer: ReturnType<typeof setTimeout>;
  chatId: string;
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

  /**
   * Gate a tool call through the HITL approval system.
   *
   * Returns { proceed: true } if the tool should be executed,
   * or { proceed: false } if the user rejected or the approval expired.
   */
  async gate(params: GateParams): Promise<GateResult> {
    const { sessionId, toolName, toolInput, chatId, reason, planContext } = params;

    // 1. Classify the action
    let tier = classifyAction(toolName, toolInput, this.config);

    // Phase 5: Override for trusted web domains
    // browse_web calls to trusted domains use "notify" tier instead of "require-approval"
    if (toolName === 'browse_web' && tier === 'require-approval') {
      const url = toolInput['url'] as string | undefined;
      if (url && this.isURLTrusted(url)) {
        tier = 'notify';
      }
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
        };
        this.sendToBridge(approvalRequest);

        console.log(`[hitl-gate] Awaiting approval ${approvalId} for ${toolName}`);

        // Await user decision (with timeout)
        const decision = await this.awaitDecision(approvalId, chatId);

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
  resolveApproval(approvalId: string, decision: 'approved' | 'rejected'): void {
    const pending = this.pendingDecisions.get(approvalId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingDecisions.delete(approvalId);
      pending.resolve(decision);
    } else {
      // Decision arrived for a non-pending approval (already expired or resolved)
      console.warn(`[hitl-gate] No pending decision for approval ${approvalId}`);
    }
  }

  /**
   * Check if a URL is on the trusted domains list.
   * Trusted domains use "notify" tier instead of "require-approval" for browse_web.
   */
  private isURLTrusted(url: string): boolean {
    try {
      const parsed = new URL(url);
      const hostname = parsed.hostname.toLowerCase();
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

  /**
   * Create a Promise that resolves when the user makes a decision
   * or rejects when the timeout fires.
   */
  private awaitDecision(approvalId: string, chatId: string): Promise<'approved' | 'rejected'> {
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

      this.pendingDecisions.set(approvalId, { resolve, timer, chatId });
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
