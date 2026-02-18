/**
 * OAuth Token Manager — encrypted token storage with refresh support.
 *
 * Stores OAuth tokens encrypted with AES-256-GCM in SQLite.
 * Encryption key derivation:
 * 1. Try macOS Keychain via `security` CLI
 * 2. Fall back to OAUTH_KEY environment variable
 *
 * Token lifecycle:
 * - Store: Encrypt and save to SQLite
 * - Retrieve: Decrypt and return, auto-refresh if expired
 * - Refresh: Use refresh_token to get new access_token
 *
 * IMPORTANT: OAuth tokens must NEVER be passed to executor containers.
 * All service calls execute in the Gateway process.
 */

import * as crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface OAuthTokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // Unix timestamp (ms)
  tokenType: string;
  scope?: string;
}

export type ServiceName = 'gmail' | 'calendar' | 'github';

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12; // 96 bits for GCM
const TAG_LENGTH = 16; // 128 bits auth tag

/**
 * Derive a 256-bit key from a passphrase using scrypt.
 */
function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return crypto.scryptSync(passphrase, salt, KEY_LENGTH);
}

/**
 * Encrypt data with AES-256-GCM.
 * Returns: salt(32) + iv(12) + tag(16) + ciphertext as hex.
 */
function encrypt(data: string, passphrase: string): string {
  const salt = crypto.randomBytes(32);
  const key = deriveKey(passphrase, salt);
  const iv = crypto.randomBytes(IV_LENGTH);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  let encrypted = cipher.update(data, 'utf-8', 'hex');
  encrypted += cipher.final('hex');
  const tag = cipher.getAuthTag();

  // Concatenate: salt + iv + tag + ciphertext
  return (
    salt.toString('hex') +
    iv.toString('hex') +
    tag.toString('hex') +
    encrypted
  );
}

/**
 * Decrypt data encrypted with AES-256-GCM.
 */
function decrypt(encryptedHex: string, passphrase: string): string {
  const saltHex = encryptedHex.slice(0, 64); // 32 bytes
  const ivHex = encryptedHex.slice(64, 88); // 12 bytes
  const tagHex = encryptedHex.slice(88, 120); // 16 bytes
  const ciphertext = encryptedHex.slice(120);

  const salt = Buffer.from(saltHex, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const key = deriveKey(passphrase, salt);

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(ciphertext, 'hex', 'utf-8');
  decrypted += decipher.final('utf-8');

  return decrypted;
}

// ---------------------------------------------------------------------------
// Key Management
// ---------------------------------------------------------------------------

/**
 * Get the encryption key from the most secure available source.
 * Priority: macOS Keychain > OAUTH_KEY env var
 */
function getEncryptionKey(): string {
  // Try macOS Keychain first
  try {
    const result = execSync(
      'security find-generic-password -s "secureclaw-oauth" -w 2>/dev/null',
      { encoding: 'utf-8', timeout: 5000 },
    ).trim();
    if (result) {
      console.log('[oauth] Using encryption key from macOS Keychain');
      return result;
    }
  } catch {
    // Keychain not available or key not stored
  }

  // Fall back to environment variable
  const envKey = process.env['OAUTH_KEY'];
  if (envKey) {
    console.log('[oauth] Using encryption key from OAUTH_KEY environment variable');
    return envKey;
  }

  throw new Error(
    'No OAuth encryption key available. ' +
    'Set OAUTH_KEY env var or store in macOS Keychain: ' +
    'security add-generic-password -s "secureclaw-oauth" -a "secureclaw" -w "your-passphrase"',
  );
}

// ---------------------------------------------------------------------------
// OAuth Store
// ---------------------------------------------------------------------------

const DEFAULT_DB_PATH = '/data/tokens.db';

export class OAuthStore {
  private db: Database.Database;
  private encryptionKey: string;
  private stmtGet: Database.Statement;
  private stmtUpsert: Database.Statement;
  private stmtDelete: Database.Statement;
  private stmtList: Database.Statement;

  constructor(dbPath: string = DEFAULT_DB_PATH) {
    this.encryptionKey = getEncryptionKey();

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS oauth_tokens (
        service     TEXT PRIMARY KEY,
        encrypted   TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );
    `);

    this.stmtGet = this.db.prepare(
      `SELECT encrypted FROM oauth_tokens WHERE service = ?`,
    );
    this.stmtUpsert = this.db.prepare(`
      INSERT INTO oauth_tokens (service, encrypted, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(service) DO UPDATE SET encrypted = excluded.encrypted, updated_at = excluded.updated_at
    `);
    this.stmtDelete = this.db.prepare(
      `DELETE FROM oauth_tokens WHERE service = ?`,
    );
    this.stmtList = this.db.prepare(
      `SELECT service, updated_at FROM oauth_tokens`,
    );

    console.log(`[oauth] Token store initialized at ${dbPath}`);
  }

  /**
   * Store an OAuth token (encrypted).
   */
  storeToken(service: ServiceName, tokenData: OAuthTokenData): void {
    const json = JSON.stringify(tokenData);
    const encryptedData = encrypt(json, this.encryptionKey);
    const now = new Date().toISOString();
    this.stmtUpsert.run(service, encryptedData, now);
    console.log(`[oauth] Stored token for ${service}`);
  }

  /**
   * Retrieve an OAuth token (decrypted).
   * Returns null if no token is stored for this service.
   */
  getToken(service: ServiceName): OAuthTokenData | null {
    const row = this.stmtGet.get(service) as { encrypted: string } | undefined;
    if (!row) return null;

    try {
      const json = decrypt(row.encrypted, this.encryptionKey);
      return JSON.parse(json) as OAuthTokenData;
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[oauth] Failed to decrypt token for ${service}:`, error.message);
      return null;
    }
  }

  /**
   * Check if a token is expired (with 5-minute buffer).
   */
  isExpired(tokenData: OAuthTokenData): boolean {
    const bufferMs = 5 * 60 * 1000; // 5 minutes
    return Date.now() >= tokenData.expiresAt - bufferMs;
  }

  /**
   * Delete a stored token.
   */
  deleteToken(service: ServiceName): boolean {
    const result = this.stmtDelete.run(service);
    return result.changes > 0;
  }

  /**
   * List all stored services.
   */
  listServices(): Array<{ service: string; updatedAt: string }> {
    const rows = this.stmtList.all() as Array<{
      service: string;
      updated_at: string;
    }>;
    return rows.map((r) => ({ service: r.service, updatedAt: r.updated_at }));
  }

  /**
   * Check if a service has a stored token.
   */
  hasToken(service: ServiceName): boolean {
    return this.getToken(service) !== null;
  }

  /**
   * Close the database.
   */
  close(): void {
    this.db.close();
    console.log('[oauth] Token store closed');
  }
}
