/**
 * SSRF protection utilities — shared between WebFetch (web.ts) and Browser
 * (browser.ts) tools.
 *
 * Blocks requests to private/internal IP addresses and cloud metadata
 * endpoints. Prevents the LLM from using network-capable tools as SSRF
 * vectors to access internal services, localhost admin panels, or cloud
 * instance metadata.
 *
 * Extracted from web.ts to avoid code duplication — the browser tool needs
 * the exact same host validation logic for pre-navigation and post-redirect
 * URL checks.
 *
 * ── Local Development Mode ──
 * For local webapp development, users can allowlist specific hosts/ports
 * in `~/.claude/settings.json`:
 *
 * ```json
 * {
 *   "allowedHosts": [
 *     "localhost:3000",
 *     "localhost:5173",
 *     "127.0.0.1:8080",
 *     "192.168.1.100:*"
 *   ]
 * }
 * ```
 *
 * Patterns support:
 *   - Exact: "localhost:3000" — only that host:port
 *   - Port wildcard: "localhost:*" — any port on localhost
 *   - No port: "localhost" — any port on localhost
 *   - Subdomain wildcard: "*.local:*" — any .local hostname, any port
 *
 * Cloud metadata endpoints (169.254.169.254, metadata.google.internal)
 * are ALWAYS blocked regardless of the allowlist — they are never
 * legitimate dev servers and represent a critical security risk.
 */

import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

/**
 * Regex matching IPv4-mapped IPv6 prefixes: both the compressed `::ffff:`
 * form and the expanded `0:0:0:0:0:ffff:` form (with 1–4 digit zero groups).
 */
const IPV4_MAPPED_RE = /^(?:::ffff:|(?:0{1,4}:){5}ffff:)/i;

// ── Allowlist infrastructure ────────────────────────────────────────────────

interface AllowlistEntry {
  /** Hostname pattern: exact ("localhost"), or wildcard ("*.local") */
  host: string;
  /** Port: exact number, "*" for any port, or null (= any port) */
  port: string | null;
}

let _allowlistCache: { entries: AllowlistEntry[]; ts: number } | null = null;
/** Cache TTL: 60 seconds. Avoids re-reading settings.json on every request. */
const ALLOWLIST_CACHE_TTL = 60_000;

/**
 * Load the allowed hosts from settings.json.
 * Cached for 60s to avoid disk I/O on every request.
 */
function loadAllowlist(): AllowlistEntry[] {
  if (_allowlistCache && Date.now() - _allowlistCache.ts < ALLOWLIST_CACHE_TTL) {
    return _allowlistCache.entries;
  }

  const entries: AllowlistEntry[] = [];
  try {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    if (!existsSync(settingsPath)) {
      _allowlistCache = { entries, ts: Date.now() };
      return entries;
    }
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!settings || typeof settings !== "object") {
      _allowlistCache = { entries, ts: Date.now() };
      return entries;
    }

    const raw = settings.allowedHosts;
    if (!Array.isArray(raw)) {
      _allowlistCache = { entries, ts: Date.now() };
      return entries;
    }

    for (const item of raw) {
      if (typeof item !== "string" || !item.trim()) continue;
      const trimmed = item.trim().toLowerCase();

      // Parse "host:port" or "host"
      // Handle IPv6 bracket notation: [::1]:3000
      let host: string;
      let port: string | null = null;

      if (trimmed.startsWith("[")) {
        // IPv6: [::1]:3000 or [::1]
        const closeBracket = trimmed.indexOf("]");
        if (closeBracket === -1) continue; // malformed
        host = trimmed.slice(1, closeBracket);
        const rest = trimmed.slice(closeBracket + 1);
        if (rest.startsWith(":")) {
          port = rest.slice(1) || null;
        }
      } else {
        const lastColon = trimmed.lastIndexOf(":");
        // Only treat as host:port if there's a single colon (not IPv6 like ::1)
        if (lastColon > 0 && trimmed.indexOf(":") === lastColon) {
          host = trimmed.slice(0, lastColon);
          port = trimmed.slice(lastColon + 1) || null;
        } else {
          host = trimmed;
        }
      }

      entries.push({ host, port });
    }
  } catch {
    // Failed to read settings — use empty allowlist
  }

  _allowlistCache = { entries, ts: Date.now() };
  return entries;
}

/**
 * Check whether a hostname:port combination is explicitly allowed
 * by the user's allowedHosts configuration.
 */
function isAllowlisted(hostname: string, port?: string): boolean {
  const entries = loadAllowlist();
  if (entries.length === 0) return false;

  const h = hostname.toLowerCase();

  for (const entry of entries) {
    // Check host match
    let hostMatch = false;
    if (entry.host === h) {
      hostMatch = true;
    } else if (entry.host.startsWith("*.")) {
      const base = entry.host.slice(2);
      hostMatch = h === base || h.endsWith("." + base);
    } else if (entry.host === "*") {
      hostMatch = true;
    }

    if (!hostMatch) continue;

    // Check port match
    if (entry.port === null || entry.port === "*") {
      return true; // any port
    }
    if (port && entry.port === port) {
      return true; // exact port match
    }
    // If no port specified in the URL (default 80/443), match entry with no port
    if (!port && entry.port === null) {
      return true;
    }
  }

  return false;
}

/**
 * Cloud metadata endpoints that are ALWAYS blocked, regardless of allowlist.
 * These represent critical security risks (AWS/GCP/Azure instance metadata)
 * and are never legitimate development servers.
 */
function isCloudMetadata(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (lower === "metadata.google.internal" || lower === "metadata.google.internal.") return true;

  // Check for 169.254.169.254 (AWS/Azure metadata) in all forms
  // We only need to check the canonical form here — the full IP parsing
  // in isPrivateOrReservedHost catches octal/hex/mapped-v6 variants too.
  if (lower === "169.254.169.254") return true;

  return false;
}

/**
 * Reset the allowlist cache. Called when settings change.
 */
export function resetAllowlistCache(): void {
  _allowlistCache = null;
}

/**
 * Parse a single IPv4 octet string, handling octal notation (leading zero).
 *
 * glibc's `inet_aton` and many OS resolvers interpret octets with a leading
 * zero as octal: `"0177"` → 127 (not 177). Node.js's `fetch` uses the OS
 * resolver, so dotted addresses like `0177.0.0.1` resolve to `127.0.0.1`.
 */
function parseOctet(octet: string): number {
  if (octet.length > 1 && octet.startsWith("0")) {
    return parseInt(octet, 8);
  }
  return Number(octet);
}

/**
 * Check whether a hostname resolves to a private/internal IP address.
 *
 * Blocks requests to localhost, link-local, private RFC 1918 ranges,
 * and cloud metadata endpoints (e.g., AWS 169.254.169.254). This prevents
 * the LLM from using network tools as an SSRF vector to access internal
 * services, cloud instance metadata, or localhost admin panels.
 *
 * If the hostname:port is in the user's `allowedHosts` configuration
 * (from `~/.claude/settings.json`), it is allowed through — except for
 * cloud metadata endpoints which are always blocked.
 *
 * @param hostname The hostname to check
 * @param port Optional port number (as string) for allowlist matching
 */
export function isPrivateOrReservedHost(hostname: string, port?: string): boolean {
  // Cloud metadata is ALWAYS blocked — no allowlist override
  if (isCloudMetadata(hostname)) return true;

  // Check allowlist BEFORE running the private IP checks.
  // If the user explicitly allowlisted this host:port, let it through.
  if (isAllowlisted(hostname, port)) return false;

  let decoded: string;
  try {
    decoded = decodeURIComponent(hostname);
  } catch {
    decoded = hostname;
  }
  const lower = decoded.toLowerCase();

  // Re-check allowlist with decoded hostname (for percent-encoded hostnames)
  if (lower !== hostname.toLowerCase() && isAllowlisted(lower, port)) return false;

  // Localhost variants
  if (lower === "localhost" || lower === "localhost.") return true;

  // IPv6 loopback and unspecified
  const bare = lower.replace(/^\[|\]$/g, "");
  const bareNoZone = bare.replace(/%25.*$/, "").replace(/%.*$/, "");
  if (bareNoZone === "::1" || bareNoZone === "0:0:0:0:0:0:0:1") return true;
  if (bareNoZone === "::" || bareNoZone === "0:0:0:0:0:0:0:0") return true;

  // IPv4 checks (with IPv4-mapped IPv6 prefix stripping)
  const ipv4 = IPV4_MAPPED_RE.test(bareNoZone) ? bareNoZone.replace(IPV4_MAPPED_RE, "") : bareNoZone;
  const parts = ipv4.split(".");
  if (parts.length === 4 && parts.every((p) => /^\d{1,4}$/.test(p))) {
    const octets = parts.map(parseOctet);
    if (octets.some((o) => o > 255 || o < 0 || !Number.isFinite(o))) return false;
    const [a, b] = octets;
    if (a === 127) return true;      // 127.0.0.0/8 — loopback
    if (a === 10) return true;        // 10.0.0.0/8 — private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;          // 192.168.0.0/16
    if (a === 169 && b === 254) return true;          // 169.254.0.0/16 — link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 — CGNAT
    if (a === 0) return true;                          // 0.0.0.0/8 — reserved
  }

  // IPv6 private/reserved ranges
  const ipv6Parts = bareNoZone.split(":");
  const firstHextet = ipv6Parts.find((p) => p.length > 0);
  if (firstHextet && /^[0-9a-f]{1,4}$/i.test(firstHextet)) {
    const hexVal = parseInt(firstHextet, 16);
    if ((hexVal & 0xffc0) === 0xfe80) return true; // fe80::/10 — link-local
    if ((hexVal & 0xfe00) === 0xfc00) return true; // fc00::/7 — ULA
  }

  // Decimal/hex/octal single-integer IP addresses
  if (ipv4.length <= 20 && /^(?:0x[0-9a-f]+|0[0-7]*|[1-9]\d*)$/i.test(ipv4) && !ipv4.includes(":")) {
    let numericIp: number;
    if (ipv4.startsWith("0x") || ipv4.startsWith("0X")) {
      numericIp = parseInt(ipv4, 16);
    } else if (ipv4.startsWith("0") && ipv4.length > 1) {
      numericIp = parseInt(ipv4, 8);
    } else {
      numericIp = parseInt(ipv4, 10);
    }
    if (Number.isFinite(numericIp) && numericIp >= 0 && numericIp <= 0xFFFFFFFF) {
      const a = (numericIp >>> 24) & 0xFF;
      const b = (numericIp >>> 16) & 0xFF;
      if (a === 127) return true;
      if (a === 10) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 169 && b === 254) return true;
      if (a === 100 && b >= 64 && b <= 127) return true;
      if (a === 0) return true;
    }
  }

  return false;
}
