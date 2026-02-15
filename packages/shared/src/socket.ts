/**
 * Unix domain socket server and client with JSON-lines protocol.
 *
 * Protocol: each message is a JSON object serialized on a single line,
 * terminated by a newline character (\n).
 */

import * as net from 'node:net';
import * as fs from 'node:fs';
import { EventEmitter } from 'node:events';

const DEFAULT_SOCKET_PATH = '/tmp/secureclaw.sock';

// ---------------------------------------------------------------------------
// Line-based JSON parser for a socket stream
// ---------------------------------------------------------------------------

function createLineParser(onLine: (data: unknown) => void): (chunk: Buffer) => void {
  let buffer = '';
  return (chunk: Buffer) => {
    buffer += chunk.toString('utf-8');
    const lines = buffer.split('\n');
    // Keep the last (possibly incomplete) segment in the buffer
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      try {
        onLine(JSON.parse(trimmed));
      } catch {
        console.error('[socket] Failed to parse JSON line:', trimmed);
      }
    }
  };
}

// ---------------------------------------------------------------------------
// SocketServer — used by the Gateway
// ---------------------------------------------------------------------------

export interface SocketServerEvents {
  message: (data: unknown, reply: (response: unknown) => void, socketId: string) => void;
  connection: (socketId: string) => void;
  disconnection: (socketId: string) => void;
  error: (err: Error) => void;
}

export class SocketServer extends EventEmitter {
  private server: net.Server | null = null;
  private clients: Map<string, net.Socket> = new Map();
  private socketPath: string;
  private nextClientId = 0;

  constructor(socketPath?: string) {
    super();
    this.socketPath = socketPath ?? process.env['SOCKET_PATH'] ?? DEFAULT_SOCKET_PATH;
  }

  /** Start listening on the Unix domain socket. */
  async start(): Promise<void> {
    // Remove stale socket file if it exists
    try {
      fs.unlinkSync(this.socketPath);
    } catch {
      // Ignore — file doesn't exist
    }

    return new Promise((resolve, reject) => {
      this.server = net.createServer((socket) => {
        const clientId = String(++this.nextClientId);
        this.clients.set(clientId, socket);
        console.log(`[socket-server] Client connected: ${clientId}`);
        this.emit('connection', clientId);

        const parse = createLineParser((data) => {
          const reply = (response: unknown) => {
            this.send(clientId, response);
          };
          this.emit('message', data, reply, clientId);
        });

        socket.on('data', parse);

        socket.on('close', () => {
          this.clients.delete(clientId);
          console.log(`[socket-server] Client disconnected: ${clientId}`);
          this.emit('disconnection', clientId);
        });

        socket.on('error', (err) => {
          console.error(`[socket-server] Client ${clientId} error:`, err.message);
          this.clients.delete(clientId);
        });
      });

      this.server.on('error', (err) => {
        this.emit('error', err);
        reject(err);
      });

      this.server.listen(this.socketPath, () => {
        console.log(`[socket-server] Listening on ${this.socketPath}`);
        resolve();
      });
    });
  }

  /** Send a JSON message to a specific client. */
  send(clientId: string, data: unknown): void {
    const socket = this.clients.get(clientId);
    if (socket && !socket.destroyed) {
      socket.write(JSON.stringify(data) + '\n');
    }
  }

  /** Broadcast a JSON message to all connected clients. */
  broadcast(data: unknown): void {
    const line = JSON.stringify(data) + '\n';
    for (const [, socket] of this.clients) {
      if (!socket.destroyed) {
        socket.write(line);
      }
    }
  }

  /** Stop the server and disconnect all clients. */
  async stop(): Promise<void> {
    for (const [, socket] of this.clients) {
      socket.destroy();
    }
    this.clients.clear();

    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('[socket-server] Stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

// ---------------------------------------------------------------------------
// SocketClient — used by bridges
// ---------------------------------------------------------------------------

export interface SocketClientEvents {
  message: (data: unknown) => void;
  connected: () => void;
  disconnected: () => void;
  error: (err: Error) => void;
}

export class SocketClient extends EventEmitter {
  private socket: net.Socket | null = null;
  private socketPath: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 500;  // Start at 500ms
  private maxReconnectDelay = 10_000;
  private shouldReconnect = true;
  private _connected = false;

  constructor(socketPath?: string) {
    super();
    this.socketPath = socketPath ?? process.env['SOCKET_PATH'] ?? DEFAULT_SOCKET_PATH;
  }

  /** Whether the client is currently connected. */
  get connected(): boolean {
    return this._connected;
  }

  /** Connect to the Unix domain socket. */
  connect(): void {
    this.shouldReconnect = true;
    this._connect();
  }

  private _connect(): void {
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.destroy();
    }

    this.socket = net.createConnection(this.socketPath);

    const parse = createLineParser((data) => {
      this.emit('message', data);
    });

    this.socket.on('connect', () => {
      this._connected = true;
      this.reconnectDelay = 500; // Reset backoff on successful connect
      console.log(`[socket-client] Connected to ${this.socketPath}`);
      this.emit('connected');
    });

    this.socket.on('data', parse);

    this.socket.on('close', () => {
      this._connected = false;
      console.log('[socket-client] Disconnected');
      this.emit('disconnected');
      this.scheduleReconnect();
    });

    this.socket.on('error', (err) => {
      // Suppress ENOENT/ECONNREFUSED during reconnect — these are expected
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' &&
          (err as NodeJS.ErrnoException).code !== 'ECONNREFUSED') {
        console.error('[socket-client] Error:', err.message);
        this.emit('error', err);
      }
    });
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.reconnectTimer) return;

    console.log(`[socket-client] Reconnecting in ${this.reconnectDelay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this._connect();
    }, this.reconnectDelay);

    // Exponential backoff
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  /** Send a JSON message to the server. */
  send(data: unknown): void {
    if (this.socket && this._connected) {
      this.socket.write(JSON.stringify(data) + '\n');
    } else {
      console.warn('[socket-client] Cannot send — not connected');
    }
  }

  /** Disconnect and stop reconnecting. */
  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this._connected = false;
  }
}
