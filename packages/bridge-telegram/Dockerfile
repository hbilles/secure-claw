# ---- Build stage ----
FROM node:22-alpine AS builder
WORKDIR /app

# Copy root workspace files
COPY package.json package-lock.json ./

# Copy package.json files for workspace resolution
COPY packages/shared/package.json packages/shared/
COPY packages/bridge-telegram/package.json packages/bridge-telegram/

# Install all dependencies (including devDependencies for build)
RUN npm ci --workspace=packages/shared --workspace=packages/bridge-telegram --include-workspace-root

# Copy source files
COPY tsconfig.base.json ./
COPY packages/shared/ packages/shared/
COPY packages/bridge-telegram/ packages/bridge-telegram/

# Build shared first, then bridge
RUN npm run build -w packages/shared && npm run build -w packages/bridge-telegram

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
COPY --from=builder /app/packages/bridge-telegram/dist/ packages/bridge-telegram/dist/
COPY --from=builder /app/packages/bridge-telegram/package.json packages/bridge-telegram/

# Install production dependencies only
RUN npm ci --omit=dev --workspace=packages/shared --workspace=packages/bridge-telegram --include-workspace-root

# Create socket directory with correct ownership
RUN mkdir -p /tmp/sockets && chown app:app /tmp/sockets

# Switch to non-root user
USER app

CMD ["node", "packages/bridge-telegram/dist/index.js"]
