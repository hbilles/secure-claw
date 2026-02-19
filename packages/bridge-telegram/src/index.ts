/**
 * SecureClaw Telegram Bridge
 *
 * Connects to Telegram via grammY (long polling) and forwards
 * allowed messages to the Gateway over a Unix domain socket.
 *
 * Phase 3: Added support for:
 * - Inline keyboard buttons for HITL approval requests
 * - Callback query handling for Approve/Reject decisions
 * - Notification messages for 'notify' tier actions
 * - Approval expiry message editing
 *
 * Phase 4: Added support for:
 * - /memories — List all memories (paginated, by category)
 * - /forget <topic> — Delete a specific memory
 * - /sessions — Show active/recent sessions
 * - /stop — Cancel the current multi-step session
 * - Task progress updates
 * - Memory/session command responses
 */

import { Bot, InlineKeyboard } from 'grammy';
import { randomUUID } from 'node:crypto';
import { SocketClient } from '@secureclaw/shared';
import type {
  Message,
  SocketRequest,
  SocketResponse,
  ApprovalRequest,
  ApprovalDecision,
  BridgeNotification,
  ApprovalExpired,
  TaskProgressUpdate,
  MemoryListRequest,
  MemoryListResponse,
  MemoryDeleteRequest,
  MemoryDeleteResponse,
  SessionListRequest,
  SessionListResponse,
  TaskStopRequest,
  TaskStopResponse,
  // Phase 5
  HeartbeatListRequest,
  HeartbeatListResponse,
  HeartbeatToggleRequest,
  HeartbeatToggleResponse,
  HeartbeatTriggered,
} from '@secureclaw/shared';

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
// Approval message tracking
// Maps approval IDs to their Telegram message details so we can edit them later
// ---------------------------------------------------------------------------

interface ApprovalMessageRef {
  chatId: string;
  messageId: number;
}

const approvalMessages: Map<string, ApprovalMessageRef> = new Map();
const resolvedApprovals: Set<string> = new Set();

// ---------------------------------------------------------------------------
// Initialize bot and socket client
// ---------------------------------------------------------------------------

const bot = new Bot(TELEGRAM_BOT_TOKEN);
const socketClient = new SocketClient();

// ---------------------------------------------------------------------------
// Phase 4: Telegram Commands
// ---------------------------------------------------------------------------

/**
 * /memories — List all memories, grouped by category.
 */
bot.command('memories', async (ctx) => {
  const userId = ctx.from?.id.toString();
  if (!userId || !ALLOWED_USER_IDS.has(userId)) return;

  const chatId = ctx.chat.id.toString();

  const request: MemoryListRequest = {
    type: 'memory-list',
    userId,
    chatId,
  };

  if (socketClient.connected) {
    socketClient.send(request);
    console.log(`[bridge-telegram] Sent memory-list request for user ${userId}`);
  } else {
    await ctx.reply('Sorry, I\'m not connected to the gateway right now.');
  }
});

/**
 * /forget <topic> — Delete a memory by topic.
 */
bot.command('forget', async (ctx) => {
  const userId = ctx.from?.id.toString();
  if (!userId || !ALLOWED_USER_IDS.has(userId)) return;

  const chatId = ctx.chat.id.toString();
  const topic = ctx.match?.trim();

  if (!topic) {
    await ctx.reply(
      '⚠️ Usage: `/forget <topic>`\n\nExample: `/forget coding style`',
      { parse_mode: 'MarkdownV2' },
    );
    return;
  }

  const request: MemoryDeleteRequest = {
    type: 'memory-delete',
    userId,
    chatId,
    topic,
  };

  if (socketClient.connected) {
    socketClient.send(request);
    console.log(`[bridge-telegram] Sent memory-delete request for topic "${topic}"`);
  } else {
    await ctx.reply('Sorry, I\'m not connected to the gateway right now.');
  }
});

/**
 * /sessions — Show active/recent sessions.
 */
bot.command('sessions', async (ctx) => {
  const userId = ctx.from?.id.toString();
  if (!userId || !ALLOWED_USER_IDS.has(userId)) return;

  const chatId = ctx.chat.id.toString();

  const request: SessionListRequest = {
    type: 'session-list',
    userId,
    chatId,
  };

  if (socketClient.connected) {
    socketClient.send(request);
    console.log(`[bridge-telegram] Sent session-list request for user ${userId}`);
  } else {
    await ctx.reply('Sorry, I\'m not connected to the gateway right now.');
  }
});

/**
 * /stop — Cancel the current multi-step task.
 */
bot.command('stop', async (ctx) => {
  const userId = ctx.from?.id.toString();
  if (!userId || !ALLOWED_USER_IDS.has(userId)) return;

  const chatId = ctx.chat.id.toString();

  const request: TaskStopRequest = {
    type: 'task-stop',
    userId,
    chatId,
  };

  if (socketClient.connected) {
    socketClient.send(request);
    console.log(`[bridge-telegram] Sent task-stop request for user ${userId}`);
  } else {
    await ctx.reply('Sorry, I\'m not connected to the gateway right now.');
  }
});

// ---------------------------------------------------------------------------
// Phase 5: Heartbeat Commands
// ---------------------------------------------------------------------------

/**
 * /heartbeats — List all heartbeats and their status.
 */
bot.command('heartbeats', async (ctx) => {
  const userId = ctx.from?.id.toString();
  if (!userId || !ALLOWED_USER_IDS.has(userId)) return;

  const chatId = ctx.chat.id.toString();

  const request: HeartbeatListRequest = {
    type: 'heartbeat-list',
    userId,
    chatId,
  };

  if (socketClient.connected) {
    socketClient.send(request);
    console.log(`[bridge-telegram] Sent heartbeat-list request for user ${userId}`);
  } else {
    await ctx.reply('Sorry, I\'m not connected to the gateway right now.');
  }
});

/**
 * Handle heartbeat enable/disable commands.
 * Format: /heartbeat_enable <name> or /heartbeat_disable <name>
 */
bot.hears(/^\/(heartbeat_enable|heartbeat_disable)\s+(.+)$/i, async (ctx) => {
  const userId = ctx.from?.id.toString();
  if (!userId || !ALLOWED_USER_IDS.has(userId)) return;

  const chatId = ctx.chat.id.toString();
  const action = ctx.match[1]!;
  const name = ctx.match[2]!.trim();
  const enabled = action === 'heartbeat_enable';

  const request: HeartbeatToggleRequest = {
    type: 'heartbeat-toggle',
    userId,
    chatId,
    name,
    enabled,
  };

  if (socketClient.connected) {
    socketClient.send(request);
    console.log(`[bridge-telegram] Sent heartbeat-toggle request: ${name} → ${enabled}`);
  } else {
    await ctx.reply('Sorry, I\'m not connected to the gateway right now.');
  }
});

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
// Handle callback queries (inline button presses for approvals)
// ---------------------------------------------------------------------------

bot.on('callback_query:data', async (ctx) => {
  const userId = ctx.from.id.toString();

  // Security: re-check the allowlist for callback queries.
  // Answer silently to avoid confirming the bot's presence or the allowlist.
  if (!ALLOWED_USER_IDS.has(userId)) {
    await ctx.answerCallbackQuery();
    return;
  }

  const data = ctx.callbackQuery.data;
  const colonIndex = data.indexOf(':');

  if (colonIndex === -1) {
    await ctx.answerCallbackQuery({ text: 'Invalid action' });
    return;
  }

  const action = data.slice(0, colonIndex);
  const approvalId = data.slice(colonIndex + 1);

  if (action !== 'approve' && action !== 'reject') {
    await ctx.answerCallbackQuery({ text: 'Invalid action' });
    return;
  }

  // Check if this approval has already been resolved
  if (resolvedApprovals.has(approvalId)) {
    await ctx.answerCallbackQuery({ text: '⏰ This approval has already been processed' });
    return;
  }

  const decision: 'approved' | 'rejected' = action === 'approve' ? 'approved' : 'rejected';

  // Send the decision to the gateway
  const approvalDecision: ApprovalDecision = {
    type: 'approval-decision',
    approvalId,
    decision,
  };

  if (socketClient.connected) {
    socketClient.send(approvalDecision);
    console.log(`[bridge-telegram] Sent approval decision: ${approvalId} → ${decision}`);
  } else {
    await ctx.answerCallbackQuery({ text: '⚠️ Not connected to gateway. Please try again.' });
    return;
  }

  // Mark as resolved
  resolvedApprovals.add(approvalId);
  approvalMessages.delete(approvalId);

  // Edit the original message to show the decision (remove buttons)
  const statusEmoji = decision === 'approved' ? '✅' : '❌';
  const statusText = decision === 'approved' ? 'Approved' : 'Rejected';

  try {
    const originalText = ctx.callbackQuery.message?.text ?? '';
    await ctx.editMessageText(
      `${originalText}\n\n${statusEmoji} ${statusText}`,
    );
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[bridge-telegram] Failed to edit approval message:`, error.message);
  }

  await ctx.answerCallbackQuery({ text: `${statusEmoji} ${statusText}` });
});

// ---------------------------------------------------------------------------
// Handle socket messages from gateway
// ---------------------------------------------------------------------------

socketClient.on('message', async (data: unknown) => {
  const raw = data as Record<string, unknown>;

  // Route based on message type
  switch (raw['type']) {
    case 'approval-request':
      await handleApprovalRequest(data as ApprovalRequest);
      return;

    case 'notification':
      await handleNotification(data as BridgeNotification);
      return;

    case 'approval-expired':
      await handleApprovalExpired(data as ApprovalExpired);
      return;

    // Phase 4: New message types
    case 'task-progress':
      await handleTaskProgress(data as TaskProgressUpdate);
      return;

    case 'memory-list-response':
      await handleMemoryListResponse(data as MemoryListResponse);
      return;

    case 'memory-delete-response':
      await handleMemoryDeleteResponse(data as MemoryDeleteResponse);
      return;

    case 'session-list-response':
      await handleSessionListResponse(data as SessionListResponse);
      return;

    case 'task-stop-response':
      await handleTaskStopResponse(data as TaskStopResponse);
      return;

    // Phase 5: Heartbeat message types
    case 'heartbeat-list-response':
      await handleHeartbeatListResponse(data as HeartbeatListResponse);
      return;

    case 'heartbeat-toggle-response':
      await handleHeartbeatToggleResponse(data as HeartbeatToggleResponse);
      return;

    case 'heartbeat-triggered':
      await handleHeartbeatTriggered(data as HeartbeatTriggered);
      return;

    default:
      // Standard socket response (no type field)
      await handleSocketResponse(data as SocketResponse);
      return;
  }
});

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

/**
 * Handle an approval request from the gateway.
 * Sends a Telegram message with inline Approve/Reject buttons.
 */
async function handleApprovalRequest(request: ApprovalRequest): Promise<void> {
  const { approvalId, toolName, toolInput, reason, planContext, chatId } = request;

  // Strip <think> tags from the reason (thinking models include chain-of-thought)
  const cleanReason = reason ? cleanLLMResponse(reason) : '';

  // Format the approval message
  const toolSummary = formatToolSummary(toolName, toolInput);
  let messageText = `🔒 *Approval Required*\n\nThe agent wants to:\n  📝 ${toolSummary}`;

  if (cleanReason) {
    messageText += `\n\nReason: _"${escapeMarkdown(cleanReason)}"_`;
  }

  if (planContext) {
    messageText += `\n\nContext: ${escapeMarkdown(planContext)}`;
  }

  // Telegram has a 4096-char limit. If the message is too long (even after
  // stripping <think>), truncate the reason to fit. Leave headroom for
  // MarkdownV2 escaping overhead.
  const MAX_APPROVAL_LEN = 3800;
  if (messageText.length > MAX_APPROVAL_LEN && cleanReason) {
    const overhead = messageText.length - escapeMarkdown(cleanReason).length;
    const maxReasonLen = Math.max(MAX_APPROVAL_LEN - overhead - 30, 50);
    const truncatedReason = cleanReason.slice(0, maxReasonLen) + '… (truncated)';

    // Rebuild the message with the truncated reason
    messageText = `🔒 *Approval Required*\n\nThe agent wants to:\n  📝 ${toolSummary}`;
    messageText += `\n\nReason: _"${escapeMarkdown(truncatedReason)}"_`;
    if (planContext) {
      messageText += `\n\nContext: ${escapeMarkdown(planContext)}`;
    }
  }

  // Build inline keyboard with Approve/Reject buttons
  const keyboard = new InlineKeyboard()
    .text('✅ Approve', `approve:${approvalId}`)
    .text('❌ Reject', `reject:${approvalId}`);

  try {
    const sent = await bot.api.sendMessage(chatId, messageText, {
      parse_mode: 'MarkdownV2',
      reply_markup: keyboard,
    });

    // Track the message so we can edit it later (on expiry or decision)
    approvalMessages.set(approvalId, {
      chatId,
      messageId: sent.message_id,
    });

    console.log(`[bridge-telegram] Sent approval request: ${approvalId} (msg: ${sent.message_id})`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[bridge-telegram] Failed to send approval request:`, error.message);

    // Fallback: try without MarkdownV2 if escaping caused issues
    try {
      const plainText = `🔒 Approval Required\n\nThe agent wants to: ${toolName}\n${cleanReason ? `\nReason: "${cleanReason.slice(0, 500)}"\n` : ''}`;
      const sent = await bot.api.sendMessage(chatId, plainText, {
        reply_markup: keyboard,
      });
      approvalMessages.set(approvalId, {
        chatId,
        messageId: sent.message_id,
      });
      console.log(`[bridge-telegram] Sent approval request (plain fallback): ${approvalId}`);
    } catch (fallbackErr) {
      const fbError = fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr));
      console.error(`[bridge-telegram] Failed to send approval request (both attempts):`, fbError.message);
    }
  }
}

/**
 * Handle a notification from the gateway.
 * Sends a simple info message to the Telegram chat.
 */
async function handleNotification(notification: BridgeNotification): Promise<void> {
  const { chatId, text } = notification;

  try {
    await sendFormattedMessage(chatId, text);
    console.log(`[bridge-telegram] Sent notification to chat ${chatId}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[bridge-telegram] Failed to send notification:`, error.message);
  }
}

/**
 * Handle an approval expiry from the gateway.
 * Edits the original Telegram message to show it expired and remove buttons.
 */
async function handleApprovalExpired(expired: ApprovalExpired): Promise<void> {
  const { approvalId, chatId } = expired;

  // Mark as resolved so late button presses are rejected
  resolvedApprovals.add(approvalId);

  const ref = approvalMessages.get(approvalId);
  approvalMessages.delete(approvalId);

  if (ref) {
    try {
      // Retrieve the original message text if possible, then append expiry notice
      await bot.api.editMessageText(
        ref.chatId,
        ref.messageId,
        '⏰ *Approval Expired*\n\nThis approval request timed out after 5 minutes. The action was not executed.',
        { parse_mode: 'MarkdownV2' },
      );
      console.log(`[bridge-telegram] Marked approval ${approvalId} as expired`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[bridge-telegram] Failed to edit expired approval message:`, error.message);
    }
  } else {
    // No tracked message — send a new notification
    try {
      await bot.api.sendMessage(
        chatId,
        '⏰ An approval request expired before you responded. The action was not executed.',
      );
    } catch {
      // Best-effort notification
    }
  }
}

/**
 * Handle a task progress update from the gateway.
 * Sends a progress message to the Telegram chat.
 */
async function handleTaskProgress(progress: TaskProgressUpdate): Promise<void> {
  const { chatId, text } = progress;

  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: 'MarkdownV2' });
    console.log(`[bridge-telegram] Sent task progress to chat ${chatId}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[bridge-telegram] Failed to send task progress:`, error.message);
  }
}

/**
 * Handle memory list response — format and send to the user.
 */
async function handleMemoryListResponse(response: MemoryListResponse): Promise<void> {
  const { chatId, memories } = response;

  if (memories.length === 0) {
    try {
      await bot.api.sendMessage(chatId, '🧠 No memories stored yet.');
    } catch {
      // Best-effort
    }
    return;
  }

  // Group by category
  const grouped = new Map<string, typeof memories>();
  for (const m of memories) {
    if (!grouped.has(m.category)) {
      grouped.set(m.category, []);
    }
    grouped.get(m.category)!.push(m);
  }

  let text = '🧠 *Memories*\n\n';
  const categoryEmojis: Record<string, string> = {
    user: '👤',
    preference: '⚙️',
    project: '📁',
    fact: '📌',
    environment: '💻',
  };

  for (const [category, items] of grouped) {
    const emoji = categoryEmojis[category] ?? '📝';
    text += `${emoji} *${escapeMarkdown(category)}*\n`;

    for (const item of items) {
      const content = item.content.length > 100
        ? item.content.slice(0, 100) + '…'
        : item.content;
      text += `  • \`${escapeMarkdown(item.topic)}\`: ${escapeMarkdown(content)}\n`;
    }
    text += '\n';
  }

  text += `_${memories.length} total memory(ies). Use /forget <topic> to remove one._`;

  // Telegram messages have a 4096 char limit
  if (text.length > 4000) {
    text = text.slice(0, 3950) + '\n\n_...truncated. Too many memories to display._';
  }

  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: 'MarkdownV2' });
    console.log(`[bridge-telegram] Sent memory list (${memories.length} items) to chat ${chatId}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[bridge-telegram] Failed to send memory list:`, error.message);
    // Fallback: try without markdown
    try {
      await bot.api.sendMessage(chatId, `🧠 ${memories.length} memories stored. (Failed to format — try /forget <topic> to manage)`);
    } catch {
      // Best-effort
    }
  }
}

/**
 * Handle memory delete response.
 */
async function handleMemoryDeleteResponse(response: MemoryDeleteResponse): Promise<void> {
  const { chatId, success, topic } = response;

  const text = success
    ? `✅ Forgot: "${topic}"`
    : `⚠️ No memory found with topic "${topic}"`;

  try {
    await bot.api.sendMessage(chatId, text);
    console.log(`[bridge-telegram] Memory delete result for "${topic}": ${success}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[bridge-telegram] Failed to send memory delete response:`, error.message);
  }
}

/**
 * Handle session list response.
 */
async function handleSessionListResponse(response: SessionListResponse): Promise<void> {
  const { chatId, sessions } = response;

  if (sessions.length === 0) {
    try {
      await bot.api.sendMessage(chatId, '📋 No recent task sessions.');
    } catch {
      // Best-effort
    }
    return;
  }

  let text = '📋 *Recent Sessions*\n\n';

  const statusEmojis: Record<string, string> = {
    active: '🔄',
    completed: '✅',
    failed: '❌',
    paused: '⏸️',
  };

  for (const session of sessions) {
    const emoji = statusEmojis[session.status] ?? '❓';
    const request = session.originalRequest.length > 80
      ? session.originalRequest.slice(0, 80) + '…'
      : session.originalRequest;
    const date = new Date(session.createdAt).toLocaleDateString();

    text += `${emoji} *${escapeMarkdown(session.status)}* (${date})\n`;
    text += `  _${escapeMarkdown(request)}_\n`;
    text += `  Iterations: ${session.iteration}/${session.maxIterations}\n\n`;
  }

  if (sessions.some((s) => s.status === 'active')) {
    text += '_Use /stop to cancel an active task._';
  }

  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: 'MarkdownV2' });
    console.log(`[bridge-telegram] Sent session list (${sessions.length} items) to chat ${chatId}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[bridge-telegram] Failed to send session list:`, error.message);
  }
}

/**
 * Handle task stop response.
 */
async function handleTaskStopResponse(response: TaskStopResponse): Promise<void> {
  const { chatId, cancelled, sessionId } = response;

  const text = cancelled
    ? `🛑 Task cancelled${sessionId ? ` (session: ${sessionId.slice(0, 8)}…)` : ''}`
    : '⚠️ No active task to cancel.';

  try {
    await bot.api.sendMessage(chatId, text);
    console.log(`[bridge-telegram] Task stop result: cancelled=${cancelled}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[bridge-telegram] Failed to send task stop response:`, error.message);
  }
}

/**
 * Handle a standard socket response from the gateway.
 * Sends the response text back to the Telegram chat.
 */
async function handleSocketResponse(response: SocketResponse): Promise<void> {
  if (!response.requestId || !response.outgoing) {
    console.error('[bridge-telegram] Invalid response from gateway:', response);
    return;
  }

  const { requestId, outgoing } = response;

  // Clean up pending request tracking
  pendingRequests.delete(requestId);

  try {
    await sendFormattedMessage(outgoing.chatId, outgoing.content, outgoing.replyToId);
    console.log(`[bridge-telegram] Sent response for request ${requestId}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[bridge-telegram] Failed to send Telegram message for request ${requestId}:`, error.message);
  }
}

// ---------------------------------------------------------------------------
// Phase 5: Heartbeat Handlers
// ---------------------------------------------------------------------------

/**
 * Handle heartbeat list response.
 */
async function handleHeartbeatListResponse(response: HeartbeatListResponse): Promise<void> {
  const { chatId, heartbeats } = response;

  if (heartbeats.length === 0) {
    try {
      await bot.api.sendMessage(chatId, '⏰ No heartbeats configured.');
    } catch {
      // Best-effort
    }
    return;
  }

  let text = '⏰ *Heartbeats*\n\n';

  for (const hb of heartbeats) {
    const status = hb.enabled ? '🟢 Enabled' : '🔴 Disabled';
    const prompt = hb.prompt.length > 100 ? hb.prompt.slice(0, 100) + '…' : hb.prompt;
    text += `**${escapeMarkdown(hb.name)}** — ${status}\n`;
    text += `  Schedule: \`${escapeMarkdown(hb.schedule)}\`\n`;
    text += `  Prompt: _${escapeMarkdown(prompt)}_\n\n`;
  }

  text += '_Commands:_\n';
  text += '`/heartbeat_enable <name>` — Enable a heartbeat\n';
  text += '`/heartbeat_disable <name>` — Disable a heartbeat';

  try {
    await bot.api.sendMessage(chatId, text, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[bridge-telegram] Failed to send heartbeat list:', error.message);
    try {
      await bot.api.sendMessage(chatId, `⏰ ${heartbeats.length} heartbeat(s) configured.`);
    } catch {
      // Best-effort
    }
  }
}

/**
 * Handle heartbeat toggle response.
 */
async function handleHeartbeatToggleResponse(response: HeartbeatToggleResponse): Promise<void> {
  const { chatId, name, enabled, success } = response;

  const text = success
    ? `⏰ Heartbeat "${name}" ${enabled ? 'enabled ✅' : 'disabled 🔴'}`
    : `⚠️ Heartbeat "${name}" not found.`;

  try {
    await bot.api.sendMessage(chatId, text);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[bridge-telegram] Failed to send heartbeat toggle response:', error.message);
  }
}

/**
 * Handle heartbeat triggered notification.
 */
async function handleHeartbeatTriggered(triggered: HeartbeatTriggered): Promise<void> {
  const { chatId, name } = triggered;

  try {
    await bot.api.sendMessage(chatId, `⏰ Heartbeat "${name}" triggered...`, { parse_mode: 'MarkdownV2' });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[bridge-telegram] Failed to send heartbeat triggered notification:', error.message);
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Format a tool call for display in the approval message. */
function formatToolSummary(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case 'write_file':
      return `write\\_file → ${escapeMarkdown(String(toolInput['path'] ?? 'unknown'))}`;
    case 'read_file':
      return `read\\_file → ${escapeMarkdown(String(toolInput['path'] ?? 'unknown'))}`;
    case 'list_directory':
      return `list\\_directory → ${escapeMarkdown(String(toolInput['path'] ?? 'unknown'))}`;
    case 'search_files':
      return `search\\_files → ${escapeMarkdown(String(toolInput['path'] ?? '.'))}`;
    case 'run_shell_command': {
      const cmd = String(toolInput['command'] ?? '');
      const display = cmd.length > 60 ? cmd.slice(0, 60) + '…' : cmd;
      return `run\\_shell\\_command → \`${escapeMarkdown(display)}\``;
    }
    case 'browse_web': {
      const url = String(toolInput['url'] ?? 'unknown URL');
      const action = String(toolInput['action'] ?? 'navigate');
      return `browse\\_web → ${escapeMarkdown(url)} \\(${escapeMarkdown(action)}\\)`;
    }
    default:
      return `${escapeMarkdown(toolName)}`;
  }
}

/** Escape special Markdown characters for Telegram MarkdownV2. */
function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

// ---------------------------------------------------------------------------
// LLM Response Formatting
// ---------------------------------------------------------------------------

/**
 * Strip <think>...</think> blocks from LLM responses.
 * Thinking models (e.g., Qwen) emit chain-of-thought reasoning in these tags
 * that should not be shown to the user.
 */
function cleanLLMResponse(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}

/**
 * Split a message into chunks that fit within Telegram's character limit.
 * Tries to break at newline boundaries for cleaner splits.
 */
function splitMessage(text: string, limit = 4096): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Try to split at the last newline before the limit
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = limit; // No good split point — hard cut

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }

  return chunks;
}

/** Escape HTML special characters. */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Convert standard Markdown to Telegram HTML.
 *
 * Handles: **bold**, *italic*, _italic_, `code`, ```code blocks```,
 * and [links](url). Falls back gracefully — unrecognized Markdown
 * is left as-is (just HTML-escaped).
 *
 * Uses Telegram HTML parse_mode which is far more forgiving than MarkdownV2.
 */
function markdownToTelegramHtml(text: string): string {
  // First, extract and protect code blocks (```...```) so they aren't processed
  const codeBlocks: string[] = [];
  let processed = text.replace(/```(?:\w*\n)?([\s\S]*?)```/g, (_match, code: string) => {
    const index = codeBlocks.length;
    codeBlocks.push(code);
    return `\x00CODEBLOCK${index}\x00`;
  });

  // Extract and protect inline code (`...`)
  const inlineCodes: string[] = [];
  processed = processed.replace(/`([^`]+)`/g, (_match, code: string) => {
    const index = inlineCodes.length;
    inlineCodes.push(code);
    return `\x00INLINE${index}\x00`;
  });

  // HTML-escape the rest of the text
  processed = escapeHtml(processed);

  // Convert Markdown formatting to HTML
  // Bold: **text** or __text__
  processed = processed.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  processed = processed.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (but not inside words with underscores)
  processed = processed.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>');
  processed = processed.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<i>$1</i>');

  // Links: [text](url)
  processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Restore code blocks
  processed = processed.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, index: string) => {
    return `<pre>${escapeHtml(codeBlocks[parseInt(index)]!)}</pre>`;
  });

  // Restore inline code
  processed = processed.replace(/\x00INLINE(\d+)\x00/g, (_match, index: string) => {
    return `<code>${escapeHtml(inlineCodes[parseInt(index)]!)}</code>`;
  });

  return processed;
}

/**
 * Send a formatted message to Telegram, with fallback and chunking.
 *
 * 1. Strips <think> tags
 * 2. Converts Markdown → Telegram HTML
 * 3. Splits into chunks if over 4096 chars
 * 4. Sends with parse_mode: 'HTML'
 * 5. On failure, falls back to plain text (still with <think> stripped)
 */
async function sendFormattedMessage(
  chatId: string,
  text: string,
  replyToId?: string,
): Promise<void> {
  const cleaned = cleanLLMResponse(text);
  if (!cleaned) return;

  const html = markdownToTelegramHtml(cleaned);
  const replyParams = replyToId
    ? { reply_parameters: { message_id: parseInt(replyToId, 10) } }
    : undefined;

  // Split into chunks if the message is too long for Telegram
  const htmlChunks = splitMessage(html);

  for (let i = 0; i < htmlChunks.length; i++) {
    const chunk = htmlChunks[i]!;
    // Only attach reply params to the first chunk
    const params = i === 0 ? replyParams : undefined;

    try {
      await bot.api.sendMessage(chatId, chunk, {
        parse_mode: 'HTML',
        ...params,
      });
    } catch {
      // Fallback: send as plain text if HTML parsing fails
      // Use the corresponding plain-text chunk
      const plainChunks = splitMessage(cleaned);
      const plainChunk = plainChunks[i] ?? chunk;
      try {
        await bot.api.sendMessage(chatId, plainChunk, params);
      } catch (fallbackErr) {
        const error = fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr));
        console.error(`[bridge-telegram] Failed to send message chunk ${i + 1}/${htmlChunks.length}:`, error.message);
      }
    }
  }
}

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
