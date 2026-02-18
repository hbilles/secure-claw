# SecureClaw Web Executor
#
# Headless Chromium browser in a sandboxed container with strict network controls.
# Uses the official Playwright image for reliable Chromium support.
#
# Security layers:
# 1. iptables: DROP all outbound except TCP 443 (HTTPS)
# 2. Private IP blocking: defense in depth against SSRF
# 3. DNS proxy: application-level domain allowlist enforcement
# 4. No filesystem mounts from the host
# 5. Non-root execution (after iptables setup)
#
# Note: Requires NET_ADMIN temporarily for iptables setup in entrypoint.
# The capability is dropped before running the executor.

# ---- Build stage ----
FROM node:22-bookworm AS builder

WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./

# Copy package.json files for workspace resolution
COPY packages/shared/package.json packages/shared/
COPY packages/executor-web/package.json packages/executor-web/

# Install dependencies
RUN npm ci --workspace=packages/shared --workspace=packages/executor-web --include-workspace-root

# Copy source files
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/executor-web/ packages/executor-web/

# Build shared first, then executor
RUN npm run build -w packages/shared && npm run build -w packages/executor-web

# ---- Production stage ----
FROM mcr.microsoft.com/playwright:v1.50.0-noble

# Install iptables for network security and bash for entrypoint
RUN apt-get update && \
    apt-get install -y --no-install-recommends iptables && \
    rm -rf /var/lib/apt/lists/*

# Install Node.js 22 (the Playwright image may have an older version)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && \
    apt-get install -y nodejs && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./

# Copy built output and package.json for each workspace package
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/executor-web/dist/ packages/executor-web/dist/
COPY --from=builder /app/packages/executor-web/package.json packages/executor-web/

# Install production dependencies only
RUN npm ci --omit=dev --workspace=packages/shared --workspace=packages/executor-web --include-workspace-root

# Copy entrypoint script
COPY packages/executor-web/entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# The entrypoint runs as root to set iptables, then drops to node user
# NET_ADMIN is required temporarily and dropped in the entrypoint
ENTRYPOINT ["/entrypoint.sh"]
