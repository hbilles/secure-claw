# ---- Build stage ----
FROM node:22-alpine AS builder
WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./

# Copy package.json files for workspace resolution
COPY packages/shared/package.json packages/shared/
COPY packages/gateway/package.json packages/gateway/

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

# Copy built output and package.json for each workspace package
COPY --from=builder /app/packages/shared/dist/ packages/shared/dist/
COPY --from=builder /app/packages/shared/package.json packages/shared/
COPY --from=builder /app/packages/gateway/dist/ packages/gateway/dist/
COPY --from=builder /app/packages/gateway/package.json packages/gateway/

# Install production dependencies only
RUN npm ci --omit=dev --workspace=packages/shared --workspace=packages/gateway --include-workspace-root

# Create audit log directory and socket directory with correct ownership
RUN mkdir -p /data/audit && chown -R app:app /data
RUN mkdir -p /tmp/sockets && chown app:app /tmp/sockets

# Switch to non-root user
USER app

EXPOSE 0

CMD ["node", "packages/gateway/dist/index.js"]
