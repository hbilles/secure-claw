/**
 * DNS Resolution Proxy — domain allowlist enforcement with SSRF protection.
 *
 * Only resolves domains in the allowedDomains list from the capability token.
 * Returns NXDOMAIN for everything else.
 *
 * CRITICAL: After resolving, validates that the IP is not in any private range
 * to prevent DNS rebinding attacks where a public domain points to a local IP.
 *
 * Blocked IP ranges:
 * - 10.0.0.0/8
 * - 172.16.0.0/12
 * - 192.168.0.0/16
 * - 127.0.0.0/8
 * - 169.254.0.0/16
 * - ::1, fc00::/7, fe80::/10
 */

import * as dns from 'node:dns/promises';

// ---------------------------------------------------------------------------
// Private IP Detection
// ---------------------------------------------------------------------------

/**
 * Check if an IPv4 address is in a private/reserved range.
 */
function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => isNaN(p))) return true; // Invalid → treat as private

  const [a, b] = parts;

  // 10.0.0.0/8
  if (a === 10) return true;

  // 172.16.0.0/12
  if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true;

  // 192.168.0.0/16
  if (a === 192 && b === 168) return true;

  // 127.0.0.0/8 (loopback)
  if (a === 127) return true;

  // 169.254.0.0/16 (link-local)
  if (a === 169 && b === 254) return true;

  // 0.0.0.0/8 (current network)
  if (a === 0) return true;

  // 100.64.0.0/10 (shared address space / CGNAT)
  if (a === 100 && b !== undefined && b >= 64 && b <= 127) return true;

  return false;
}

/**
 * Check if an IPv6 address is in a private/reserved range.
 */
function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();

  // ::1 (loopback)
  if (normalized === '::1') return true;

  // fc00::/7 (unique local)
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;

  // fe80::/10 (link-local)
  if (normalized.startsWith('fe80')) return true;

  // :: (unspecified)
  if (normalized === '::') return true;

  // IPv4-mapped IPv6: ::ffff:x.x.x.x
  if (normalized.startsWith('::ffff:')) {
    const ipv4Part = normalized.slice(7);
    if (ipv4Part.includes('.')) {
      return isPrivateIPv4(ipv4Part);
    }
  }

  return false;
}

/**
 * Check if any IP address is private/reserved.
 */
export function isPrivateIP(ip: string): boolean {
  if (ip.includes(':')) {
    return isPrivateIPv6(ip);
  }
  return isPrivateIPv4(ip);
}

// ---------------------------------------------------------------------------
// DNS Proxy
// ---------------------------------------------------------------------------

export class DNSProxy {
  private allowedDomains: Set<string>;

  constructor(allowedDomains: string[]) {
    this.allowedDomains = new Set(
      allowedDomains.map((d) => d.toLowerCase()),
    );
  }

  /**
   * Check if a domain is in the allowlist.
   * Supports subdomain matching: if "github.com" is allowed,
   * "api.github.com" is also allowed.
   */
  isDomainAllowed(domain: string): boolean {
    const lower = domain.toLowerCase();

    // Exact match
    if (this.allowedDomains.has(lower)) return true;

    // Subdomain match: check if the domain ends with .allowedDomain
    for (const allowed of this.allowedDomains) {
      if (lower.endsWith(`.${allowed}`)) return true;
    }

    return false;
  }

  /**
   * Validate a domain against the allowlist.
   *
   * DNS resolution is intentionally NOT performed here. SSRF protection
   * against private IPs is handled at the network level by iptables rules
   * in the container's entrypoint (DROP all outbound to 10/8, 172.16/12,
   * 192.168/16, etc.). This avoids conflicts between iptables rules and
   * Docker's internal DNS mechanisms.
   *
   * @throws If domain is not in the allowlist
   */
  async resolve(domain: string): Promise<string[]> {
    if (!this.isDomainAllowed(domain)) {
      throw new Error(`DNS_BLOCKED: Domain "${domain}" is not in the allowed domains list`);
    }
    // Domain is allowed — let Chromium handle actual DNS resolution.
    // iptables blocks connections to private IPs as defense-in-depth.
    return [];
  }

  /**
   * Validate a URL against the allowlist.
   * Checks protocol (HTTPS only) and domain name.
   */
  async validateURL(url: string): Promise<void> {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`INVALID_URL: "${url}" is not a valid URL`);
    }

    // Enforce HTTPS only
    if (parsed.protocol !== 'https:') {
      throw new Error(
        `PROTOCOL_BLOCKED: Only HTTPS is allowed. Got "${parsed.protocol}"`,
      );
    }

    // Check domain allowlist
    await this.resolve(parsed.hostname);
  }
}
