/**
 * Capability Token System — JWT-based tokens defining executor permissions.
 *
 * Tokens encode what an executor container is allowed to do:
 * - Which directories can be mounted (and whether read-only)
 * - Network access policy
 * - Timeout and output size limits
 *
 * Uses HS256 symmetric signing. The signing key is loaded from the
 * CAPABILITY_SECRET env var and should NEVER be exposed to users or bridges.
 * Only the Gateway (minting) and Executor containers (verifying) need it.
 *
 * Tokens are short-lived: TTL = timeoutSeconds + 30s buffer.
 */

import jwt from 'jsonwebtoken';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Mount {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
}

export interface Capability {
  executorType: 'shell' | 'file' | 'web' | 'mcp';
  mounts: Mount[];
  network: 'none' | { allowedDomains: string[] };
  timeoutSeconds: number;
  maxOutputBytes: number;
}

// ---------------------------------------------------------------------------
// Token Operations
// ---------------------------------------------------------------------------

/**
 * Mint a capability token (Gateway-side only).
 *
 * The token encodes the full Capability object in the `cap` claim.
 * It expires after timeoutSeconds + 30s buffer, ensuring the token
 * cannot be reused after the executor's expected lifetime.
 */
export function mintCapabilityToken(
  capability: Capability,
  secretKey: string,
): string {
  const ttlSeconds = capability.timeoutSeconds + 30;

  const token = jwt.sign(
    { cap: capability },
    secretKey,
    {
      algorithm: 'HS256',
      expiresIn: ttlSeconds,
      issuer: 'secureclaw-gateway',
    },
  );

  return token;
}

/**
 * Verify and decode a capability token (Executor-side).
 *
 * Returns the Capability if the token is valid and not expired.
 * Throws if the token is invalid, expired, or missing capability data.
 */
export function verifyCapabilityToken(
  token: string,
  secretKey: string,
): Capability {
  const payload = jwt.verify(token, secretKey, {
    algorithms: ['HS256'],
    issuer: 'secureclaw-gateway',
  }) as { cap: Capability };

  if (!payload.cap || !payload.cap.executorType) {
    throw new Error('Invalid capability token: missing capability data');
  }

  return payload.cap;
}
