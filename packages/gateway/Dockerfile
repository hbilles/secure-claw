# ---- Build stage ----
FROM node:22-alpine AS builder
WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./

# Copy package.json files for ALL workspace packages.
# npm ci needs to see them all for lock file resolution,
# even though we only build shared + gateway here.
COPY packages/shared/package.json packages/shared/
COPY packages/gateway/package.json packages/gateway/
COPY packages/bridge-telegram/package.json packages/bridge-telegram/
COPY packages/executor-shell/package.json packages/executor-shell/
COPY packages/executor-file/package.json packages/executor-file/
COPY packages/executor-web/package.json packages/executor-web/

# Install build tools for native modules (better-sqlite3)
RUN apk add --no-cache python3 make g++

# Install all dependencies (including devDependencies for build)
RUN npm ci --workspace=packages/shared --workspace=packages/gateway --include-workspace-root

# Copy source files
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/gateway/ packages/gateway/

# Build shared first, then gateway
RUN npm run build -w packages/shared && npm run build -w packages/gateway

# ---- Production stage ----
FROM node:22-alpine

# Create non-root user
RUN addgroup -S app && adduser -S app -G app

WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./

# Copy ALL workspace package.json files for npm ci resolution
COPY packages/shared/package.json packages/shared/
COPY packages/gateway/package.json packages/gateway/
COPY packages/bridge-telegram/package.json packages/bridge-telegram/
COPY packages/executor-shell/package.json packages/executor-shell/
COPY packages/executor-file/package.json packages/executor-file/
COPY packages/executor-web/package.json packages/executor-web/

# Copy built output
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/gateway/dist/ packages/gateway/dist/

# Install production dependencies only (need build tools for better-sqlite3 native module)
RUN apk add --no-cache --virtual .build-deps python3 make g++ && \
    npm ci --omit=dev --workspace=packages/shared --workspace=packages/gateway --include-workspace-root && \
    apk del .build-deps

# Create audit log directory and socket directory with correct ownership
RUN mkdir -p /data/audit && chown -R app:app /data
RUN mkdir -p /tmp/sockets && chown app:app /tmp/sockets

# ⚠️  Docker socket access:
# The Gateway needs /var/run/docker.sock for executor container management.
# This is the ONE privileged operation in the entire system.
# On macOS (Docker Desktop), the socket is world-accessible.
# On Linux, you may need to add the app user to the docker group
# or override the user in docker-compose.yml with:
#   user: "0:0"  # or group_add: [docker]
USER app

EXPOSE 0

CMD ["node", "packages/gateway/dist/index.js"]
