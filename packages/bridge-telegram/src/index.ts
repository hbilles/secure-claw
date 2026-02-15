/**
 * SecureClaw Telegram Bridge
 *
 * Connects to Telegram via grammY (long polling) and forwards
 * allowed messages to the Gateway over a Unix domain socket.
 */

import { Bot } from 'grammy';
import { randomUUID } from 'node:crypto';
import { SocketClient } from '@secureclaw/shared';
import type { Message, SocketRequest, SocketResponse } from '@secureclaw/shared';

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

const TELEGRAM_BOT_TOKEN = process.env['TELEGRAM_BOT_TOKEN'];
if (!TELEGRAM_BOT_TOKEN) {
  console.error('[bridge-telegram] FATAL: TELEGRAM_BOT_TOKEN environment variable is not set');
  process.exit(1);
}

const ALLOWED_USER_IDS: Set<string> = new Set(
  (process.env['ALLOWED_USER_IDS'] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
);

if (ALLOWED_USER_IDS.size === 0) {
  console.warn('[bridge-telegram] WARNING: ALLOWED_USER_IDS is empty — all messages will be ignored');
}

console.log(`[bridge-telegram] Allowlist: ${ALLOWED_USER_IDS.size} user(s)`);

// ---------------------------------------------------------------------------
// Pending request tracking (for correlating socket responses)
// ---------------------------------------------------------------------------

interface PendingRequest {
  chatId: string;
  messageId?: number;
}

const pendingRequests: Map<string, PendingRequest> = new Map();

// ---------------------------------------------------------------------------
// Initialize bot and socket client
// ---------------------------------------------------------------------------

const bot = new Bot(TELEGRAM_BOT_TOKEN);
const socketClient = new SocketClient();

// ---------------------------------------------------------------------------
// Handle incoming Telegram messages
// ---------------------------------------------------------------------------

bot.on('message:text', async (ctx) => {
  const userId = ctx.from.id.toString();

  // Security boundary: silently ignore non-allowlisted users
  if (!ALLOWED_USER_IDS.has(userId)) {
    return;
  }

  const chatId = ctx.chat.id.toString();
  const messageId = ctx.message.message_id;

  // Convert to internal Message format
  const message: Message = {
    id: randomUUID(),
    sourceId: messageId.toString(),
    source: 'telegram',
    userId,
    content: ctx.message.text,
    timestamp: new Date(ctx.message.date * 1000),
    metadata: {
      chatId,
      firstName: ctx.from.first_name,
      lastName: ctx.from.last_name,
      username: ctx.from.username,
    },
  };

  const requestId = randomUUID();

  // Track the pending request so we know where to send the response
  pendingRequests.set(requestId, {
    chatId,
    messageId,
  });

  // Build socket request
  const request: SocketRequest = {
    requestId,
    message,
    replyTo: {
      chatId,
      messageId: messageId.toString(),
    },
  };

  // Send to gateway
  if (socketClient.connected) {
    socketClient.send(request);
    console.log(`[bridge-telegram] Forwarded message from user ${userId} (request: ${requestId})`);
  } else {
    console.warn(`[bridge-telegram] Cannot forward message — not connected to gateway`);
    pendingRequests.delete(requestId);
    // Let the user know we're having issues
    await ctx.reply('Sorry, I\'m temporarily unable to process messages. Please try again in a moment.');
  }
});

// ---------------------------------------------------------------------------
// Handle socket responses from gateway
// ---------------------------------------------------------------------------

socketClient.on('message', async (data: unknown) => {
  const response = data as SocketResponse;

  if (!response.requestId || !response.outgoing) {
    console.error('[bridge-telegram] Invalid response from gateway:', data);
    return;
  }

  const { requestId, outgoing } = response;

  // Clean up pending request tracking
  pendingRequests.delete(requestId);

  try {
    const replyToId = outgoing.replyToId ? parseInt(outgoing.replyToId, 10) : undefined;
    await bot.api.sendMessage(
      outgoing.chatId,
      outgoing.content,
      replyToId ? { reply_parameters: { message_id: replyToId } } : undefined,
    );
    console.log(`[bridge-telegram] Sent response for request ${requestId}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[bridge-telegram] Failed to send Telegram message for request ${requestId}:`, error.message);
  }
});

// ---------------------------------------------------------------------------
// Connection status logging
// ---------------------------------------------------------------------------

socketClient.on('connected', () => {
  console.log('[bridge-telegram] Connected to gateway');
});

socketClient.on('disconnected', () => {
  console.log('[bridge-telegram] Disconnected from gateway — will reconnect');
});

// ---------------------------------------------------------------------------
// Start everything
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('[bridge-telegram] Starting Telegram Bridge...');

  // Connect to gateway socket (auto-reconnects)
  socketClient.connect();

  // Start the bot (long polling)
  bot.start({
    onStart: (botInfo) => {
      console.log(`[bridge-telegram] Bot @${botInfo.username} is running`);
    },
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('[bridge-telegram] Shutting down...');
    bot.stop();
    socketClient.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[bridge-telegram] Fatal error:', err);
  process.exit(1);
});
