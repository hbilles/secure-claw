/**
 * SecureClaw Gateway — central orchestrator.
 *
 * Listens on a Unix domain socket for messages from bridges,
 * manages sessions, calls the Anthropic API, and logs everything.
 */

import { SocketServer } from '@secureclaw/shared';
import type { SocketRequest, SocketResponse } from '@secureclaw/shared';
import { SessionManager } from './session.js';
import { LLMClient } from './llm.js';
import { AuditLogger } from './audit.js';

async function main(): Promise<void> {
  console.log('[gateway] Starting SecureClaw Gateway...');

  // Initialize components
  const sessionManager = new SessionManager();
  const llmClient = new LLMClient();
  const auditLogger = new AuditLogger();
  await auditLogger.init();

  const socketServer = new SocketServer();

  // Handle incoming messages from bridges
  socketServer.on('message', async (data: unknown, reply: (response: unknown) => void, clientId: string) => {
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

      // 2. Append user message to session
      sessionManager.append(userId, 'user', content);

      // 3. Build messages array for LLM
      const chatMessages = session.messages.map((m) => ({
        role: m.role,
        content: m.content,
      }));

      // 4. Log LLM request
      auditLogger.logLLMRequest(session.id, {
        requestId,
        messages: chatMessages,
      });

      // 5. Call Claude
      console.log(`[gateway] Calling LLM for session ${session.id} (${chatMessages.length} messages)`);
      const responseText = await llmClient.chat(chatMessages);

      // 6. Log LLM response
      auditLogger.logLLMResponse(session.id, {
        requestId,
        response: responseText,
      });

      // 7. Append assistant response to session
      sessionManager.append(userId, 'assistant', responseText);

      // 8. Send response back to bridge
      const socketResponse: SocketResponse = {
        requestId,
        outgoing: {
          chatId: replyTo.chatId,
          content: responseText,
          replyToId: replyTo.messageId,
        },
      };

      reply(socketResponse);

      // 9. Log message sent
      auditLogger.logMessageSent(session.id, {
        requestId,
        chatId: replyTo.chatId,
        contentLength: responseText.length,
      });

      console.log(`[gateway] Response sent for request ${requestId} (${responseText.length} chars)`);

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
    await socketServer.stop();
    sessionManager.dispose();
    auditLogger.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[gateway] Fatal error:', err);
  process.exit(1);
});
