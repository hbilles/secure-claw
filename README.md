# SecureClaw

A security-first personal AI agent framework in TypeScript. Security boundaries are enforced by the runtime — Docker containers, filesystem mounts, network policies — not by prompt instructions. A compromised LLM cannot escape its sandbox.

## Core Principles

1. **Architectural Isolation** — Every executor runs in a dedicated Docker container with `--cap-drop=ALL`, no-new-privileges, non-root user, and no network access by default. Security is structural, not prompt-level.

2. **Capability-Based Access** — Each executor task receives a short-lived JWT capability token encoding exactly which mounts, network domains, and timeouts are permitted. No ambient authority.

3. **Manager Blindness** — The Gateway (the "brain") never touches files, runs commands, or reads raw data directly. It plans and delegates. A prompt injection cannot gain direct tool access because the LLM process has no tools of its own.

4. **Human-in-the-Loop Gate** — Irreversible actions (send email, write outside sandbox, create GitHub issues) require explicit user approval via Telegram inline buttons. Classification is performed in code by the Gateway, not self-reported by the LLM.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│ INTERFACE                                                           │
│ ┌────────────────────────────┐  ┌────────────────────────────────┐  │
│ │ Telegram Bridge (grammY)   │  │ Web Dashboard (localhost)      │  │
│ │ Long-polling · allowlist   │  │ SSE live audit · REST API      │  │
│ └────────────────────────────┘  └────────────────────────────────┘  │
│          Unix socket                       HTTP :3333               │
├─────────────────────────────────────────────────────────────────────┤
│ GATEWAY                                                             │
│ ┌───────────────────────────────────────────────────────────────┐   │
│ │ Orchestrator · LLM client · HITL gate · dispatcher · memory   │   │
│ │ prompt builder · task loop · scheduler · audit logger         │   │
│ │ services: Gmail, Calendar, GitHub (OAuth, in-process)         │   │
│ └───────────────────────────────────────────────────────────────┘   │
│       Docker API             Docker API            Docker API       │
├─────────────────────────────────────────────────────────────────────┤
│ EXECUTORS (ephemeral containers)                                    │
│ ┌────────────────┐  ┌────────────────┐  ┌────────────────────────┐  │
│ │ Shell          │  │ File           │  │ Web                    │  │
│ │ Alpine, no net │  │ Scoped mounts  │  │ Playwright + Chromium  │  │
│ │ r/o by default │  │ no network     │  │ DNS/iptables/SSRF      │  │
│ └────────────────┘  └────────────────┘  └────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

The Gateway is the only process with LLM API keys, the Docker socket, and outbound internet access. Executors are created on-demand as containers, given a capability token, and removed after execution.

## Project Structure

```
secure-claw/
├── packages/
│   ├── gateway/             # Central orchestrator (the only process with API keys)
│   │   └── src/
│   │       ├── index.ts             # Entrypoint — wires everything together
│   │       ├── orchestrator.ts      # Agentic tool-use loop with Claude
│   │       ├── dispatcher.ts        # Docker container lifecycle + capability minting
│   │       ├── hitl-gate.ts         # Action classification + approval queue
│   │       ├── classifier.ts        # Rule engine for action tier matching
│   │       ├── loop.ts              # Ralph Wiggum loop (multi-step tasks)
│   │       ├── memory.ts            # SQLite-backed persistent memory (FTS5)
│   │       ├── prompt-builder.ts    # Context-aware system prompt assembly
│   │       ├── scheduler.ts         # Cron-based heartbeat triggers
│   │       ├── dashboard.ts         # Localhost-only web UI (SSE + REST)
│   │       ├── audit.ts             # Append-only JSONL audit logger
│   │       ├── config.ts            # YAML config loader + validation
│   │       ├── approval-store.ts    # SQLite approval persistence
│   │       └── services/
│   │           ├── gmail.ts         # Gmail API (search, read, send, reply)
│   │           ├── calendar.ts      # Google Calendar API (list, create, update)
│   │           ├── github.ts        # GitHub API (repos, issues, PRs, file read)
│   │           └── oauth.ts         # OAuth flow + encrypted token storage
│   │
│   ├── bridge-telegram/     # Telegram ↔ Gateway adapter
│   │   └── src/
│   │       └── index.ts             # grammY bot, allowlist, inline keyboards,
│   │                                # commands: /memories /forget /sessions /stop /heartbeats
│   │
│   ├── executor-shell/      # Sandboxed command execution
│   │   └── src/
│   │       └── index.ts             # Receives task, validates capability token, runs command
│   │
│   ├── executor-file/       # Scoped file operations
│   │   └── src/
│   │       └── index.ts             # list, read, write, search (ripgrep), stat
│   │
│   ├── executor-web/        # Headless browser
│   │   └── src/
│   │       ├── index.ts             # Playwright automation, accessibility tree extraction
│   │       ├── dns-proxy.ts         # DNS resolver with domain allowlist
│   │       └── accessibility-tree.ts
│   │
│   └── shared/              # Shared types and utilities
│       └── src/
│           ├── types.ts             # Message, Session, AuditEntry, ExecutorResult, etc.
│           ├── socket.ts            # Unix domain socket server/client (JSON-lines)
│           └── capability-token.ts  # JWT mint/verify for capability tokens
│
├── config/
│   └── secureclaw.yaml      # LLM, executor, mount, HITL, heartbeat, OAuth config
├── docker-compose.yml        # Gateway + Bridge as services; executors built but not run
├── .env.example              # Required environment variables
└── package.json              # npm workspaces monorepo root
```

## How It Works

### Message Lifecycle

```
User (Telegram) → Bridge → Gateway → LLM → [tool calls] → Executors → LLM → Bridge → User
```

1. **Receive** — The Telegram Bridge polls the Bot API via grammY. It validates the sender's user ID against the allowlist and converts the Telegram message into an internal `Message` format. The message is sent to the Gateway over a Unix domain socket (JSON-lines protocol).

2. **Plan** — The Gateway loads the user's session and relevant memories, assembles a system prompt (with memories, available tools, and session context), and sends it to Claude. The LLM responds with either a text reply or `tool_use` blocks.

3. **Gate** — For each tool call, the HITL Gate classifies the action into one of three tiers based on the tool name and its inputs (path patterns, working directory, etc.):
   - **auto-approve**: Safe read operations (read file, search, list directory, search email)
   - **notify**: Moderate-risk operations (write to sandbox, browse trusted domains) — executes and notifies the user
   - **require-approval**: Irreversible actions (send email, write outside sandbox, create GitHub issue) — pauses execution and sends an inline-keyboard approval request to Telegram

4. **Execute** — The Gateway's Dispatcher creates an ephemeral Docker container for the appropriate executor, passing a JWT capability token and the task payload. The container starts, validates the token, executes the operation, writes a JSON result to stdout, and exits. The Dispatcher reads the result and removes the container. Service tools (Gmail, Calendar, GitHub) execute in-process within the Gateway using OAuth tokens.

5. **Respond** — Tool results are fed back to the LLM for synthesis. The loop repeats (up to 10 iterations) until the LLM responds with plain text. The final response flows back through the bridge to Telegram. Every step is logged to the append-only audit trail.

### Multi-Step Tasks (Ralph Wiggum Loop)

For complex tasks that would exceed the LLM's context window, the TaskLoop:

1. Detects multi-step requests (conjunctions, multiple sub-tasks)
2. Creates a task session with a plan
3. Runs the orchestrator with a fresh context each iteration, injecting only the compressed session state (plan + progress)
4. Detects a `[CONTINUE]` marker in the LLM's response to trigger the next iteration
5. Resets context completely between iterations to prevent unbounded token growth
6. Continues until the task is complete or a max of 10 iterations is reached

Users can cancel in-progress tasks with the `/stop` command.

### Proactive Heartbeats

The scheduler triggers cron-based heartbeats (e.g., morning briefing at 8am weekdays, periodic email checks). Each heartbeat creates a fresh session with a predefined prompt. The HITL gate still applies — a heartbeat that triggers a dangerous action requires approval like any other request.

## Tools

The LLM has access to these tools, each routed through the HITL gate:

| Tool | Executor | Description |
|------|----------|-------------|
| `run_shell_command` | Shell container | Run a command in an isolated container |
| `read_file` | File container | Read file contents |
| `write_file` | File container | Write content to a file |
| `list_directory` | File container | List directory contents |
| `search_files` | File container | ripgrep pattern search |
| `browse_web` | Web container | Navigate URLs, extract accessibility tree |
| `save_memory` | In-process | Save to persistent memory store |
| `search_memory` | In-process | Full-text search over memories |
| `search_email` | In-process | Gmail search |
| `read_email` | In-process | Read email by ID |
| `send_email` | In-process | Send email (requires approval) |
| `reply_email` | In-process | Reply to email (requires approval) |
| `list_events` | In-process | List Google Calendar events |
| `create_event` | In-process | Create calendar event (requires approval) |
| `update_event` | In-process | Update calendar event (requires approval) |
| `search_repos` | In-process | Search GitHub repositories |
| `list_issues` | In-process | List GitHub issues |
| `read_file_github` | In-process | Read a file from a GitHub repo |
| `create_issue` | In-process | Create GitHub issue (requires approval) |
| `create_pr` | In-process | Create GitHub PR (requires approval) |

## Security Model

### L1 — Container Isolation

Every executor runs in a separate Docker container with:
- `--cap-drop=ALL` (no Linux capabilities)
- `--security-opt=no-new-privileges`
- Non-root execution (UID 1000)
- Memory and CPU limits from config
- Timeout enforcement (container killed if exceeded)

### L2 — Network Segmentation

- Shell and File executors: `--network=none` (no network at all)
- Web executor: iptables rules allowing only TCP 443 to resolved IPs of explicitly allowed domains. Private IP ranges (10.x, 172.16.x, 192.168.x) are blocked to prevent SSRF. DNS resolution goes through a custom proxy that enforces the domain allowlist.
- Gateway: Outbound HTTPS only (LLM API, Google APIs, GitHub API)
- Bridge: Outbound to Telegram API only

### L3 — Capability Tokens

Each executor task includes a JWT (HS256, signed by the Gateway) encoding:
- Which mount paths are accessible (and whether read-only or read-write)
- Which network domains are reachable (web executor)
- A timeout after which the container is killed
- Maximum output size

The executor runtime validates the token before executing anything.

### L4 — Human-in-the-Loop Gate

Actions are classified by the Gateway in code, not by the LLM. The classification rules in `secureclaw.yaml` match on tool name and input field patterns (e.g., path glob, working directory). If no rule matches, the default is **require-approval** (fail-safe). Approval requests are sent to Telegram as inline keyboard buttons.

### L5 — Audit Trail

Every event is logged to an append-only JSONL audit log: messages received, LLM requests/responses, tool calls, tool results, action classifications, approval decisions, and errors. The web dashboard provides live SSE streaming and paginated querying of the log.

## Configuration

### Environment Variables (`.env`)

```sh
TELEGRAM_BOT_TOKEN=your-telegram-bot-token
ALLOWED_USER_IDS=123456789         # Comma-separated Telegram user IDs
ANTHROPIC_API_KEY=sk-ant-...
CAPABILITY_SECRET=random-secret    # Signs executor capability tokens
OAUTH_KEY=encryption-passphrase   # Optional — encrypts OAuth tokens at rest
```

### `config/secureclaw.yaml`

Controls the entire system:

- **`llm`** — Model and token limits (default: `claude-sonnet-4-20250514`)
- **`executors`** — Per-executor image, memory/CPU limits, timeouts, output caps. The web executor also specifies its domain allowlist here.
- **`mounts`** — Host directory → container path mappings with read/write permissions. These define what the file and shell executors can see.
- **`actionTiers`** — HITL classification rules. Ordered lists of tool + condition patterns for `autoApprove`, `notify`, and `requireApproval`.
- **`trustedDomains`** — Domains that downgrade `browse_web` from require-approval to notify tier.
- **`heartbeats`** — Cron schedules for proactive agent triggers with prompt templates.
- **`oauth`** — Google and GitHub OAuth client credentials for service integrations.

## Getting Started

### Prerequisites

- Node.js 22+
- Docker and Docker Compose
- A Telegram bot token (from [@BotFather](https://t.me/botfather))
- An Anthropic API key

### Setup

```sh
git clone <repo-url> && cd secure-claw
npm install
cp .env.example .env
# Edit .env with your tokens and secrets
# Edit config/secureclaw.yaml to configure mounts and HITL rules
```

### Running with Docker (recommended)

```sh
# Build all images (including executors) and start the gateway + bridge
docker compose up --build
```

The gateway and bridge run as persistent services. Executor containers are created on-demand by the gateway's Dispatcher via the Docker socket — they are not long-running services.

### Running in Development

```sh
npm run dev
```

Runs the gateway and bridge-telegram concurrently with watch mode via `concurrently`. Executor containers are still managed via Docker — the gateway needs Docker socket access even in dev mode.

### Web Dashboard

Available at `http://127.0.0.1:3333` when the gateway is running. Provides:
- Live audit log stream (SSE)
- Memory browser
- Task session viewer
- Approval queue
- Configuration viewer (read-only)

### Telegram Commands

| Command | Description |
|---------|-------------|
| `/memories` | List stored memories (paginated, by category) |
| `/forget <topic>` | Delete a specific memory |
| `/sessions` | Show active and recent task sessions |
| `/stop` | Cancel the current multi-step task |
| `/heartbeats` | List and toggle heartbeat schedules |

### OAuth Setup (optional)

To enable Gmail, Calendar, or GitHub integrations:

1. Create OAuth credentials in the Google Cloud Console / GitHub Developer Settings
2. Add the client ID and secret to `config/secureclaw.yaml` under the `oauth` key
3. Start the system — the gateway exposes a temporary callback server on `localhost:9876`
4. Use the OAuth flow URL logged at startup to authorize each service
5. Tokens are stored encrypted (AES-256-GCM) using the `OAUTH_KEY` env var, or in macOS Keychain if available

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Language | TypeScript 5.7, ES2022 |
| Runtime | Node.js 22+ |
| LLM | Anthropic Claude (Sonnet 4) |
| Bot framework | grammY (Telegram Bot API) |
| Containers | Docker + Docker Compose |
| Database | SQLite (better-sqlite3) with FTS5 |
| Browser automation | Playwright (Chromium) |
| Google APIs | googleapis (Gmail, Calendar) |
| GitHub API | @octokit/rest |
| IPC | Unix domain sockets (JSON-lines) |
| Auth | JWT (capability tokens), AES-256-GCM (OAuth storage) |
