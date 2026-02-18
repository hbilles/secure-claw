/**
 * SecureClaw Gateway — central orchestrator.
 *
 * Listens on a Unix domain socket for messages from bridges,
 * manages sessions, routes tool calls through sandboxed containers,
 * and logs everything to the audit trail.
 *
 * Phase 3: HITL approval gate.
 * Phase 4: Persistent memory, Ralph Wiggum loop.
 * Phase 5: Web browsing, external services (Gmail, Calendar, GitHub),
 *          heartbeat scheduler, web dashboard.
 */

import Anthropic from '@anthropic-ai/sdk';
import { SocketServer } from '@secureclaw/shared';
import type {
  SocketRequest,
  SocketResponse,
  ApprovalDecision,
  MemoryListRequest,
  MemoryDeleteRequest,
  SessionListRequest,
  TaskStopRequest,
  MemoryListResponse,
  MemoryDeleteResponse,
  SessionListResponse,
  TaskStopResponse,
  TaskProgressUpdate,
  HeartbeatListRequest,
  HeartbeatListResponse,
  HeartbeatToggleRequest,
  HeartbeatToggleResponse,
  HeartbeatTriggered,
} from '@secureclaw/shared';
import { SessionManager } from './session.js';
import { AuditLogger } from './audit.js';
import { loadConfig } from './config.js';
import { Dispatcher } from './dispatcher.js';
import { Orchestrator } from './orchestrator.js';
import { ApprovalStore } from './approval-store.js';
import { HITLGate } from './hitl-gate.js';
import { MemoryStore } from './memory.js';
import { PromptBuilder } from './prompt-builder.js';
import { TaskLoop } from './loop.js';
// Phase 5
import { OAuthStore } from './services/oauth.js';
import { GmailService } from './services/gmail.js';
import { CalendarService } from './services/calendar.js';
import { GitHubService } from './services/github.js';
import { HeartbeatScheduler } from './scheduler.js';
import { startDashboard, broadcastSSE } from './dashboard.js';

// ---------------------------------------------------------------------------
// Heuristic: Is a request "complex" enough for the Ralph Wiggum loop?
// ---------------------------------------------------------------------------

const COMPLEX_KEYWORDS = [
  'set up', 'setup', 'create a project', 'scaffold', 'initialize',
  'configure', 'build me', 'build a', 'set up a', 'install and configure',
  'step by step', 'steps', 'multi-step', 'pipeline', 'workflow',
  'deploy', 'migration', 'refactor', 'restructure', 'convert',
];

function isComplexRequest(content: string): boolean {
  const lower = content.toLowerCase();
  // Check for multiple action verbs or explicit complexity keywords
  const matchCount = COMPLEX_KEYWORDS.filter((kw) => lower.includes(kw)).length;
  // Also check for requests with many conjunctions (and, then, also, with)
  const conjunctions = (lower.match(/\band\b|\bthen\b|\balso\b|\bwith\b/g) || []).length;
  return matchCount >= 1 || conjunctions >= 3;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('[gateway] Starting SecureClaw Gateway...');

  // Load configuration
  const config = loadConfig();

  // Initialize components
  const sessionManager = new SessionManager();
  const auditLogger = new AuditLogger();
  await auditLogger.init();

  // Initialize the approval store (SQLite)
  const approvalStore = new ApprovalStore();

  // Start periodic expiry checks (every 60s, expire after 5 minutes)
  approvalStore.startExpiryCheck();

  // Initialize the dispatcher (Docker container manager)
  // This requires /var/run/docker.sock to be mounted
  const dispatcher = new Dispatcher(config);

  // Check Docker connectivity
  const dockerAvailable = await dispatcher.ping();
  if (dockerAvailable) {
    console.log('[gateway] Docker daemon is accessible');
  } else {
    console.warn(
      '[gateway] WARNING: Docker daemon is not accessible. ' +
      'Tool execution will fail. Ensure /var/run/docker.sock is mounted.',
    );
  }

  // Phase 4: Initialize memory store and prompt builder
  const memoryStore = new MemoryStore();
  const promptBuilder = new PromptBuilder(memoryStore);

  const socketServer = new SocketServer();

  // Initialize the HITL gate (approval system)
  // The sendToBridge callback broadcasts to all connected bridge clients
  const hitlGate = new HITLGate(
    approvalStore,
    auditLogger,
    config,
    (message) => socketServer.broadcast(message),
  );

  // Initialize the orchestrator (agentic tool-use loop)
  const orchestrator = new Orchestrator(dispatcher, hitlGate, auditLogger, config);

  // Attach memory to the orchestrator
  orchestrator.setMemory(memoryStore, promptBuilder);

  // Phase 5: Initialize OAuth store and external services
  let oauthStore: OAuthStore | null = null;
  let gmailService: GmailService | null = null;
  let calendarService: CalendarService | null = null;
  let githubService: GitHubService | null = null;

  try {
    oauthStore = new OAuthStore();

    gmailService = new GmailService(oauthStore);
    calendarService = new CalendarService(oauthStore);
    githubService = new GitHubService(oauthStore, config.ownGitHubRepos);

    orchestrator.setServices(gmailService, calendarService, githubService);

    const connected: string[] = [];
    if (gmailService.isConnected()) connected.push('Gmail');
    if (calendarService.isConnected()) connected.push('Calendar');
    if (githubService.isConnected()) connected.push('GitHub');

    if (connected.length > 0) {
      console.log(`[gateway] Connected services: ${connected.join(', ')}`);
    } else {
      console.log('[gateway] No external services connected (use /connect to set up)');
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.warn(`[gateway] OAuth store not available: ${error.message}`);
    console.warn('[gateway] External services (Gmail, Calendar, GitHub) will be disabled');
  }

  // Phase 4: Initialize the Ralph Wiggum task loop
  const sendProgress = (chatId: string, text: string) => {
    const progressMsg: TaskProgressUpdate = {
      type: 'task-progress',
      chatId,
      text,
    };
    socketServer.broadcast(progressMsg);
  };

  const taskLoop = new TaskLoop(
    orchestrator,
    memoryStore,
    promptBuilder,
    auditLogger,
    sendProgress,
  );

  // Phase 5: Initialize the heartbeat scheduler
  const heartbeatScheduler = new HeartbeatScheduler(async (name, prompt) => {
    console.log(`[gateway] Heartbeat "${name}" fired, running prompt through orchestrator`);

    // Use the first allowed user ID as the heartbeat user
    const userId = process.env['ALLOWED_USER_IDS']?.split(',')[0]?.trim();
    if (!userId) {
      console.error('[gateway] No ALLOWED_USER_IDS set — cannot run heartbeat');
      return;
    }

    // Get the chat ID (same as user ID for Telegram private chats)
    const chatId = userId;
    const session = sessionManager.getOrCreate(userId);

    // Notify the bridge that a heartbeat is firing
    const triggeredMsg: HeartbeatTriggered = {
      type: 'heartbeat-triggered',
      chatId,
      name,
    };
    socketServer.broadcast(triggeredMsg);

    try {
      // Run the heartbeat prompt through the normal orchestrator
      // (HITL approval still applies — heartbeats don't bypass the gate)
      const result = await orchestrator.chat(
        session.id,
        [{ role: 'user', content: prompt }],
        chatId,
        userId,
      );

      // Send the result to the bridge
      socketServer.broadcast({
        type: 'notification',
        chatId,
        text: `⏰ *${name}*\n\n${result.text}`,
      });

      auditLogger.logMessageSent(session.id, {
        heartbeat: name,
        chatId,
        contentLength: result.text.length,
      });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[gateway] Heartbeat "${name}" error:`, error.message);
      auditLogger.logError(session.id, {
        heartbeat: name,
        error: error.message,
      });
    }
  });

  if (config.heartbeats.length > 0) {
    heartbeatScheduler.start(config.heartbeats);
  }

  // Phase 5: Start the web dashboard
  const dashboardServer = startDashboard(auditLogger, memoryStore, approvalStore, config);

  // Connect audit logger to dashboard SSE for live streaming
  auditLogger.setOnLog((entry) => broadcastSSE('audit', entry));

  // Handle incoming messages from bridges
  socketServer.on('message', async (data: unknown, reply: (response: unknown) => void, clientId: string) => {
    const raw = data as Record<string, unknown>;

    // --- Phase 3: Handle approval decisions from bridge ---
    if (raw['type'] === 'approval-decision') {
      const decision = data as ApprovalDecision;
      console.log(
        `[gateway] Approval decision: ${decision.approvalId} → ${decision.decision}`,
      );
      hitlGate.resolveApproval(decision.approvalId, decision.decision);
      return;
    }

    // --- Phase 4: Handle memory commands from bridge ---
    if (raw['type'] === 'memory-list') {
      const req = data as MemoryListRequest;
      const memories = memoryStore.getAll();
      const response: MemoryListResponse = {
        type: 'memory-list-response',
        chatId: req.chatId,
        memories: memories.map((m) => ({
          id: m.id,
          category: m.category,
          topic: m.topic,
          content: m.content,
          updatedAt: m.updatedAt,
        })),
      };
      socketServer.broadcast(response);
      return;
    }

    if (raw['type'] === 'memory-delete') {
      const req = data as MemoryDeleteRequest;
      const success = memoryStore.deleteByTopic(req.topic);
      const response: MemoryDeleteResponse = {
        type: 'memory-delete-response',
        chatId: req.chatId,
        success,
        topic: req.topic,
      };
      socketServer.broadcast(response);
      return;
    }

    if (raw['type'] === 'session-list') {
      const req = data as SessionListRequest;
      const sessions = memoryStore.getRecentSessions(req.userId, 10);
      const response: SessionListResponse = {
        type: 'session-list-response',
        chatId: req.chatId,
        sessions: sessions.map((s) => ({
          id: s.id,
          status: s.status,
          originalRequest: s.originalRequest,
          iteration: s.iteration,
          maxIterations: s.maxIterations,
          createdAt: s.createdAt,
        })),
      };
      socketServer.broadcast(response);
      return;
    }

    if (raw['type'] === 'task-stop') {
      const req = data as TaskStopRequest;
      const sessionId = taskLoop.cancelUserSession(req.userId);
      const response: TaskStopResponse = {
        type: 'task-stop-response',
        chatId: req.chatId,
        cancelled: sessionId !== null,
        sessionId: sessionId ?? undefined,
      };
      socketServer.broadcast(response);
      return;
    }

    // --- Phase 5: Handle heartbeat commands from bridge ---
    if (raw['type'] === 'heartbeat-list') {
      const req = data as HeartbeatListRequest;
      const heartbeats = heartbeatScheduler.list();
      const response: HeartbeatListResponse = {
        type: 'heartbeat-list-response',
        chatId: req.chatId,
        heartbeats: heartbeats.map((h) => ({
          name: h.name,
          schedule: h.schedule,
          prompt: h.prompt,
          enabled: h.enabled,
        })),
      };
      socketServer.broadcast(response);
      return;
    }

    if (raw['type'] === 'heartbeat-toggle') {
      const req = data as HeartbeatToggleRequest;
      const success = heartbeatScheduler.toggle(req.name, req.enabled);
      const response: HeartbeatToggleResponse = {
        type: 'heartbeat-toggle-response',
        chatId: req.chatId,
        name: req.name,
        enabled: req.enabled,
        success,
      };
      socketServer.broadcast(response);
      return;
    }

    // --- Standard message request from bridge ---
    const request = data as SocketRequest;

    if (!request.requestId || !request.message) {
      console.error('[gateway] Invalid request from client', clientId);
      return;
    }

    const { requestId, message, replyTo } = request;
    const { userId, content } = message;

    // Get or create session
    const session = sessionManager.getOrCreate(userId);

    try {
      // 1. Log message received
      auditLogger.logMessageReceived(session.id, {
        requestId,
        userId,
        content,
        source: message.source,
        sourceId: message.sourceId,
      });

      // 2. Check if there's an active task session for this user
      const activeTaskSession = memoryStore.getActiveSession(userId);

      // 3. Decide: normal chat or Ralph Wiggum loop?
      if (!activeTaskSession && isComplexRequest(content)) {
        // Complex request → use the Ralph Wiggum loop
        console.log(
          `[gateway] Complex request detected for session ${session.id} — starting task loop`,
        );

        const loopResult = await taskLoop.execute(
          userId,
          content,
          replyTo.chatId,
          session.id,
        );

        // Send the final response back to the bridge
        const socketResponse: SocketResponse = {
          requestId,
          outgoing: {
            chatId: replyTo.chatId,
            content: loopResult.text,
            replyToId: replyTo.messageId,
          },
        };

        reply(socketResponse);

        auditLogger.logMessageSent(session.id, {
          requestId,
          chatId: replyTo.chatId,
          contentLength: loopResult.text.length,
          taskSessionId: loopResult.sessionId,
          iterations: loopResult.iterations,
          completed: loopResult.completed,
        });

        console.log(
          `[gateway] Task loop completed for request ${requestId} ` +
          `(${loopResult.iterations} iterations, completed: ${loopResult.completed})`,
        );

      } else {
        // Normal conversation (or continuation within active session context)

        // 4. Build the messages array from session history
        const chatMessages = session.messages.map((m) => ({
          role: m.role,
          content: m.content,
        })) as Anthropic.Messages.MessageParam[];

        // 5. Append the new user message
        chatMessages.push({
          role: 'user',
          content,
        });

        // 6. Run the orchestrator (agentic tool-use loop)
        console.log(
          `[gateway] Processing message for session ${session.id} ` +
          `(${chatMessages.length} messages in context)`,
        );

        const result = await orchestrator.chat(session.id, chatMessages, replyTo.chatId, userId);

        // 7. Check if the response contains [CONTINUE] (Ralph Wiggum trigger from normal chat)
        if (result.text.includes('[CONTINUE]')) {
          // The LLM decided mid-conversation this needs multi-step handling.
          // Start a task loop from here.
          console.log(`[gateway] [CONTINUE] detected in normal chat — switching to task loop`);

          const cleanText = result.text.replace('[CONTINUE]', '').trim();

          // Store the conversation so far
          sessionManager.setMessages(
            userId,
            result.messages as Array<{ role: 'user' | 'assistant'; content: unknown }>,
          );

          // Send the partial response
          const partialResponse: SocketResponse = {
            requestId,
            outgoing: {
              chatId: replyTo.chatId,
              content: cleanText,
              replyToId: replyTo.messageId,
            },
          };
          reply(partialResponse);

          // Now start the loop for the continuation
          const loopResult = await taskLoop.execute(
            userId,
            content,
            replyTo.chatId,
            session.id,
          );

          // Send the loop's final response as a new message
          socketServer.broadcast({
            type: 'notification',
            chatId: replyTo.chatId,
            text: loopResult.text,
          });

        } else {
          // Normal response — no loop needed

          // 8. Store the updated messages in the session
          sessionManager.setMessages(
            userId,
            result.messages as Array<{ role: 'user' | 'assistant'; content: unknown }>,
          );

          // 9. Send the final text response back to the bridge
          const socketResponse: SocketResponse = {
            requestId,
            outgoing: {
              chatId: replyTo.chatId,
              content: result.text,
              replyToId: replyTo.messageId,
            },
          };

          reply(socketResponse);

          // 10. Log message sent
          auditLogger.logMessageSent(session.id, {
            requestId,
            chatId: replyTo.chatId,
            contentLength: result.text.length,
          });

          console.log(
            `[gateway] Response sent for request ${requestId} (${result.text.length} chars)`,
          );
        }
      }

    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[gateway] Error processing request ${requestId}:`, error.message);

      auditLogger.logError(session.id, {
        requestId,
        error: error.message,
        stack: error.stack,
      });

      // Send error response back to bridge so the user gets feedback
      const errorResponse: SocketResponse = {
        requestId,
        outgoing: {
          chatId: replyTo.chatId,
          content: 'Sorry, I encountered an error processing your message. Please try again.',
          replyToId: replyTo.messageId,
        },
      };

      reply(errorResponse);
    }
  });

  // Start the socket server
  await socketServer.start();
  console.log('[gateway] Gateway is ready.');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[gateway] Shutting down...');
    heartbeatScheduler.stop();
    if (dashboardServer) {
      dashboardServer.close();
    }
    await socketServer.stop();
    sessionManager.dispose();
    auditLogger.close();
    approvalStore.close();
    memoryStore.close();
    if (oauthStore) oauthStore.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[gateway] Fatal error:', err);
  process.exit(1);
});
