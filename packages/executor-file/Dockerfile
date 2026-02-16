# SecureClaw File Executor
#
# Provides a JSON API for file operations (list, read, write, search, stat).
# Created dynamically by the Gateway's Dispatcher — NOT a long-running service.
#
# Security constraints (applied both here and at container creation time):
# - --cap-drop=ALL: no Linux capabilities
# - --security-opt=no-new-privileges: prevent privilege escalation
# - Non-root user (UID 1000)
# - --network=none: no network access
# - All file access scoped to declared mounts in capability token

# ---- Build stage ----
FROM node:22-alpine AS builder

WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./

# Copy package.json files for workspace resolution
COPY packages/shared/package.json packages/shared/
COPY packages/executor-file/package.json packages/executor-file/

# Install all dependencies (including devDependencies for build)
RUN npm ci --workspace=packages/shared --workspace=packages/executor-file --include-workspace-root

# Copy source files
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/executor-file/ packages/executor-file/

# Build shared first, then executor
RUN npm run build -w packages/shared && npm run build -w packages/executor-file

# ---- Production stage ----
FROM node:22-alpine

# Install ripgrep for fast file searching
RUN apk add --no-cache ripgrep

# Use the existing 'node' user (UID 1000, GID 1000) from the base image.
# This matches the User constraint (UID 1000) set by the Dispatcher.

WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./

# Copy built output and package.json for each workspace package
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/executor-file/dist/ packages/executor-file/dist/
COPY --from=builder /app/packages/executor-file/package.json packages/executor-file/

# Install production dependencies only
RUN npm ci --omit=dev --workspace=packages/shared --workspace=packages/executor-file --include-workspace-root

# Create standard mount-point directories with correct ownership
RUN mkdir -p /workspace /sandbox /documents && \
    chown -R node:node /workspace /sandbox

# Switch to non-root user (node = UID 1000)
USER node

WORKDIR /workspace

CMD ["node", "/app/packages/executor-file/dist/index.js"]
