/**
 * Core types for the SecureClaw framework.
 */

/** Internal message format — all bridges convert to/from this */
export interface Message {
  id: string;                           // UUID
  sourceId: string;                     // Original platform message ID
  source: 'telegram';                   // Extensible later
  userId: string;                       // Platform user ID (for allowlist checking)
  content: string;                      // Text content
  timestamp: Date;
  metadata?: Record<string, unknown>;   // Platform-specific extras
}

/** What we send back to the bridge */
export interface OutgoingMessage {
  chatId: string;                       // Platform chat ID to reply to
  content: string;
  replyToId?: string;                   // Optional: reply to specific message
}

/**
 * Session — conversation state.
 *
 * Messages can contain simple text or complex content blocks (e.g., tool use).
 * The `content` field is typed as `unknown` to support Anthropic's message
 * format (string | ContentBlock[]) without coupling to the Anthropic SDK.
 */
export interface Session {
  id: string;
  userId: string;
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  createdAt: Date;
  updatedAt: Date;
}

/** Audit log entry */
export interface AuditEntry {
  timestamp: Date;
  type:
    | 'message_received'
    | 'llm_request'
    | 'llm_response'
    | 'message_sent'
    | 'error'
    | 'tool_call'
    | 'tool_result'
    | 'action_classified'
    | 'approval_requested'
    | 'approval_resolved';
  sessionId: string;
  data: Record<string, unknown>;
}

/** Executor result — returned by sandboxed executor containers */
export interface ExecutorResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

/** Socket request — bridge sends this to gateway */
export interface SocketRequest {
  requestId: string;
  message: Message;
  replyTo: { chatId: string; messageId?: string };
}

/** Socket response — gateway sends this back to bridge */
export interface SocketResponse {
  requestId: string;
  outgoing: OutgoingMessage;
}

// ---------------------------------------------------------------------------
// Phase 3: HITL Approval Protocol
// ---------------------------------------------------------------------------

/** Action classification tiers */
export type ActionTier = 'auto-approve' | 'notify' | 'require-approval';

/** Approval request — gateway sends to bridge for user confirmation */
export interface ApprovalRequest {
  type: 'approval-request';
  approvalId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  reason: string;
  planContext?: string;
  chatId: string;
}

/** Approval decision — bridge sends to gateway after user taps inline button */
export interface ApprovalDecision {
  type: 'approval-decision';
  approvalId: string;
  decision: 'approved' | 'rejected';
}

/** Notification — gateway sends to bridge for informational messages */
export interface BridgeNotification {
  type: 'notification';
  chatId: string;
  text: string;
}

/** Approval expired — gateway tells bridge to update the Telegram message */
export interface ApprovalExpired {
  type: 'approval-expired';
  approvalId: string;
  chatId: string;
}

// ---------------------------------------------------------------------------
// Phase 4: Memory & Task Session Protocol
// ---------------------------------------------------------------------------

/** Progress update — gateway sends to bridge during multi-step task execution */
export interface TaskProgressUpdate {
  type: 'task-progress';
  chatId: string;
  text: string;
}

/** Memory list request — bridge sends to gateway when user types /memories */
export interface MemoryListRequest {
  type: 'memory-list';
  userId: string;
  chatId: string;
}

/** Memory list response — gateway sends to bridge with all memories */
export interface MemoryListResponse {
  type: 'memory-list-response';
  chatId: string;
  memories: Array<{
    id: string;
    category: string;
    topic: string;
    content: string;
    updatedAt: string;
  }>;
}

/** Memory delete request — bridge sends to gateway when user types /forget */
export interface MemoryDeleteRequest {
  type: 'memory-delete';
  userId: string;
  chatId: string;
  topic: string;
}

/** Memory delete response — gateway sends to bridge confirming deletion */
export interface MemoryDeleteResponse {
  type: 'memory-delete-response';
  chatId: string;
  success: boolean;
  topic: string;
}

/** Session list request — bridge sends to gateway when user types /sessions */
export interface SessionListRequest {
  type: 'session-list';
  userId: string;
  chatId: string;
}

/** Session list response — gateway sends to bridge with recent sessions */
export interface SessionListResponse {
  type: 'session-list-response';
  chatId: string;
  sessions: Array<{
    id: string;
    status: string;
    originalRequest: string;
    iteration: number;
    maxIterations: number;
    createdAt: string;
  }>;
}

/** Stop request — bridge sends to gateway when user types /stop */
export interface TaskStopRequest {
  type: 'task-stop';
  userId: string;
  chatId: string;
}

/** Stop response — gateway sends to bridge confirming cancellation */
export interface TaskStopResponse {
  type: 'task-stop-response';
  chatId: string;
  cancelled: boolean;
  sessionId?: string;
}

// ---------------------------------------------------------------------------
// Phase 5: Heartbeat Scheduler Protocol
// ---------------------------------------------------------------------------

/** Heartbeat list request — bridge sends to gateway when user types /heartbeats */
export interface HeartbeatListRequest {
  type: 'heartbeat-list';
  userId: string;
  chatId: string;
}

/** Heartbeat list response — gateway sends to bridge with all heartbeats */
export interface HeartbeatListResponse {
  type: 'heartbeat-list-response';
  chatId: string;
  heartbeats: Array<{
    name: string;
    schedule: string;
    prompt: string;
    enabled: boolean;
  }>;
}

/** Heartbeat toggle request — bridge sends to gateway to enable/disable */
export interface HeartbeatToggleRequest {
  type: 'heartbeat-toggle';
  userId: string;
  chatId: string;
  name: string;
  enabled: boolean;
}

/** Heartbeat toggle response — gateway sends to bridge confirming toggle */
export interface HeartbeatToggleResponse {
  type: 'heartbeat-toggle-response';
  chatId: string;
  name: string;
  enabled: boolean;
  success: boolean;
}

/** Heartbeat triggered — gateway sends to bridge when a heartbeat fires */
export interface HeartbeatTriggered {
  type: 'heartbeat-triggered';
  chatId: string;
  name: string;
}

/** Union of all gateway → bridge message types */
export type GatewayToBridgeMessage =
  | SocketResponse
  | ApprovalRequest
  | BridgeNotification
  | ApprovalExpired
  | TaskProgressUpdate
  | MemoryListResponse
  | MemoryDeleteResponse
  | SessionListResponse
  | TaskStopResponse
  // Phase 5
  | HeartbeatListResponse
  | HeartbeatToggleResponse
  | HeartbeatTriggered;

/** Union of all bridge → gateway message types */
export type BridgeToGatewayMessage =
  | SocketRequest
  | ApprovalDecision
  | MemoryListRequest
  | MemoryDeleteRequest
  | SessionListRequest
  | TaskStopRequest
  // Phase 5
  | HeartbeatListRequest
  | HeartbeatToggleRequest;
