# SecureClaw MCP Executor — Generic base image for MCP servers.
#
# MCP servers run as long-lived containers (unlike shell/file/web executors
# which are created per task). This image provides:
#
# - Node.js 22 runtime for npx-based MCP servers
# - iptables for network-restricted containers (outbound locked to proxy only)
# - entrypoint script that applies iptables rules then drops to non-root
# - Non-root user (node, UID 1000) for runtime execution
#
# Network modes:
# - No-network: started with --network=none (filesystem MCP servers)
# - Proxied: outbound restricted to Gateway's MCP proxy via iptables
#
# The actual MCP server command is provided at container creation time
# via the Cmd override from McpContainerManager.

FROM ghcr.io/github/github-mcp-server:latest AS github-mcp

FROM node:22-bookworm-slim

# Install iptables for network-mode containers and common utilities.
# tini provides proper signal handling for the entrypoint.
RUN apt-get update && apt-get install -y --no-install-recommends \
    iptables \
    tini \
    gosu \
    ca-certificates \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Use the existing 'node' user (UID 1000, GID 1000) from the base image.
# This matches the other executor images and the container User constraint.

# Copy the entrypoint script
COPY packages/executor-mcp/entrypoint-mcp.sh /usr/local/bin/entrypoint-mcp.sh
RUN chmod +x /usr/local/bin/entrypoint-mcp.sh

# Pre-build vendored MCP servers into the image.
# This eliminates runtime npx downloads and reduces required network domains.
COPY vendor/fastmail-mcp /opt/fastmail-mcp
RUN cd /opt/fastmail-mcp && npm install --ignore-scripts && npm run build && npm cache clean --force

# Copy official GitHub MCP server binary from upstream image.
COPY --from=github-mcp /server/github-mcp-server /opt/mcp-github/github-mcp-server

# Create a working directory owned by node
RUN mkdir -p /mcp && chown node:node /mcp
WORKDIR /mcp

# Use tini as PID 1 for proper signal handling
ENTRYPOINT ["tini", "--", "/usr/local/bin/entrypoint-mcp.sh"]
