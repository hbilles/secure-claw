#!/bin/bash
# SecureClaw MCP Executor Entrypoint
#
# For containers with network access (HTTPS_PROXY is set):
# 1. Parse the proxy address to get the Gateway proxy host:port
# 2. Apply iptables rules: DROP all outbound except loopback, DNS, and proxy
# 3. Drop privileges to mcpuser (UID 1000)
# 4. Exec the MCP server command
#
# For containers WITHOUT network (--network=none):
# Simply drops to mcpuser and execs the command (no iptables needed).

set -euo pipefail

# If HTTPS_PROXY is set, this is a network-enabled container.
# Lock down outbound to ONLY the proxy.
if [ -n "${HTTPS_PROXY:-}" ]; then
    # Parse proxy address: http://host:port or https://host:port
    PROXY_URL="${HTTPS_PROXY}"
    # Strip protocol
    PROXY_HOSTPORT="${PROXY_URL#*://}"
    # Strip trailing slash
    PROXY_HOSTPORT="${PROXY_HOSTPORT%/}"
    # Extract host and port
    PROXY_HOST="${PROXY_HOSTPORT%:*}"
    PROXY_PORT="${PROXY_HOSTPORT##*:}"

    echo "[entrypoint-mcp] Applying iptables rules (proxy: ${PROXY_HOST}:${PROXY_PORT})"

    # Flush existing rules
    iptables -F OUTPUT 2>/dev/null || true

    # Default policy: DROP all outbound
    iptables -P OUTPUT DROP

    # Allow loopback (localhost)
    iptables -A OUTPUT -o lo -j ACCEPT

    # Allow DNS (UDP and TCP port 53) — needed for proxy hostname resolution
    iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
    iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

    # Allow traffic to the proxy host:port ONLY
    iptables -A OUTPUT -d "${PROXY_HOST}" -p tcp --dport "${PROXY_PORT}" -j ACCEPT

    # Allow established/related connections (for return traffic)
    iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

    echo "[entrypoint-mcp] iptables rules applied successfully"
else
    echo "[entrypoint-mcp] No proxy configured — running without network restrictions"
fi

# Drop privileges to mcpuser and exec the MCP server command.
# The command is passed as arguments to this entrypoint (via Docker Cmd).
if [ "$(id -u)" = "0" ]; then
    echo "[entrypoint-mcp] Dropping to mcpuser (UID 1000)"
    exec gosu mcpuser "$@"
else
    # Already running as non-root
    exec "$@"
fi
