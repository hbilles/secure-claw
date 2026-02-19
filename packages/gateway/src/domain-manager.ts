/**
 * DomainManager — manages allowed and trusted web domains at runtime.
 *
 * Maintains a base set of domains from configuration (immutable at runtime)
 * and session-scoped additions from user approvals (per-user, in-memory).
 *
 * Two domain concepts:
 * - **Allowed**: the domain can be resolved and accessed by the web executor.
 *   These are baked into the capability token's allowedDomains list.
 * - **Trusted**: the domain uses "notify" tier instead of "require-approval"
 *   for browse_web calls. Trusted domains are always also allowed.
 *
 * Session-approved domains become both allowed AND trusted.
 */

import type { SecureClawConfig } from './config.js';

export class DomainManager {
  /** Base allowed domains from config (immutable at runtime) */
  private baseAllowedDomains: Set<string>;
  /** Base trusted domains from config (immutable at runtime) */
  private baseTrustedDomains: Set<string>;
  /** Runtime per-user session domains (both allowed and trusted) */
  private sessionDomains: Map<string, Set<string>> = new Map();

  constructor(config: SecureClawConfig) {
    const webConfig = config.executors.web;
    this.baseAllowedDomains = new Set(
      (webConfig?.allowedDomains ?? []).map((d) => d.toLowerCase()),
    );
    this.baseTrustedDomains = new Set(
      (config.trustedDomains ?? []).map((d) => d.toLowerCase()),
    );

    console.log(
      `[domain-manager] Initialized with ${this.baseAllowedDomains.size} allowed, ` +
      `${this.baseTrustedDomains.size} trusted base domains`,
    );
  }

  /**
   * Get the full allowed domains list for a user (base + session).
   * Used to build the capability token for the web executor.
   */
  getAllowedDomains(userId: string): string[] {
    const session = this.sessionDomains.get(userId);
    if (!session || session.size === 0) {
      return [...this.baseAllowedDomains];
    }
    return [...new Set([...this.baseAllowedDomains, ...session])];
  }

  /**
   * Check if a domain is allowed (base or session).
   * Supports exact match and subdomain matching (e.g., api.github.com matches github.com).
   */
  isDomainAllowed(domain: string, userId: string): boolean {
    const lower = domain.toLowerCase();
    return this.matchesDomainSet(lower, this.baseAllowedDomains) ||
           this.matchesDomainSet(lower, this.sessionDomains.get(userId));
  }

  /**
   * Check if a domain is trusted (base or session-approved).
   * Trusted domains use "notify" tier for browse_web.
   */
  isDomainTrusted(domain: string, userId: string): boolean {
    const lower = domain.toLowerCase();
    // Session-approved domains are always trusted
    return this.matchesDomainSet(lower, this.baseTrustedDomains) ||
           this.matchesDomainSet(lower, this.sessionDomains.get(userId));
  }

  /**
   * Add a domain for the session (both allowed and trusted).
   * Called when the user approves a domain request.
   */
  addSessionDomain(userId: string, domain: string): void {
    const lower = domain.toLowerCase();
    let domains = this.sessionDomains.get(userId);
    if (!domains) {
      domains = new Set();
      this.sessionDomains.set(userId, domains);
    }
    domains.add(lower);
    console.log(`[domain-manager] Added session domain for user ${userId}: ${lower}`);
  }

  /**
   * Clear session domains for a user (called on session expiry).
   */
  clearSessionDomains(userId: string): void {
    const had = this.sessionDomains.delete(userId);
    if (had) {
      console.log(`[domain-manager] Cleared session domains for user ${userId}`);
    }
  }

  /**
   * Check if a hostname matches any domain in the given set.
   * Supports exact match and subdomain matching.
   */
  private matchesDomainSet(hostname: string, domains: Set<string> | undefined): boolean {
    if (!domains || domains.size === 0) return false;

    for (const domain of domains) {
      if (hostname === domain || hostname.endsWith(`.${domain}`)) {
        return true;
      }
    }
    return false;
  }
}
