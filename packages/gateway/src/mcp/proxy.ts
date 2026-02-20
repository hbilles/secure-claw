/**
 * MCP Forward Proxy — domain-filtering HTTP CONNECT proxy.
 *
 * Runs inside the Gateway process and mediates all outbound HTTPS traffic
 * from MCP server containers. Each container's traffic is filtered against
 * its own domain allowlist.
 *
 * Container identification is by source IP. When an MCP container starts,
 * the container manager registers its Docker bridge IP and allowed domains.
 * When the proxy receives a CONNECT request, it looks up the source IP to
 * determine which domains are permitted.
 *
 * This proxy is the SOLE network egress path for MCP containers — iptables
 * inside each container block all outbound traffic except to this proxy.
 */

import * as http from 'node:http';
import * as net from 'node:net';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface McpProxyConfig {
  /** Port to listen on (inside the Gateway container/host). */
  port: number;
}

export interface ProxyRequestEvent {
  timestamp: Date;
  serverName: string;
  sourceIp: string;
  targetDomain: string;
  targetPort: number;
  allowed: boolean;
}

interface ContainerRegistration {
  serverName: string;
  allowedDomains: Set<string>;
}

type OnRequestFn = (event: ProxyRequestEvent) => void;

// ---------------------------------------------------------------------------
// McpProxy
// ---------------------------------------------------------------------------

export class McpProxy {
  private server: http.Server;
  private port: number;

  /**
   * Map of container IP → registration (server name + allowed domains).
   * Populated when MCP containers start, cleared when they stop.
   */
  private registrations: Map<string, ContainerRegistration> = new Map();

  /** Audit callback for logging all proxy requests. */
  private onRequest: OnRequestFn | undefined;

  constructor(config: McpProxyConfig, onRequest?: OnRequestFn) {
    this.port = config.port;
    this.onRequest = onRequest;

    this.server = http.createServer((_req, res) => {
      // The proxy only handles CONNECT requests (for HTTPS tunneling).
      // Regular HTTP requests are not supported.
      res.writeHead(405, { 'Content-Type': 'text/plain' });
      res.end('Only CONNECT method is supported');
    });

    this.server.on('connect', this.handleConnect.bind(this));
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Start the proxy server. */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.listen(this.port, '0.0.0.0', () => {
        console.log(`[mcp-proxy] Listening on port ${this.port}`);
        resolve();
      });
      this.server.once('error', reject);
    });
  }

  /** Stop the proxy server and close all connections. */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => {
        console.log('[mcp-proxy] Stopped');
        resolve();
      });
      // Force-close any lingering connections after 2 seconds
      setTimeout(() => resolve(), 2000);
    });
  }

  // -------------------------------------------------------------------------
  // Container Registration
  // -------------------------------------------------------------------------

  /**
   * Register a container's IP and its allowed domains.
   * Called when an MCP container with network access starts.
   */
  registerContainer(
    containerIp: string,
    serverName: string,
    allowedDomains: string[],
  ): void {
    this.registrations.set(containerIp, {
      serverName,
      allowedDomains: new Set(allowedDomains.map((d) => d.toLowerCase())),
    });
    console.log(
      `[mcp-proxy] Registered ${serverName} (${containerIp}) — ` +
      `domains: ${allowedDomains.join(', ')}`,
    );
  }

  /**
   * Unregister a container's IP.
   * Called when an MCP container stops.
   */
  unregisterContainer(containerIp: string): void {
    const reg = this.registrations.get(containerIp);
    if (reg) {
      this.registrations.delete(containerIp);
      console.log(`[mcp-proxy] Unregistered ${reg.serverName} (${containerIp})`);
    }
  }

  /** Get the proxy address for injection into container env vars. */
  getAddress(): string {
    return `0.0.0.0:${this.port}`;
  }

  // -------------------------------------------------------------------------
  // CONNECT Handler
  // -------------------------------------------------------------------------

  /**
   * Handle an HTTP CONNECT request.
   *
   * 1. Parse the target host:port from the request URL
   * 2. Look up the source IP to find the container's registration
   * 3. Check if the target domain is in the container's allowlist
   * 4. If allowed: establish a TCP tunnel
   * 5. If blocked: respond 403 and close
   */
  private handleConnect(
    req: http.IncomingMessage,
    clientSocket: net.Socket,
    head: Buffer,
  ): void {
    // Parse target from CONNECT host:port
    const [targetHost, targetPortStr] = (req.url ?? '').split(':');
    const targetPort = parseInt(targetPortStr ?? '443', 10);
    const targetDomain = (targetHost ?? '').toLowerCase();

    // Identify the requesting container by source IP
    const sourceIp = this.extractSourceIp(clientSocket.remoteAddress ?? '');
    const registration = this.registrations.get(sourceIp);

    // Unknown source → reject
    if (!registration) {
      this.emitEvent(sourceIp, 'unknown', targetDomain, targetPort, false);
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.end();
      return;
    }

    // Check domain against allowlist (supports subdomain matching)
    const allowed = this.isDomainAllowed(targetDomain, registration.allowedDomains);

    this.emitEvent(
      sourceIp,
      registration.serverName,
      targetDomain,
      targetPort,
      allowed,
    );

    if (!allowed) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
      clientSocket.end();
      return;
    }

    // Establish TCP tunnel to the target
    const targetSocket = net.connect(targetPort, targetDomain, () => {
      clientSocket.write(
        'HTTP/1.1 200 Connection Established\r\n' +
        'Proxy-Agent: SecureClaw-MCP-Proxy\r\n' +
        '\r\n',
      );

      // Forward the initial data that came with the CONNECT request
      if (head.length > 0) {
        targetSocket.write(head);
      }

      // Pipe data bidirectionally
      targetSocket.pipe(clientSocket);
      clientSocket.pipe(targetSocket);
    });

    // Error handling
    targetSocket.on('error', (err) => {
      console.error(
        `[mcp-proxy] Connection error to ${targetDomain}:${targetPort}: ${err.message}`,
      );
      clientSocket.end();
    });

    clientSocket.on('error', (err) => {
      console.error(
        `[mcp-proxy] Client socket error from ${registration.serverName}: ${err.message}`,
      );
      targetSocket.end();
    });

    // Clean up on close
    clientSocket.on('close', () => targetSocket.destroy());
    targetSocket.on('close', () => clientSocket.destroy());
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  /**
   * Check if a domain is allowed, with subdomain support.
   *
   * If "github.com" is in the allowlist, "api.github.com" is also allowed.
   */
  private isDomainAllowed(domain: string, allowedDomains: Set<string>): boolean {
    // Exact match
    if (allowedDomains.has(domain)) return true;

    // Subdomain match: "api.github.com" matches "github.com"
    for (const allowed of allowedDomains) {
      if (domain.endsWith(`.${allowed}`)) return true;
    }

    return false;
  }

  /**
   * Extract the raw IPv4 address from a potentially IPv6-mapped address.
   * Docker often reports "::ffff:172.17.0.3" — we need "172.17.0.3".
   */
  private extractSourceIp(address: string): string {
    if (address.startsWith('::ffff:')) {
      return address.slice(7);
    }
    return address;
  }

  /** Emit a proxy request event for audit logging. */
  private emitEvent(
    sourceIp: string,
    serverName: string,
    targetDomain: string,
    targetPort: number,
    allowed: boolean,
  ): void {
    if (this.onRequest) {
      this.onRequest({
        timestamp: new Date(),
        serverName,
        sourceIp,
        targetDomain,
        targetPort,
        allowed,
      });
    }

    const status = allowed ? 'ALLOW' : 'DENY';
    console.log(
      `[mcp-proxy] ${status} ${serverName} (${sourceIp}) → ${targetDomain}:${targetPort}`,
    );
  }
}
