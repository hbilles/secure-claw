export type {
  Message,
  OutgoingMessage,
  Session,
  AuditEntry,
  ExecutorResult,
  SocketRequest,
  SocketResponse,
  ActionTier,
  ApprovalRequest,
  ApprovalDecision,
  BridgeNotification,
  ApprovalExpired,
  GatewayToBridgeMessage,
  BridgeToGatewayMessage,
  // Phase 4
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
  // Phase 9
  AuthServiceName,
  AuthConnectRequest,
  AuthStatusRequest,
  AuthDisconnectRequest,
  AuthResponse,
} from './types.js';

export type {
  Capability,
  Mount,
} from './capability-token.js';

export {
  mintCapabilityToken,
  verifyCapabilityToken,
} from './capability-token.js';

export { SocketServer, SocketClient } from './socket.js';
