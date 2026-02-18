#!/bin/bash
# SecureClaw Web Executor Entrypoint
#
# Security setup:
# 1. Set iptables rules (requires NET_ADMIN capability, temporarily)
# 2. Drop NET_ADMIN capability
# 3. Run the executor as a non-root user
#
# Network policy:
# - Default: DROP all outbound
# - ALLOW: DNS (UDP/TCP 53) — must come BEFORE private IP blocking so
#   Docker's internal DNS DNAT (127.0.0.11 → 172.x.x.x:53) still works
# - DROP: outbound to private IP ranges (SSRF defense for HTTPS)
# - ALLOW: outbound TCP 443 (HTTPS only)

set -e

# All entrypoint logging goes to stderr to keep stdout clean for JSON output
echo "[entrypoint] Setting up network security..." >&2

# Flush existing rules
iptables -F OUTPUT 2>/dev/null || true
ip6tables -F OUTPUT 2>/dev/null || true

# Default policy: DROP all outbound
iptables -P OUTPUT DROP
ip6tables -P OUTPUT DROP

# Allow loopback (needed for internal communication)
iptables -A OUTPUT -o lo -j ACCEPT
ip6tables -A OUTPUT -o lo -j ACCEPT

# Allow DNS resolution FIRST — before private IP blocking.
# Docker's embedded DNS (127.0.0.11) uses iptables DNAT to forward
# queries to the Docker daemon at a 172.x.x.x address on port 53.
# If we block private IPs first, the DNATted DNS packets get dropped.
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT

# Block private IP ranges (defense in depth for HTTPS — prevents SSRF)
# These come AFTER DNS so Docker's internal DNS still works.
iptables -A OUTPUT -d 10.0.0.0/8 -j DROP
iptables -A OUTPUT -d 172.16.0.0/12 -j DROP
iptables -A OUTPUT -d 192.168.0.0/16 -j DROP
iptables -A OUTPUT -d 127.0.0.0/8 ! -o lo -j DROP
iptables -A OUTPUT -d 169.254.0.0/16 -j DROP
iptables -A OUTPUT -d 100.64.0.0/10 -j DROP

# Block IPv6 private ranges
ip6tables -A OUTPUT -d ::1/128 ! -o lo -j DROP
ip6tables -A OUTPUT -d fc00::/7 -j DROP
ip6tables -A OUTPUT -d fe80::/10 -j DROP

# Allow HTTPS only (TCP 443)
iptables -A OUTPUT -p tcp --dport 443 -m state --state NEW,ESTABLISHED -j ACCEPT

# Allow established connections back in
iptables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT
ip6tables -A INPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

echo "[entrypoint] iptables rules set. Outbound restricted to HTTPS (443)." >&2

# Write env vars to a temp file for reliable passing through su.
# su -m is unreliable — PAM on Ubuntu can override --preserve-environment.
# printf %q safely escapes any value for shell consumption.
_ENV=/tmp/.executor-env
printf 'export CAPABILITY_TOKEN=%q\nexport TASK=%q\nexport CAPABILITY_SECRET=%q\n' \
  "$CAPABILITY_TOKEN" "$TASK" "$CAPABILITY_SECRET" > "$_ENV"
chmod 644 "$_ENV"

echo "[entrypoint] Dropping privileges, switching to pwuser..." >&2

# Source the env file, then exec node — no reliance on su -m
exec su -s /bin/sh pwuser -c '. /tmp/.executor-env && exec node /app/packages/executor-web/dist/index.js'
