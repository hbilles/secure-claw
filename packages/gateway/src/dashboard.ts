/**
 * Web Dashboard — simple localhost-only web interface for SecureClaw.
 *
 * Serves static HTML/CSS/JS and provides REST/SSE API endpoints:
 * - GET /                    → Main HTML page
 * - GET /api/audit           → Audit log entries (paginated)
 * - GET /api/audit/stream    → SSE live audit stream
 * - GET /api/memories        → All memories
 * - GET /api/sessions        → Task sessions
 * - GET /api/approvals       → Approval queue
 * - GET /api/config          → Current config (read-only)
 *
 * CRITICAL: Bound to 127.0.0.1 ONLY. Rejects non-localhost requests.
 * No authentication needed (localhost-only on your machine).
 *
 * Phase 5: Initial implementation.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AuditLogger } from './audit.js';
import type { MemoryStore } from './memory.js';
import type { ApprovalStore } from './approval-store.js';
import type { SecureClawConfig } from './config.js';

const DASHBOARD_PORT = 3333;
const DASHBOARD_HOST = '127.0.0.1';

// ---------------------------------------------------------------------------
// SSE Client Management
// ---------------------------------------------------------------------------

const sseClients: Set<http.ServerResponse> = new Set();

/**
 * Send an event to all connected SSE clients.
 */
export function broadcastSSE(event: string, data: unknown): void {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(message);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ---------------------------------------------------------------------------
// Dashboard Server
// ---------------------------------------------------------------------------

export function startDashboard(
  auditLogger: AuditLogger,
  memoryStore: MemoryStore,
  approvalStore: ApprovalStore,
  config: SecureClawConfig,
): http.Server | null {
  try {
    const server = http.createServer((req, res) => {
      // Security: reject non-localhost requests
      const remoteAddr = req.socket.remoteAddress;
      if (remoteAddr !== '127.0.0.1' && remoteAddr !== '::1' && remoteAddr !== '::ffff:127.0.0.1') {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: Dashboard is localhost-only');
        return;
      }

      // CORS headers for local development
      res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3333');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host}`);

      try {
        handleRequest(url, req, res, auditLogger, memoryStore, approvalStore, config);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('[dashboard] Request error:', error.message);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      }
    });

    server.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
      console.log(`[dashboard] Web dashboard running at http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`);
    });

    server.on('error', (err) => {
      console.warn(`[dashboard] Failed to start: ${err.message}`);
    });

    return server;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.warn(`[dashboard] Failed to start: ${error.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Request Handler
// ---------------------------------------------------------------------------

function handleRequest(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  auditLogger: AuditLogger,
  memoryStore: MemoryStore,
  approvalStore: ApprovalStore,
  config: SecureClawConfig,
): void {
  const pathname = url.pathname;

  // API endpoints
  if (pathname === '/api/audit') {
    handleAuditAPI(url, res);
    return;
  }

  if (pathname === '/api/audit/stream') {
    handleAuditStream(req, res);
    return;
  }

  if (pathname === '/api/memories') {
    const memories = memoryStore.getAll();
    sendJSON(res, memories);
    return;
  }

  if (pathname === '/api/sessions') {
    // Get sessions for a specific user, or all users via direct query
    const userId = url.searchParams.get('userId');
    if (userId) {
      const sessions = memoryStore.getRecentSessions(userId, 50);
      sendJSON(res, sessions);
    } else {
      // No userId filter — get all recent sessions
      const sessions = memoryStore.getAllRecentSessions(50);
      sendJSON(res, sessions);
    }
    return;
  }

  if (pathname === '/api/approvals') {
    const approvals = approvalStore.getRecent(50);
    sendJSON(res, approvals);
    return;
  }

  if (pathname === '/api/config') {
    // Return sanitized config (no secrets)
    const sanitized = {
      llm: config.llm,
      executors: {
        shell: { ...config.executors.shell },
        file: { ...config.executors.file },
        web: { ...config.executors.web },
      },
      mounts: config.mounts.map((m) => ({
        name: m.name,
        containerPath: m.containerPath,
        readOnly: m.readOnly,
      })),
      actionTiers: config.actionTiers,
      trustedDomains: config.trustedDomains,
      heartbeats: config.heartbeats,
    };
    sendJSON(res, sanitized);
    return;
  }

  // Static file serving
  serveStatic(pathname, res);
}

// ---------------------------------------------------------------------------
// Audit API
// ---------------------------------------------------------------------------

function handleAuditAPI(url: URL, res: http.ServerResponse): void {
  const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0]!;
  const type = url.searchParams.get('type');
  const sessionId = url.searchParams.get('sessionId');
  const limit = parseInt(url.searchParams.get('limit') || '200', 10);

  const auditDir = process.env['AUDIT_DIR'] || '/data/audit';
  const filePath = path.join(auditDir, `audit-${date}.jsonl`);

  if (!fs.existsSync(filePath)) {
    sendJSON(res, []);
    return;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  let entries = content
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null);

  // Apply filters
  if (type) {
    entries = entries.filter((e) => e['type'] === type);
  }
  if (sessionId) {
    entries = entries.filter((e) => e['sessionId'] === sessionId);
  }

  // Return most recent entries first, limited
  entries = entries.reverse().slice(0, limit);
  sendJSON(res, entries);
}

// ---------------------------------------------------------------------------
// SSE Audit Stream
// ---------------------------------------------------------------------------

function handleAuditStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  // Send initial connection event
  res.write(`event: connected\ndata: {"time":"${new Date().toISOString()}"}\n\n`);

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
}

// ---------------------------------------------------------------------------
// Static File Serving
// ---------------------------------------------------------------------------

const STATIC_DIR = path.resolve(__dirname, '../public');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(pathname: string, res: http.ServerResponse): void {
  if (pathname === '/') pathname = '/index.html';

  // Prevent path traversal
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(STATIC_DIR, safePath);

  // Ensure the resolved path is within STATIC_DIR
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(filePath)) {
    // Fall back to serving the inline dashboard HTML
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getDashboardHTML());
    return;
  }

  const ext = path.extname(filePath);
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

  const content = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': mimeType });
  res.end(content);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJSON(res: http.ServerResponse, data: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Inline Dashboard HTML (fallback when no static files)
// ---------------------------------------------------------------------------

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SecureClaw Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0d1117; color: #c9d1d9; }
    .header { background: #161b22; border-bottom: 1px solid #30363d; padding: 16px 24px; display: flex; align-items: center; gap: 12px; }
    .header h1 { font-size: 20px; color: #f0f6fc; }
    .header .badge { background: #238636; color: #fff; padding: 2px 8px; border-radius: 12px; font-size: 12px; }
    .nav { display: flex; gap: 0; background: #161b22; border-bottom: 1px solid #30363d; padding: 0 24px; }
    .nav button { background: none; border: none; color: #8b949e; padding: 12px 16px; cursor: pointer; font-size: 14px; border-bottom: 2px solid transparent; transition: all 0.2s; }
    .nav button:hover { color: #c9d1d9; }
    .nav button.active { color: #f0f6fc; border-bottom-color: #f78166; }
    .content { padding: 24px; max-width: 1400px; margin: 0 auto; }
    .panel { display: none; }
    .panel.active { display: block; }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 6px; margin-bottom: 16px; overflow: hidden; }
    .card-header { padding: 12px 16px; border-bottom: 1px solid #30363d; font-weight: 600; font-size: 14px; display: flex; justify-content: space-between; align-items: center; }
    .card-body { padding: 16px; }
    .card-body pre { white-space: pre-wrap; word-break: break-all; font-size: 13px; line-height: 1.5; font-family: 'SF Mono', Monaco, Consolas, monospace; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #21262d; font-size: 13px; }
    th { color: #8b949e; font-weight: 600; }
    .tag { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
    .tag-blue { background: #1f6feb33; color: #58a6ff; }
    .tag-green { background: #23863633; color: #3fb950; }
    .tag-red { background: #da363333; color: #f85149; }
    .tag-yellow { background: #9e6a0333; color: #d29922; }
    .tag-purple { background: #8957e533; color: #bc8cff; }
    .tag-gray { background: #30363d; color: #8b949e; }
    .filters { display: flex; gap: 12px; margin-bottom: 16px; flex-wrap: wrap; }
    .filters select, .filters input { background: #0d1117; border: 1px solid #30363d; color: #c9d1d9; padding: 6px 12px; border-radius: 6px; font-size: 13px; }
    .empty { text-align: center; padding: 40px; color: #8b949e; }
    .expandable { cursor: pointer; }
    .expandable:hover { background: #1c2128; }
    .expand-content { display: none; padding: 12px 16px; background: #0d1117; border-top: 1px solid #21262d; }
    .expand-content.open { display: block; }
    .live-indicator { display: inline-block; width: 8px; height: 8px; background: #3fb950; border-radius: 50%; margin-right: 6px; animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
    .memory-category { margin-bottom: 20px; }
    .memory-category h3 { font-size: 14px; color: #8b949e; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 1px; }
    .status-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 6px; }
    .status-active { background: #3fb950; }
    .status-completed { background: #58a6ff; }
    .status-failed { background: #f85149; }
    .status-pending { background: #d29922; }
  </style>
</head>
<body>
  <div class="header">
    <h1>SecureClaw</h1>
    <span class="badge">Dashboard</span>
  </div>
  <div class="nav">
    <button class="active" onclick="showPanel('audit')">Audit Log</button>
    <button onclick="showPanel('memories')">Memories</button>
    <button onclick="showPanel('sessions')">Sessions</button>
    <button onclick="showPanel('approvals')">Approvals</button>
    <button onclick="showPanel('config')">Config</button>
  </div>
  <div class="content">
    <!-- Audit Log Panel -->
    <div id="panel-audit" class="panel active">
      <div class="filters">
        <input type="date" id="audit-date" onchange="loadAudit()">
        <select id="audit-type" onchange="loadAudit()">
          <option value="">All Types</option>
          <option value="message_received">Message Received</option>
          <option value="llm_request">LLM Request</option>
          <option value="llm_response">LLM Response</option>
          <option value="tool_call">Tool Call</option>
          <option value="tool_result">Tool Result</option>
          <option value="action_classified">Action Classified</option>
          <option value="approval_requested">Approval Requested</option>
          <option value="approval_resolved">Approval Resolved</option>
          <option value="message_sent">Message Sent</option>
          <option value="error">Error</option>
        </select>
        <span><span class="live-indicator"></span>Live streaming</span>
      </div>
      <div id="audit-entries"></div>
    </div>

    <!-- Memories Panel -->
    <div id="panel-memories" class="panel">
      <div id="memory-list"></div>
    </div>

    <!-- Sessions Panel -->
    <div id="panel-sessions" class="panel">
      <div id="session-list"></div>
    </div>

    <!-- Approvals Panel -->
    <div id="panel-approvals" class="panel">
      <div id="approval-list"></div>
    </div>

    <!-- Config Panel -->
    <div id="panel-config" class="panel">
      <div class="card">
        <div class="card-header">Current Configuration (read-only)</div>
        <div class="card-body"><pre id="config-content"></pre></div>
      </div>
    </div>
  </div>

  <script>
    const typeColors = {
      message_received: 'blue', llm_request: 'purple', llm_response: 'purple',
      tool_call: 'yellow', tool_result: 'green', action_classified: 'gray',
      approval_requested: 'red', approval_resolved: 'green', message_sent: 'blue', error: 'red',
    };

    function showPanel(name) {
      document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
      document.getElementById('panel-' + name).classList.add('active');
      event.target.classList.add('active');
      if (name === 'memories') loadMemories();
      if (name === 'sessions') loadSessions();
      if (name === 'approvals') loadApprovals();
      if (name === 'config') loadConfig();
    }

    // Audit
    async function loadAudit() {
      const date = document.getElementById('audit-date').value || new Date().toISOString().split('T')[0];
      const type = document.getElementById('audit-type').value;
      let url = '/api/audit?date=' + date;
      if (type) url += '&type=' + type;
      const res = await fetch(url);
      const entries = await res.json();
      renderAudit(entries);
    }

    function renderAudit(entries) {
      const container = document.getElementById('audit-entries');
      if (entries.length === 0) {
        container.innerHTML = '<div class="empty">No audit entries found</div>';
        return;
      }
      container.innerHTML = entries.map((e, i) => {
        const color = typeColors[e.type] || 'gray';
        const time = new Date(e.timestamp).toLocaleTimeString();
        const dataStr = JSON.stringify(e.data, null, 2);
        return '<div class="card"><div class="card-header expandable" onclick="toggleExpand(' + i + ')">' +
          '<span><span class="tag tag-' + color + '">' + e.type + '</span> ' + time + '</span>' +
          '<span style="color:#8b949e;font-size:12px">' + (e.sessionId || '').slice(0, 8) + '</span></div>' +
          '<div id="expand-' + i + '" class="expand-content"><pre>' + escapeHtml(dataStr) + '</pre></div></div>';
      }).join('');
    }

    function toggleExpand(i) {
      document.getElementById('expand-' + i).classList.toggle('open');
    }

    // SSE
    const evtSource = new EventSource('/api/audit/stream');
    evtSource.addEventListener('audit', (e) => {
      const entry = JSON.parse(e.data);
      const container = document.getElementById('audit-entries');
      const color = typeColors[entry.type] || 'gray';
      const time = new Date(entry.timestamp).toLocaleTimeString();
      const idx = 'live-' + Date.now();
      const html = '<div class="card" style="border-color:#238636"><div class="card-header expandable" onclick="document.getElementById(\\'' + idx + '\\').classList.toggle(\\'open\\')">' +
        '<span><span class="tag tag-' + color + '">' + entry.type + '</span> ' + time + ' <span class="live-indicator"></span></span></div>' +
        '<div id="' + idx + '" class="expand-content"><pre>' + escapeHtml(JSON.stringify(entry.data, null, 2)) + '</pre></div></div>';
      container.insertAdjacentHTML('afterbegin', html);
    });

    // Memories
    async function loadMemories() {
      const res = await fetch('/api/memories');
      const memories = await res.json();
      const container = document.getElementById('memory-list');
      if (memories.length === 0) { container.innerHTML = '<div class="empty">No memories stored</div>'; return; }
      const grouped = {};
      memories.forEach(m => { (grouped[m.category] = grouped[m.category] || []).push(m); });
      container.innerHTML = Object.entries(grouped).map(([cat, items]) =>
        '<div class="memory-category"><h3>' + cat + '</h3>' +
        items.map(m => '<div class="card"><div class="card-header">' + escapeHtml(m.topic) +
          '<span style="color:#8b949e;font-size:12px">' + new Date(m.updatedAt).toLocaleDateString() + '</span></div>' +
          '<div class="card-body"><pre>' + escapeHtml(m.content) + '</pre></div></div>').join('') + '</div>'
      ).join('');
    }

    // Sessions
    async function loadSessions() {
      const res = await fetch('/api/sessions');
      const sessions = await res.json();
      const container = document.getElementById('session-list');
      if (sessions.length === 0) { container.innerHTML = '<div class="empty">No sessions</div>'; return; }
      container.innerHTML = '<table><tr><th>Status</th><th>Request</th><th>Progress</th><th>Created</th></tr>' +
        sessions.map(s => '<tr><td><span class="status-dot status-' + s.status + '"></span>' + s.status + '</td>' +
          '<td>' + escapeHtml((s.originalRequest || '').slice(0, 100)) + '</td>' +
          '<td>' + s.iteration + '/' + s.maxIterations + '</td>' +
          '<td>' + new Date(s.createdAt).toLocaleString() + '</td></tr>').join('') + '</table>';
    }

    // Approvals
    async function loadApprovals() {
      const res = await fetch('/api/approvals');
      const approvals = await res.json();
      const container = document.getElementById('approval-list');
      if (approvals.length === 0) { container.innerHTML = '<div class="empty">No approvals</div>'; return; }
      container.innerHTML = '<table><tr><th>Status</th><th>Tool</th><th>Reason</th><th>Created</th></tr>' +
        approvals.map(a => {
          const statusColor = a.status === 'approved' ? 'green' : a.status === 'rejected' ? 'red' : a.status === 'pending' ? 'yellow' : 'gray';
          return '<tr><td><span class="tag tag-' + statusColor + '">' + a.status + '</span></td>' +
            '<td>' + escapeHtml(a.toolName || a.tool_name || '') + '</td>' +
            '<td>' + escapeHtml((a.reason || '').slice(0, 80)) + '</td>' +
            '<td>' + new Date(a.createdAt || a.created_at || '').toLocaleString() + '</td></tr>';
        }).join('') + '</table>';
    }

    // Config
    async function loadConfig() {
      const res = await fetch('/api/config');
      const config = await res.json();
      document.getElementById('config-content').textContent = JSON.stringify(config, null, 2);
    }

    function escapeHtml(str) {
      return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // Init
    document.getElementById('audit-date').value = new Date().toISOString().split('T')[0];
    loadAudit();
  </script>
</body>
</html>`;
}
