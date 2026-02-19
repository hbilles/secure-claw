/**
 * Ralph Wiggum Loop — multi-step task execution with context resets.
 *
 * For complex tasks that would exceed the LLM's context window, this loop:
 * 1. Creates a task session with the original request
 * 2. Runs the orchestrator with a fresh context each iteration
 * 3. Detects [CONTINUE] markers in the LLM's response
 * 4. Saves session state (plan + progress) between iterations
 * 5. Resets the LLM context completely, rebuilding from session state
 * 6. Continues until [CONTINUE] is absent or max iterations is reached
 *
 * Why this works: By resetting context between iterations, the token budget
 * never grows unboundedly. The session record is a compressed representation
 * of progress — much smaller than the full conversation history.
 *
 * Phase 4: Initial implementation.
 */

import type { Orchestrator } from './orchestrator.js';
import type { MemoryStore, TaskSession, SessionPlan } from './memory.js';
import type { PromptBuilder } from './prompt-builder.js';
import type { AuditLogger } from './audit.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Callback to send progress updates to the user via bridge. */
export type ProgressCallback = (chatId: string, text: string) => void;

export interface LoopResult {
  /** Final text response to send to the user */
  text: string;
  /** Session ID (for reference) */
  sessionId: string;
  /** Whether the task completed fully */
  completed: boolean;
  /** Total iterations used */
  iterations: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const CONTINUE_MARKER = '[CONTINUE]';
const DEFAULT_MAX_ITERATIONS = 10;

// ---------------------------------------------------------------------------
// TaskLoop
// ---------------------------------------------------------------------------

export class TaskLoop {
  private orchestrator: Orchestrator;
  private memoryStore: MemoryStore;
  private promptBuilder: PromptBuilder;
  private auditLogger: AuditLogger;
  private sendProgress: ProgressCallback;

  /** Set of session IDs that have been cancelled (via /stop). */
  private cancelledSessions: Set<string> = new Set();

  constructor(
    orchestrator: Orchestrator,
    memoryStore: MemoryStore,
    promptBuilder: PromptBuilder,
    auditLogger: AuditLogger,
    sendProgress: ProgressCallback,
  ) {
    this.orchestrator = orchestrator;
    this.memoryStore = memoryStore;
    this.promptBuilder = promptBuilder;
    this.auditLogger = auditLogger;
    this.sendProgress = sendProgress;
  }

  /**
   * Execute a multi-step task using the Ralph Wiggum loop.
   *
   * @param userId - The user who initiated the task
   * @param request - The original user request
   * @param chatId - Telegram chat ID for progress updates and approvals
   * @param conversationSessionId - The conversation session ID for audit logging
   */
  async execute(
    userId: string,
    request: string,
    chatId: string,
    conversationSessionId: string,
  ): Promise<LoopResult> {
    // Create the task session
    const session = this.memoryStore.createSession(
      userId,
      request,
      DEFAULT_MAX_ITERATIONS,
    );

    console.log(`[loop] Starting task session ${session.id} for user ${userId}`);
    this.sendProgress(chatId, `🚀 Starting multi-step task...\n\n_"${request}"_`);

    let currentSession = session;
    let finalText = '';

    while (currentSession.iteration < currentSession.maxIterations) {
      // Check if cancelled
      if (this.cancelledSessions.has(currentSession.id)) {
        this.cancelledSessions.delete(currentSession.id);
        this.memoryStore.completeSession(currentSession.id, 'failed');
        console.log(`[loop] Session ${currentSession.id} cancelled by user`);
        return {
          text: 'Task cancelled.',
          sessionId: currentSession.id,
          completed: false,
          iterations: currentSession.iteration,
        };
      }

      const iterationNum = currentSession.iteration + 1;
      console.log(
        `[loop] Iteration ${iterationNum}/${currentSession.maxIterations} ` +
        `for session ${currentSession.id}`,
      );

      // Build a fresh system prompt with session state
      const systemPrompt = currentSession.iteration === 0
        ? this.promptBuilder.buildSystemPrompt(request, userId)
        : this.promptBuilder.buildLoopPrompt(currentSession, userId);

      // Build the user message for this iteration
      const userMessage = currentSession.iteration === 0
        ? request
        : this.buildContinuationMessage(currentSession);

      // Run the orchestrator with a COMPLETELY fresh context
      const result = await this.orchestrator.chatWithSystemPrompt(
        conversationSessionId,
        [{ role: 'user', content: userMessage }],
        chatId,
        systemPrompt,
        userId,
      );

      const responseText = result.text;

      // Check for [CONTINUE] marker
      const shouldContinue = responseText.includes(CONTINUE_MARKER);
      const cleanText = responseText.replace(CONTINUE_MARKER, '').trim();

      // Extract plan from the response (if this is the first iteration)
      const updatedPlan = this.extractOrUpdatePlan(
        cleanText,
        currentSession,
      );

      // Update session state
      const newIteration = currentSession.iteration + 1;
      this.memoryStore.updateSession(
        currentSession.id,
        updatedPlan,
        newIteration,
        shouldContinue ? 'active' : 'completed',
      );

      if (shouldContinue) {
        // Send progress update
        const progressText = this.buildProgressMessage(updatedPlan, newIteration, currentSession.maxIterations);
        this.sendProgress(chatId, progressText);

        // Refresh session from DB for next iteration
        currentSession = this.memoryStore.getSessionById(currentSession.id)!;

        // Brief pause to avoid hammering the LLM
        await sleep(1000);
      } else {
        // Task complete (or needs user input)
        finalText = cleanText;
        this.memoryStore.completeSession(currentSession.id, 'completed');
        console.log(
          `[loop] Session ${currentSession.id} completed after ${newIteration} iteration(s)`,
        );
        return {
          text: finalText,
          sessionId: currentSession.id,
          completed: true,
          iterations: newIteration,
        };
      }
    }

    // Safety valve: max iterations reached
    this.memoryStore.completeSession(currentSession.id, 'failed');
    console.warn(
      `[loop] Session ${currentSession.id} hit max iterations (${currentSession.maxIterations})`,
    );

    return {
      text:
        finalText ||
        `I've reached the maximum number of iterations (${currentSession.maxIterations}) for this task. ` +
        'Some steps may still be incomplete. You can ask me to continue where I left off.',
      sessionId: currentSession.id,
      completed: false,
      iterations: currentSession.maxIterations,
    };
  }

  /**
   * Cancel a running task session (called from /stop command).
   */
  cancelSession(sessionId: string): void {
    this.cancelledSessions.add(sessionId);
  }

  /**
   * Cancel any active session for a user.
   * Returns the cancelled session ID or null.
   */
  cancelUserSession(userId: string): string | null {
    const sessionId = this.memoryStore.cancelActiveSession(userId);
    if (sessionId) {
      this.cancelledSessions.add(sessionId);
    }
    return sessionId;
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Build the continuation message for a loop iteration.
   * This tells the LLM to continue from where it left off.
   */
  private buildContinuationMessage(session: TaskSession): string {
    if (!session.plan) {
      return `Continue working on: ${session.originalRequest}`;
    }

    const pending = session.plan.steps.filter((s) => s.status === 'pending' || s.status === 'in-progress');
    if (pending.length === 0) {
      return 'All steps appear complete. Please provide a summary of what was accomplished.';
    }

    const nextStep = pending[0]!;
    return (
      `Continue with the task. The next step is #${nextStep.id}: "${nextStep.description}". ` +
      `${pending.length} step(s) remaining.`
    );
  }

  /**
   * Extract a plan from the LLM response, or update the existing plan
   * based on what the LLM reports as completed.
   */
  private extractOrUpdatePlan(responseText: string, session: TaskSession): SessionPlan {
    if (session.plan) {
      // Update existing plan: try to detect completed steps from response
      const updatedPlan = { ...session.plan };

      // Look for step completion patterns in the response
      for (const step of updatedPlan.steps) {
        if (step.status === 'pending' || step.status === 'in-progress') {
          // Check if the response mentions completing this step
          const patterns = [
            new RegExp(`step\\s*#?${step.id}[^]*?(done|complete|finished|✅)`, 'i'),
            new RegExp(`(completed|finished|done)[^]*?step\\s*#?${step.id}`, 'i'),
            new RegExp(`✅\\s*${step.id}\\.`, 'i'),
          ];

          for (const pattern of patterns) {
            if (pattern.test(responseText)) {
              step.status = 'completed';
              // Extract a brief result from nearby text
              step.result = `Completed in iteration ${session.iteration + 1}`;
              break;
            }
          }

          // If this is the first pending step and the response doesn't explicitly fail it,
          // and we're continuing, mark it as in-progress
          if (step.status === 'pending' && step === updatedPlan.steps.find((s) => s.status === 'pending')) {
            step.status = 'in-progress';
          }
        }
      }

      // Add log entry
      updatedPlan.log.push({
        iteration: session.iteration + 1,
        step: updatedPlan.steps.findIndex((s) => s.status === 'in-progress' || s.status === 'pending') + 1,
        action: 'iteration completed',
        result: responseText.slice(0, 200),
        timestamp: new Date().toISOString(),
      });

      return updatedPlan;
    }

    // First iteration: try to extract a plan from the response
    const steps = this.parseStepsFromResponse(responseText, session.originalRequest);

    return {
      goal: session.originalRequest,
      steps,
      assumptions: [],
      log: [{
        iteration: 1,
        step: 1,
        action: 'plan created',
        result: `Created plan with ${steps.length} steps`,
        timestamp: new Date().toISOString(),
      }],
    };
  }

  /**
   * Try to parse numbered steps from the LLM's response.
   * Falls back to a generic single-step plan if parsing fails.
   */
  private parseStepsFromResponse(text: string, request: string): SessionPlan['steps'] {
    const stepPattern = /(?:^|\n)\s*(\d+)\.\s+(.+?)(?=\n\s*\d+\.|\n\n|$)/gs;
    const steps: SessionPlan['steps'] = [];
    let match: RegExpExecArray | null;

    while ((match = stepPattern.exec(text)) !== null) {
      steps.push({
        id: parseInt(match[1]!, 10),
        description: match[2]!.trim(),
        status: 'pending',
      });
    }

    if (steps.length >= 2) {
      // Mark first step as in-progress since we just started
      steps[0]!.status = 'in-progress';
      return steps;
    }

    // Fallback: single step
    return [{
      id: 1,
      description: request,
      status: 'in-progress',
    }];
  }

  /**
   * Build a progress message for Telegram.
   */
  private buildProgressMessage(
    plan: SessionPlan,
    iteration: number,
    maxIterations: number,
  ): string {
    const completed = plan.steps.filter((s) => s.status === 'completed').length;
    const total = plan.steps.length;

    // Find the current/next step
    const current = plan.steps.find((s) => s.status === 'in-progress' || s.status === 'pending');
    const currentDesc = current ? `${current.description}` : 'Finishing up';

    return (
      `🔄 *Progress* (iteration ${iteration}/${maxIterations})\n\n` +
      `Steps: ${completed}/${total} completed\n` +
      `Next: _${currentDesc}_`
    );
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
