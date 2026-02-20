# SecureClaw MCP Executor — Generic base image for MCP servers.
#
# MCP servers run as long-lived containers (unlike shell/file/web executors
# which are created per task). This image provides:
#
# - Node.js 22 runtime for npx-based MCP servers
# - iptables for network-restricted containers (outbound locked to proxy only)
# - entrypoint script that applies iptables rules then drops to non-root
# - Non-root user (mcpuser, UID 1000) for runtime execution
#
# Network modes:
# - No-network: started with --network=none (filesystem MCP servers)
# - Proxied: outbound restricted to Gateway's MCP proxy via iptables
#
# The actual MCP server command is provided at container creation time
# via the Cmd override from McpContainerManager.

FROM node:22-bookworm-slim

# Install iptables for network-mode containers and common utilities.
# tini provides proper signal handling for the entrypoint.
RUN apt-get update && apt-get install -y --no-install-recommends \
    iptables \
    tini \
    gosu \
    ca-certificates \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user for MCP server execution
RUN groupadd -g 1000 mcpuser 2>/dev/null || true && \
    useradd -u 1000 -g 1000 -m -s /bin/bash mcpuser 2>/dev/null || true

# Copy the entrypoint script
COPY packages/executor-mcp/entrypoint-mcp.sh /usr/local/bin/entrypoint-mcp.sh
RUN chmod +x /usr/local/bin/entrypoint-mcp.sh

# Create a working directory owned by mcpuser
RUN mkdir -p /mcp && chown mcpuser:mcpuser /mcp
WORKDIR /mcp

# Use tini as PID 1 for proper signal handling
ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint-mcp.sh"]
