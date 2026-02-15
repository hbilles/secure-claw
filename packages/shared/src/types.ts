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

/** Session — conversation state */
export interface Session {
  id: string;
  userId: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  createdAt: Date;
  updatedAt: Date;
}

/** Audit log entry */
export interface AuditEntry {
  timestamp: Date;
  type: 'message_received' | 'llm_request' | 'llm_response' | 'message_sent' | 'error';
  sessionId: string;
  data: Record<string, unknown>;
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
