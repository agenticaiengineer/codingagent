/**
 * Built-in Browser tool — programmatic browser control for the agentic loop.
 *
 * Provides a single `Browser` tool with action-dispatch semantics so the LLM
 * can navigate, click, type, screenshot, extract text, execute JavaScript, and
 * interact with web pages as part of its autonomous workflow.
 *
 * Architecture decisions:
 *   - **Single tool, multiple actions** — reduces decision overhead for the LLM
 *     (one tool to learn, not 12). Follows the pattern used by Claude Computer
 *     Use and the browser-use library.
 *   - **Playwright** — auto-wait semantics, locator API, and persistent contexts
 *     make it ideal for agentic use. Lazy-imported to avoid blocking startup for
 *     users who don't need browser control.
 *   - **Lazy browser launch** — the browser process is only spawned on first use
 *     and auto-closed after 5 minutes of inactivity.
 *   - **SSRF protection** — reuses the same `isPrivateOrReservedHost` checks
 *     from web.ts, blocking navigation to private/internal addresses.
 *   - **`isConcurrencySafe: false`** — browser state is globally mutable (one
 *     page, one active URL), so concurrent tool calls would race.
 *   - **Resource limits** — navigation timeout (30s), idle auto-close (5min),
 *     screenshot compression, text output truncation (50K chars).
 */

import type { Tool, ToolInput, ToolContext, ToolResult } from "../core/types.js";
import {
  requireString,
  optionalString,
  optionalInteger,
  optionalBool,
  ToolInputError,
  safeTruncate,
} from "./validate.js";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync, readdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ── SSRF protection — import the validator from web.ts ──────────────────────
// We need the same private/reserved host check used by WebFetch to prevent
// the LLM from using the browser to access internal services.
// Since isPrivateOrReservedHost is not exported from web.ts, we inline the
// same logic here. In a future refactor, the function should be extracted
// to a shared module.
import { isPrivateOrReservedHost } from "./browser-ssrf.js";

// ── Lazy Playwright import ──────────────────────────────────────────────────
// Playwright is ~4 MB of JS and requires browser binaries (~130 MB).
// Lazy-import ensures we don't slow down startup or crash with "module not
// found" for users who haven't installed it. The explicit error message
// guides users to install the dependency.

type PlaywrightModule = typeof import("playwright");

let _playwrightModule: PlaywrightModule | null = null;

async function getPlaywright(): Promise<PlaywrightModule> {
  if (_playwrightModule) return _playwrightModule;
  try {
    _playwrightModule = await import("playwright");
    return _playwrightModule;
  } catch {
    throw new Error(
      "Playwright is not installed. Install it with:\n" +
      "  npm install playwright\n" +
      "  npx playwright install chromium\n\n" +
      "Playwright is required for the Browser tool to control a headless browser."
    );
  }
}

// ── Browser Session Manager ─────────────────────────────────────────────────
// Manages a single browser instance with lazy launch and idle auto-close.
// Each session gets an isolated BrowserContext (cookies, localStorage, cache).

import type { Browser, BrowserContext, Page } from "playwright";

/** Maximum number of open tabs (pages) to prevent resource exhaustion. */
const MAX_TABS = 5;

/** Default navigation timeout in milliseconds. */
const DEFAULT_TIMEOUT = 30_000;

/** Idle timeout — auto-close browser after 5 minutes of inactivity. */
const IDLE_TIMEOUT_MS = 5 * 60 * 1000;

/** Maximum text output returned to the LLM (in characters). */
const MAX_TEXT_OUTPUT = 50_000;

// ── Auth / storage state persistence ────────────────────────────────────────
// Browser auth state (cookies, localStorage, sessionStorage) is saved to
// `~/.claude/browser-auth/` so that login sessions persist across browser
// restarts, idle auto-close, and agent session boundaries.
//
// Storage state files are named by "profile" — which defaults to "default"
// but the LLM can specify a name (e.g., "github", "jira") so multiple
// site-specific login sessions coexist without overwriting each other.
//
// This uses Playwright's `storageState()` API which serializes cookies
// and localStorage origins to a JSON file, and `newContext({ storageState })`
// to restore them. This is the most robust approach because:
//   1. It survives browser restart (unlike in-memory cookies)
//   2. It captures both cookies AND localStorage (many SPAs use localStorage
//      for JWT tokens)
//   3. It's a standard Playwright pattern with well-defined behavior
//   4. The user never needs to manually extract cookies from DevTools
//
// Security: storage state files contain session tokens and are stored in the
// user's home directory with no special encryption (same as browser profiles).
// The `~/.claude/` directory should already have restrictive permissions.

// ── Browser Profile Configuration ───────────────────────────────────────────
// Users configure named profiles in `~/.claude/settings.json` under the
// `browserProfiles` key. Each profile associates domain patterns with a
// profile name, enabling automatic auth-state loading when navigating to
// matching domains.
//
// Example settings.json:
// ```json
// {
//   "browserProfiles": {
//     "github": {
//       "domains": ["github.com", "*.github.com"],
//       "autoLoad": true
//     },
//     "jira": {
//       "domains": ["*.atlassian.net", "jira.mycompany.com"],
//       "autoLoad": true
//     },
//     "google": {
//       "domains": ["*.google.com", "accounts.google.com"],
//       "autoLoad": true
//     }
//   }
// }
// ```
//
// How it works:
// 1. User logs into github.com using Browser(navigate → type → click)
// 2. Agent calls Browser(action: "save_auth", profile: "github")
//    → saves cookies/localStorage to ~/.claude/browser-auth/github.json
//    → saves domain associations to ~/.claude/browser-auth/github.meta.json
// 3. Next session, agent calls Browser(action: "navigate", url: "https://github.com")
//    → domain "github.com" matches profile "github" (from settings OR saved metadata)
//    → auto-loads github.json storage state before navigating
//    → user is already logged in!

/**
 * Profile configuration from settings.json.
 */
interface BrowserProfileConfig {
  /** Domain patterns this profile applies to. Supports glob-style wildcards: *.github.com */
  domains: string[];
  /** Whether to auto-load this profile when navigating to a matching domain. Default: true */
  autoLoad?: boolean;
}

/**
 * Profile metadata saved alongside the storage state file.
 * This allows the system to learn domain associations even without
 * settings.json configuration — the domains are inferred from the
 * cookies saved in the storage state.
 */
interface ProfileMetadata {
  /** Profile name */
  name: string;
  /** Domains this profile was saved from (inferred from cookies) */
  domains: string[];
  /** When the profile was last saved */
  savedAt: string;
  /** Number of cookies in the profile */
  cookieCount: number;
}

function getAuthDir(): string {
  const dir = join(homedir(), ".claude", "browser-auth");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getAuthFilePath(profile: string): string {
  // Sanitize profile name to avoid path traversal
  const sanitized = profile.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  if (!sanitized) return join(getAuthDir(), "default.json");
  return join(getAuthDir(), `${sanitized}.json`);
}

function getMetaFilePath(profile: string): string {
  const sanitized = profile.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  if (!sanitized) return join(getAuthDir(), "default.meta.json");
  return join(getAuthDir(), `${sanitized}.meta.json`);
}

/**
 * List all saved auth profiles.
 */
function listAuthProfiles(): string[] {
  const dir = getAuthDir();
  try {
    return readdirSync(dir)
      .filter((f: string) => f.endsWith(".json") && !f.endsWith(".meta.json"))
      .map((f: string) => f.replace(/\.json$/, ""));
  } catch {
    return [];
  }
}

/**
 * Load browser profile configs from settings.json.
 * Returns empty object if not configured.
 */
function loadProfileConfigs(): Record<string, BrowserProfileConfig> {
  try {
    const settingsPath = join(homedir(), ".claude", "settings.json");
    if (!existsSync(settingsPath)) return {};
    const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
    if (!settings || typeof settings !== "object" || !settings.browserProfiles) return {};
    if (typeof settings.browserProfiles !== "object" || Array.isArray(settings.browserProfiles)) return {};
    // Validate each profile
    const result: Record<string, BrowserProfileConfig> = {};
    for (const [name, config] of Object.entries(settings.browserProfiles)) {
      if (config && typeof config === "object" && !Array.isArray(config)) {
        const cfg = config as Record<string, unknown>;
        if (Array.isArray(cfg.domains) && cfg.domains.every((d: unknown) => typeof d === "string")) {
          result[name] = {
            domains: cfg.domains as string[],
            autoLoad: cfg.autoLoad !== false, // default true
          };
        }
      }
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Load profile metadata (saved alongside the storage state).
 */
function loadProfileMetadata(profile: string): ProfileMetadata | null {
  const metaPath = getMetaFilePath(profile);
  try {
    if (!existsSync(metaPath)) return null;
    return JSON.parse(readFileSync(metaPath, "utf-8")) as ProfileMetadata;
  } catch {
    return null;
  }
}

/**
 * Save profile metadata alongside the storage state.
 */
function saveProfileMetadata(profile: string, meta: ProfileMetadata): void {
  const metaPath = getMetaFilePath(profile);
  writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf-8");
}

/**
 * Match a hostname against a domain pattern.
 * Supports:
 *   - Exact match: "github.com" matches "github.com"
 *   - Wildcard subdomain: "*.github.com" matches "api.github.com", "gist.github.com"
 *   - Bare domain also matches subdomains: "github.com" matches "api.github.com"
 */
function domainMatches(hostname: string, pattern: string): boolean {
  const h = hostname.toLowerCase();
  const p = pattern.toLowerCase();
  if (h === p) return true;
  if (p.startsWith("*.")) {
    const base = p.slice(2); // "*.github.com" → "github.com"
    return h === base || h.endsWith("." + base);
  }
  // Bare domain also matches subdomains (convenience)
  return h.endsWith("." + p);
}

/**
 * Find the best matching auth profile for a given hostname.
 * Checks settings.json profiles first (explicit config), then falls back
 * to saved profile metadata (learned from previous save_auth calls).
 *
 * Returns the profile name if a match is found and autoLoad is enabled,
 * null otherwise.
 *
 * Cached for 30 seconds to avoid re-reading settings.json on every navigate.
 */
let _profileMatchCache: { hostname: string; profile: string | null; ts: number } | null = null;

function findProfileForDomain(hostname: string): string | null {
  // Return cached result if fresh (< 30s)
  if (_profileMatchCache && _profileMatchCache.hostname === hostname && Date.now() - _profileMatchCache.ts < 30_000) {
    return _profileMatchCache.profile;
  }

  let result: string | null = null;

  // 1. Check settings.json profiles (explicit, take priority)
  const configs = loadProfileConfigs();
  for (const [profileName, config] of Object.entries(configs)) {
    if (config.autoLoad === false) continue;
    for (const pattern of config.domains) {
      if (domainMatches(hostname, pattern)) {
        // Verify the auth file actually exists
        if (existsSync(getAuthFilePath(profileName))) {
          result = profileName;
          break;
        }
      }
    }
    if (result) break;
  }

  // 2. Fall back to saved profile metadata (learned domains)
  if (!result) {
    const profiles = listAuthProfiles();
    for (const profileName of profiles) {
      if (profileName === "default") continue; // skip default — it's a catch-all
      const meta = loadProfileMetadata(profileName);
      if (meta && meta.domains.length > 0) {
        for (const domain of meta.domains) {
          if (domainMatches(hostname, domain)) {
            result = profileName;
            break;
          }
        }
      }
      if (result) break;
    }
  }

  // Cache the result
  _profileMatchCache = { hostname, profile: result, ts: Date.now() };
  return result;
}

/** Track which profiles have already been auto-loaded this session to avoid loops. */
const autoLoadedProfiles = new Set<string>();

class BrowserSessionManager {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private pages: Map<string, Page> = new Map(); // tabId → Page
  private activeTabId: string = "main";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private nextTabId = 1;
  private _headed: boolean = false;

  /**
   * Get or create the active page. Lazily launches the browser on first call.
   */
  async getPage(): Promise<Page> {
    this.resetIdleTimer();
    await this.ensureBrowser();

    const page = this.pages.get(this.activeTabId);
    if (page && !page.isClosed()) return page;

    // Create initial page
    const newPage = await this.context!.newPage();
    this.pages.set(this.activeTabId, newPage);
    return newPage;
  }

  /**
   * Open a new tab and make it active. Returns the new tab ID.
   */
  async newTab(): Promise<{ tabId: string; page: Page }> {
    this.resetIdleTimer();
    await this.ensureBrowser();

    if (this.pages.size >= MAX_TABS) {
      throw new Error(
        `Maximum number of tabs (${MAX_TABS}) reached. Close a tab first with action "close_tab".`
      );
    }

    const tabId = `tab_${this.nextTabId++}`;
    const page = await this.context!.newPage();
    this.pages.set(tabId, page);
    this.activeTabId = tabId;
    return { tabId, page };
  }

  /**
   * Switch to a specific tab by ID.
   */
  switchTab(tabId: string): Page {
    const page = this.pages.get(tabId);
    if (!page || page.isClosed()) {
      const available = [...this.pages.keys()].filter(
        (id) => !this.pages.get(id)!.isClosed()
      );
      throw new Error(
        `Tab "${tabId}" not found or closed. Available tabs: ${available.join(", ") || "(none)"}`
      );
    }
    this.activeTabId = tabId;
    return page;
  }

  /**
   * Close a specific tab. If it's the active tab, switch to another.
   */
  async closeTab(tabId: string): Promise<string> {
    const page = this.pages.get(tabId);
    if (page && !page.isClosed()) {
      await page.close();
    }
    this.pages.delete(tabId);

    if (this.activeTabId === tabId) {
      // Switch to another open tab, or create "main" placeholder
      const remaining = [...this.pages.keys()].filter(
        (id) => !this.pages.get(id)!.isClosed()
      );
      this.activeTabId = remaining.length > 0 ? remaining[0] : "main";
    }

    return this.activeTabId;
  }

  /**
   * List all open tabs with their URLs and titles.
   */
  listTabs(): Array<{ tabId: string; url: string; title: string; active: boolean }> {
    const tabs: Array<{ tabId: string; url: string; title: string; active: boolean }> = [];
    for (const [tabId, page] of this.pages) {
      if (!page.isClosed()) {
        tabs.push({
          tabId,
          url: page.url(),
          title: "", // title is async but we need sync here; populate in execute
          active: tabId === this.activeTabId,
        });
      }
    }
    return tabs;
  }

  /**
   * Close the entire browser session and release all resources.
   */
  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    for (const [, page] of this.pages) {
      if (!page.isClosed()) {
        try { await page.close(); } catch { /* best-effort */ }
      }
    }
    this.pages.clear();
    if (this.context) {
      try { await this.context.close(); } catch { /* best-effort */ }
      this.context = null;
    }
    if (this.browser) {
      try { await this.browser.close(); } catch { /* best-effort */ }
      this.browser = null;
    }
    this.activeTabId = "main";
  }

  /** Whether the browser is currently running. */
  get isRunning(): boolean {
    return this.browser !== null;
  }

  /** The active tab ID. */
  get currentTabId(): string {
    return this.activeTabId;
  }

  /** Whether the browser is in headed (visible window) mode. */
  get isHeaded(): boolean {
    return this._headed;
  }

  /**
   * Restart the browser in headed mode (visible window) for human interaction.
   * Auto-saves current auth state if a browser is already running, then
   * relaunches with `headless: false`.
   */
  async switchToHeaded(): Promise<void> {
    if (this._headed && this.browser) return; // already headed
    // Save state before restart
    if (this.context) {
      try {
        await this.context.storageState({ path: getAuthFilePath("default") });
      } catch { /* best-effort */ }
    }
    await this.close();
    this._headed = true;
    await this.ensureBrowser();
  }

  /**
   * Restart the browser in headless mode (background, no window).
   * Auto-saves current auth state before switching.
   */
  async switchToHeadless(): Promise<void> {
    if (!this._headed && this.browser) return; // already headless
    if (this.context) {
      try {
        await this.context.storageState({ path: getAuthFilePath("default") });
      } catch { /* best-effort */ }
    }
    await this.close();
    this._headed = false;
    await this.ensureBrowser();
  }

  // ── Private helpers ──

  private async ensureBrowser(): Promise<void> {
    if (this.browser && this.context) return;

    const pw = await getPlaywright();
    this.browser = await pw.chromium.launch({
      headless: !this._headed,
      args: [
        "--no-sandbox",
        "--disable-dev-shm-usage",
        ...(this._headed ? [] : ["--disable-gpu"]),
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-default-apps",
        "--disable-sync",
        "--disable-translate",
        "--metrics-recording-only",
        "--mute-audio",
        "--no-first-run",
      ],
    });

    // Try to restore the default auth profile so returning users start
    // with their saved cookies/localStorage from previous sessions.
    const defaultAuthPath = getAuthFilePath("default");
    let storageState: string | undefined;
    if (existsSync(defaultAuthPath)) {
      try {
        // Validate the storage state file is valid JSON before passing
        // it to Playwright — a corrupted file would throw a confusing
        // Playwright internal error instead of a clear message.
        JSON.parse(readFileSync(defaultAuthPath, "utf-8"));
        storageState = defaultAuthPath;
      } catch {
        // Corrupted storage state file — start fresh
      }
    }

    this.context = await this.browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      ignoreHTTPSErrors: false,
      javaScriptEnabled: true,
      locale: "en-US",
      timezoneId: "America/New_York",
      ...(storageState ? { storageState } : {}),
    });

    // Block downloads to prevent file-system writes from browsed pages.
    // Playwright doesn't have a direct "disable downloads" flag, but we
    // can intercept the download event and cancel it.
    this.context.on("page", (page) => {
      page.on("download", async (download) => {
        try { await download.cancel(); } catch { /* ignore */ }
      });
    });
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      // Auto-save auth state before idle close so sessions aren't lost
      void (async () => {
        if (this.context) {
          try {
            await this.context.storageState({ path: getAuthFilePath("default") });
          } catch { /* best-effort */ }
        }
        void this.close();
      })();
    }, IDLE_TIMEOUT_MS);
    // Prevent the idle timer from keeping the Node.js process alive
    if (typeof this.idleTimer === "object" && typeof this.idleTimer.unref === "function") {
      this.idleTimer.unref();
    }
  }
}

// ── Global session instance ─────────────────────────────────────────────────
// Singleton per process. Sub-agents intentionally do NOT inherit browser
// sessions — browser state is mutable and non-clonable.
const browserSession = new BrowserSessionManager();

// Cleanup on process exit
const cleanupBrowser = () => {
  void browserSession.close();
};

process.on("exit", cleanupBrowser);
process.on("SIGINT", cleanupBrowser);
process.on("SIGTERM", cleanupBrowser);

// ── Action types ────────────────────────────────────────────────────────────

type BrowserAction =
  | "navigate"
  | "click"
  | "type"
  | "select"
  | "screenshot"
  | "get_text"
  | "get_html"
  | "get_elements"
  | "execute_js"
  | "wait"
  | "scroll"
  | "hover"
  | "back"
  | "forward"
  | "reload"
  | "new_tab"
  | "switch_tab"
  | "close_tab"
  | "list_tabs"
  | "save_auth"
  | "load_auth"
  | "list_auth"
  | "delete_auth"
  | "set_cookies"
  | "get_cookies"
  | "show_browser"
  | "hide_browser"
  | "wait_for_user"
  | "close";

const VALID_ACTIONS: readonly BrowserAction[] = [
  "navigate", "click", "type", "select", "screenshot",
  "get_text", "get_html", "get_elements", "execute_js",
  "wait", "scroll", "hover", "back", "forward", "reload",
  "new_tab", "switch_tab", "close_tab", "list_tabs",
  "save_auth", "load_auth", "list_auth", "delete_auth",
  "set_cookies", "get_cookies",
  "show_browser", "hide_browser", "wait_for_user",
  "close",
];

// ── URL validation ──────────────────────────────────────────────────────────

function validateUrl(url: string): { valid: true; parsed: URL } | { valid: false; error: string } {
  if (url.length > 8192) {
    return {
      valid: false,
      error: `URL is too long (${url.length.toLocaleString()} characters, max 8192).`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, error: `Invalid URL: ${url}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      valid: false,
      error: `Only http:// and https:// URLs are allowed. Got: ${parsed.protocol}`,
    };
  }
  if (isPrivateOrReservedHost(parsed.hostname, parsed.port || undefined)) {
    return {
      valid: false,
      error: `Requests to private/internal network addresses are blocked (${parsed.hostname}). Browser can only access public internet URLs. To allow local development servers, add the host:port to "allowedHosts" in ~/.claude/settings.json.`,
    };
  }
  return { valid: true, parsed };
}

// ── Page state summary ──────────────────────────────────────────────────────

async function getPageSummary(page: Page): Promise<string> {
  const title = await page.title();
  const url = page.url();
  return `Page: ${title || "(untitled)"}\nURL: ${url}`;
}

// ── Interactive element extraction ──────────────────────────────────────────
// Extracts clickable/typeable elements into a compact text representation
// with IDs, following the browser-use pattern. This gives the LLM a
// structured view of what it can interact with.

async function extractInteractiveElements(page: Page, maxElements: number = 50): Promise<string> {
  const elements = await page.evaluate((max: number) => {
    const results: Array<{
      index: number;
      tag: string;
      role: string;
      text: string;
      type: string;
      name: string;
      href: string;
      placeholder: string;
      ariaLabel: string;
      id: string;
      selector: string;
    }> = [];

    // Collect interactive elements
    const interactiveSelectors = [
      "a[href]",
      "button",
      "input",
      "textarea",
      "select",
      "[role='button']",
      "[role='link']",
      "[role='tab']",
      "[role='menuitem']",
      "[role='checkbox']",
      "[role='radio']",
      "[role='switch']",
      "[onclick]",
      "[tabindex]",
    ];

    const seen = new Set<Element>();
    let index = 0;

    for (const sel of interactiveSelectors) {
      if (index >= max) break;
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        if (index >= max) break;
        if (seen.has(el)) continue;
        seen.add(el);

        // Skip hidden elements
        const style = window.getComputedStyle(el);
        if (
          style.display === "none" ||
          style.visibility === "hidden" ||
          style.opacity === "0"
        ) continue;

        const htmlEl = el as HTMLElement;
        const rect = htmlEl.getBoundingClientRect();
        // Skip zero-size elements
        if (rect.width === 0 && rect.height === 0) continue;

        // Build a unique CSS selector for this element
        let uniqueSelector = "";
        if (htmlEl.id) {
          uniqueSelector = `#${CSS.escape(htmlEl.id)}`;
        } else {
          // Build path from element to nearest ancestor with an ID
          const parts: string[] = [];
          let current: Element | null = htmlEl;
          while (current && current !== document.body) {
            if (current.id) {
              parts.unshift(`#${CSS.escape(current.id)}`);
              break;
            }
            const tag = current.tagName.toLowerCase();
            const parent: Element | null = current.parentElement;
            if (parent) {
              const siblings = parent.querySelectorAll(`:scope > ${tag}`);
              if (siblings.length > 1) {
                const idx = Array.from(siblings).indexOf(current) + 1;
                parts.unshift(`${tag}:nth-of-type(${idx})`);
              } else {
                parts.unshift(tag);
              }
            } else {
              parts.unshift(tag);
            }
            current = parent;
          }
          uniqueSelector = parts.join(" > ");
        }

        results.push({
          index: index++,
          tag: htmlEl.tagName.toLowerCase(),
          role: htmlEl.getAttribute("role") || "",
          text: (htmlEl.textContent || "").trim().slice(0, 80),
          type: (htmlEl as HTMLInputElement).type || "",
          name: htmlEl.getAttribute("name") || "",
          href: (htmlEl as HTMLAnchorElement).href || "",
          placeholder: (htmlEl as HTMLInputElement).placeholder || "",
          ariaLabel: htmlEl.getAttribute("aria-label") || "",
          id: htmlEl.id || "",
          selector: uniqueSelector,
        });
      }
    }
    return results;
  }, maxElements);

  if (elements.length === 0) {
    return "No interactive elements found on the page.";
  }

  const lines = elements.map((el) => {
    const parts = [`[${el.index}]`, `<${el.tag}>`];
    if (el.role) parts.push(`role="${el.role}"`);
    if (el.type) parts.push(`type="${el.type}"`);
    if (el.text) parts.push(`"${el.text}"`);
    if (el.href) parts.push(`href="${el.href}"`);
    if (el.placeholder) parts.push(`placeholder="${el.placeholder}"`);
    if (el.ariaLabel) parts.push(`aria-label="${el.ariaLabel}"`);
    if (el.name) parts.push(`name="${el.name}"`);
    parts.push(`selector="${el.selector}"`);
    return parts.join(" ");
  });

  return `Interactive elements (${elements.length}):\n${lines.join("\n")}`;
}

// ── HTML to text conversion ─────────────────────────────────────────────────
// Lightweight text extraction from page content. Reuses regex patterns
// similar to web.ts stripHtml but operates via Playwright's innerText which
// is more accurate (respects CSS visibility, executes in browser context).

async function extractPageText(page: Page, selector?: string): Promise<string> {
  try {
    let text: string;
    if (selector) {
      const el = page.locator(selector).first();
      text = await el.innerText({ timeout: 5000 });
    } else {
      text = await page.innerText("body", { timeout: 10000 });
    }
    // Collapse excessive whitespace
    text = text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to extract text: ${msg}`);
  }
}

// ── Tool definition ─────────────────────────────────────────────────────────

export const browserTool: Tool = {
  name: "Browser",
  description:
    `Control a headless browser for interacting with web pages. Supports navigation, clicking, typing, screenshots, text extraction, JavaScript execution, multi-tab management, and persistent auth sessions.

Actions:
- navigate: Go to a URL. Returns page title, URL, and interactive elements.
- click: Click an element by CSS selector or text. Auto-waits for it to be visible.
- type: Type text into an input field (clears first). Use selector to target field.
- select: Select an option in a <select> dropdown by value or label.
- screenshot: Take a screenshot of the page (returned as base64 image).
- get_text: Extract the text content of the page or a specific element.
- get_html: Get the raw HTML of the page or a specific element.
- get_elements: List all interactive elements (links, buttons, inputs) with selectors.
- execute_js: Execute JavaScript in the page context and return the result.
- wait: Wait for an element to appear or a specific condition.
- scroll: Scroll the page (up, down, to element).
- hover: Hover over an element.
- back: Go back in browser history.
- forward: Go forward in browser history.
- reload: Reload the current page.
- new_tab: Open a new tab.
- switch_tab: Switch to a specific tab by ID.
- close_tab: Close a specific tab.
- list_tabs: List all open tabs.
- save_auth: Save current browser auth state (cookies + localStorage) to a named profile. Use after completing a login flow so the session persists across browser restarts.
- load_auth: Load a previously saved auth profile. Restarts browser with saved cookies/localStorage. Use before navigating to a site that requires login.
- list_auth: List all saved auth profiles.
- delete_auth: Delete a saved auth profile.
- set_cookies: Inject cookies directly into the browser context (e.g., from a known session token).
- get_cookies: Get all cookies for the current page or a specific URL/domain.
- show_browser: Switch to headed mode — opens a visible browser window. Use when a human needs to see the page (CAPTCHA, 2FA, OAuth consent, visual verification).
- hide_browser: Switch back to headless mode after human interaction is complete.
- wait_for_user: Pause and wait for the human to complete an action in the visible browser (e.g., solve a CAPTCHA, approve 2FA, click OAuth consent). Polls for a URL change, element appearance, or a timeout. Always call show_browser first.
- close: Close the browser entirely.

Login workflow:
1. Navigate to the login page
2. Use type/click to fill in credentials and submit
3. If CAPTCHA/2FA appears: show_browser, then wait_for_user to let the human handle it
4. Use save_auth with a profile name (e.g., "github") to persist the session
5. Next time, use load_auth with the same profile to skip login`,

  inputSchema: {
    type: "object" as const,
    properties: {
      action: {
        type: "string",
        enum: VALID_ACTIONS as unknown as string[],
        description: "The browser action to perform.",
      },
      url: {
        type: "string",
        description: "URL to navigate to (for 'navigate' action).",
      },
      selector: {
        type: "string",
        description:
          "CSS selector to target an element (for click, type, select, get_text, get_html, wait, scroll, hover). Can also be a text description like 'text=Submit' or 'role=button[name=\"Login\"]'.",
      },
      text: {
        type: "string",
        description: "Text to type (for 'type' action) or value to select (for 'select' action).",
      },
      javascript: {
        type: "string",
        description: "JavaScript code to execute in the page context (for 'execute_js' action). Must return a serializable value.",
      },
      direction: {
        type: "string",
        enum: ["up", "down", "left", "right"],
        description: "Scroll direction (for 'scroll' action). Default: 'down'.",
      },
      amount: {
        type: "number",
        description: "Scroll amount in pixels (for 'scroll' action). Default: 500.",
      },
      tab_id: {
        type: "string",
        description: "Tab identifier (for 'switch_tab' and 'close_tab' actions).",
      },
      timeout: {
        type: "number",
        description:
          "Maximum wait time in milliseconds (default 30000 for navigate, 10000 for other actions).",
      },
      full_page: {
        type: "boolean",
        description: "Take a full-page screenshot instead of just the viewport (default false).",
      },
      profile: {
        type: "string",
        description: "Auth profile name for save_auth/load_auth/delete_auth (default: 'default'). Use descriptive names like 'github', 'jira', 'company-sso' to manage multiple login sessions.",
      },
      cookies: {
        type: "array",
        description: "Array of cookie objects for 'set_cookies' action. Each object: {name, value, domain, path?, expires?, httpOnly?, secure?, sameSite?}.",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            value: { type: "string" },
            domain: { type: "string" },
            path: { type: "string" },
            expires: { type: "number", description: "Unix timestamp in seconds" },
            httpOnly: { type: "boolean" },
            secure: { type: "boolean" },
            sameSite: { type: "string", enum: ["Strict", "Lax", "None"] },
          },
          required: ["name", "value", "domain"],
        },
      },
      wait_until: {
        type: "string",
        enum: ["url_change", "element", "network_idle"],
        description: "Condition to wait for in 'wait_for_user' action. 'url_change' (default) — wait until the page URL changes (e.g., after login redirect). 'element' — wait for a specific element to appear (use with selector). 'network_idle' — wait for network activity to settle.",
      },
      message: {
        type: "string",
        description: "Message to show the user explaining what they need to do in the browser (for 'wait_for_user' action). E.g., 'Please solve the CAPTCHA and click Submit'.",
      },
    },
    required: ["action"],
  },

  // Browser state is globally mutable — barrier semantics required.
  isConcurrencySafe: false,

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    let action: string;
    try {
      action = requireString(input, "action");
    } catch (err: unknown) {
      if (err instanceof ToolInputError) {
        return { content: err.message, is_error: true };
      }
      throw err;
    }

    // Validate action
    if (!VALID_ACTIONS.includes(action as BrowserAction)) {
      return {
        content: `Unknown action "${action}". Valid actions: ${VALID_ACTIONS.join(", ")}`,
        is_error: true,
      };
    }

    // Check for abort before starting browser operations
    if (context.abortController.signal.aborted) {
      return { content: "Aborted by user.", is_error: true };
    }

    try {
      switch (action as BrowserAction) {
        case "navigate":
          return await actionNavigate(input, context);
        case "click":
          return await actionClick(input, context);
        case "type":
          return await actionType(input, context);
        case "select":
          return await actionSelect(input, context);
        case "screenshot":
          return await actionScreenshot(input);
        case "get_text":
          return await actionGetText(input);
        case "get_html":
          return await actionGetHtml(input);
        case "get_elements":
          return await actionGetElements();
        case "execute_js":
          return await actionExecuteJs(input);
        case "wait":
          return await actionWait(input);
        case "scroll":
          return await actionScroll(input);
        case "hover":
          return await actionHover(input);
        case "back":
          return await actionBack();
        case "forward":
          return await actionForward();
        case "reload":
          return await actionReload();
        case "new_tab":
          return await actionNewTab();
        case "switch_tab":
          return await actionSwitchTab(input);
        case "close_tab":
          return await actionCloseTab(input);
        case "list_tabs":
          return await actionListTabs();
        case "save_auth":
          return await actionSaveAuth(input);
        case "load_auth":
          return await actionLoadAuth(input);
        case "list_auth":
          return await actionListAuth();
        case "delete_auth":
          return await actionDeleteAuth(input);
        case "set_cookies":
          return await actionSetCookies(input);
        case "get_cookies":
          return await actionGetCookies(input);
        case "show_browser":
          return await actionShowBrowser();
        case "hide_browser":
          return await actionHideBrowser();
        case "wait_for_user":
          return await actionWaitForUser(input, context);
        case "close":
          return await actionClose();
        default:
          return { content: `Action "${action}" is not implemented.`, is_error: true };
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.includes("Playwright is not installed")) {
        return { content: err.message, is_error: true };
      }
      const msg = err instanceof Error ? err.message : String(err);
      return { content: `Browser error: ${msg}`, is_error: true };
    }
  },
};

// ── Action implementations ──────────────────────────────────────────────────

async function actionNavigate(input: ToolInput, context: ToolContext): Promise<ToolResult> {
  let url: string;
  try {
    url = requireString(input, "url");
  } catch (err) {
    if (err instanceof ToolInputError) return { content: err.message, is_error: true };
    throw err;
  }

  const validation = validateUrl(url);
  if (!validation.valid) {
    return { content: `Error: ${validation.error}`, is_error: true };
  }

  // ── Domain-based auto-load ──
  // Before navigating, check if there's a saved auth profile for this domain.
  // If so, inject the cookies/localStorage so the user is already logged in.
  let autoLoadedProfile: string | null = null;
  const targetHostname = validation.parsed.hostname;
  const matchedProfile = findProfileForDomain(targetHostname);
  if (matchedProfile && !autoLoadedProfiles.has(matchedProfile)) {
    const authPath = getAuthFilePath(matchedProfile);
    if (existsSync(authPath)) {
      try {
        const stateJson = readFileSync(authPath, "utf-8");
        JSON.parse(stateJson); // validate
        // We need to add cookies from the saved profile to the current context
        // rather than restarting the browser (which would lose current state).
        const state = JSON.parse(stateJson);
        if (Array.isArray(state.cookies) && state.cookies.length > 0) {
          const page = await browserSession.getPage();
          const ctx = page.context();
          await ctx.addCookies(state.cookies);
          autoLoadedProfile = matchedProfile;
          autoLoadedProfiles.add(matchedProfile);
        }
      } catch {
        // Failed to load profile — proceed without it
      }
    }
  }

  const timeout = optionalInteger(input, "timeout") ?? DEFAULT_TIMEOUT;
  const page = await browserSession.getPage();
  const response = await page.goto(url, {
    waitUntil: "domcontentloaded",
    timeout,
  });

  // Post-redirect SSRF check: verify the final URL after redirects
  const finalUrl = page.url();
  try {
    const finalParsed = new URL(finalUrl);
    if (isPrivateOrReservedHost(finalParsed.hostname, finalParsed.port || undefined)) {
      await page.goBack();
      return {
        content: `Error: Navigation was redirected to a private/internal address (${finalParsed.hostname}). Browser can only access public internet URLs.`,
        is_error: true,
      };
    }
  } catch {
    // If final URL can't be parsed, proceed — the pre-navigation check passed
  }

  const status = response?.status() ?? 0;
  const summary = await getPageSummary(page);
  const elements = await extractInteractiveElements(page, 30);

  // Extract a brief text excerpt (first 2000 chars)
  let excerpt = "";
  try {
    const fullText = await extractPageText(page);
    excerpt = safeTruncate(fullText, 2000);
    if (fullText.length > 2000) {
      excerpt += "\n... (use get_text for full content)";
    }
  } catch {
    excerpt = "(could not extract text)";
  }

  return {
    content: [
      `Navigated successfully (HTTP ${status})`,
      ...(autoLoadedProfile ? [`🔑 Auto-loaded auth profile "${autoLoadedProfile}" for ${targetHostname}`] : []),
      summary,
      "",
      "── Page excerpt ──",
      excerpt,
      "",
      "── Interactive elements ──",
      elements,
    ].join("\n"),
  };
}

async function actionClick(input: ToolInput, context: ToolContext): Promise<ToolResult> {
  let selector: string;
  try {
    selector = requireString(input, "selector");
  } catch (err) {
    if (err instanceof ToolInputError) return { content: err.message, is_error: true };
    throw err;
  }

  const timeout = optionalInteger(input, "timeout") ?? 10_000;
  const page = await browserSession.getPage();

  // Support Playwright locator patterns: text=, role=, etc.
  const locator = resolveLocator(page, selector);
  await locator.click({ timeout });

  // Wait a moment for any navigation/AJAX
  await page.waitForLoadState("domcontentloaded", { timeout: 5000 }).catch(() => { /* ignore */ });

  const summary = await getPageSummary(page);
  return { content: `Clicked "${selector}".\n${summary}` };
}

async function actionType(input: ToolInput, context: ToolContext): Promise<ToolResult> {
  let selector: string;
  let text: string;
  try {
    selector = requireString(input, "selector");
    text = requireString(input, "text");
  } catch (err) {
    if (err instanceof ToolInputError) return { content: err.message, is_error: true };
    throw err;
  }

  const timeout = optionalInteger(input, "timeout") ?? 10_000;
  const page = await browserSession.getPage();
  const locator = resolveLocator(page, selector);
  await locator.fill(text, { timeout });

  return { content: `Typed "${safeTruncate(text, 50)}" into "${selector}".` };
}

async function actionSelect(input: ToolInput, context: ToolContext): Promise<ToolResult> {
  let selector: string;
  let value: string;
  try {
    selector = requireString(input, "selector");
    value = requireString(input, "text");
  } catch (err) {
    if (err instanceof ToolInputError) return { content: err.message, is_error: true };
    throw err;
  }

  const timeout = optionalInteger(input, "timeout") ?? 10_000;
  const page = await browserSession.getPage();
  const locator = resolveLocator(page, selector);

  // Try selecting by value first, then by label
  try {
    await locator.selectOption({ value }, { timeout });
  } catch {
    await locator.selectOption({ label: value }, { timeout });
  }

  return { content: `Selected "${value}" in "${selector}".` };
}

async function actionScreenshot(input: ToolInput): Promise<ToolResult> {
  const fullPage = optionalBool(input, "full_page") ?? false;
  const selector = optionalString(input, "selector");
  const page = await browserSession.getPage();

  let buffer: Buffer;
  if (selector) {
    const locator = resolveLocator(page, selector);
    buffer = await locator.screenshot({ type: "png" }) as Buffer;
  } else {
    buffer = await page.screenshot({
      type: "png",
      fullPage,
    }) as Buffer;
  }

  const base64 = buffer.toString("base64");
  const summary = await getPageSummary(page);

  // Return as text with the base64 data — the rendering layer can
  // convert this to an ImageBlock if the model supports vision.
  return {
    content: `Screenshot captured (${buffer.length.toLocaleString()} bytes, ${fullPage ? "full page" : "viewport"}).\n${summary}\n\n[screenshot:data:image/png;base64,${base64}]`,
  };
}

async function actionGetText(input: ToolInput): Promise<ToolResult> {
  const selector = optionalString(input, "selector");
  const page = await browserSession.getPage();

  let text = await extractPageText(page, selector);
  const summary = await getPageSummary(page);

  if (text.length > MAX_TEXT_OUTPUT) {
    const originalLen = text.length;
    text = safeTruncate(text, MAX_TEXT_OUTPUT) +
      `\n... (content truncated — showing ${MAX_TEXT_OUTPUT.toLocaleString()} of ${originalLen.toLocaleString()} chars)`;
  }

  return { content: `${summary}\n\n${text}` };
}

async function actionGetHtml(input: ToolInput): Promise<ToolResult> {
  const selector = optionalString(input, "selector");
  const page = await browserSession.getPage();

  let html: string;
  if (selector) {
    const locator = resolveLocator(page, selector);
    html = await locator.innerHTML({ timeout: 5000 });
  } else {
    html = await page.content();
  }

  const summary = await getPageSummary(page);

  if (html.length > MAX_TEXT_OUTPUT) {
    const originalLen = html.length;
    html = safeTruncate(html, MAX_TEXT_OUTPUT) +
      `\n... (HTML truncated — showing ${MAX_TEXT_OUTPUT.toLocaleString()} of ${originalLen.toLocaleString()} chars)`;
  }

  return { content: `${summary}\n\n${html}` };
}

async function actionGetElements(): Promise<ToolResult> {
  const page = await browserSession.getPage();
  const summary = await getPageSummary(page);
  const elements = await extractInteractiveElements(page, 80);
  return { content: `${summary}\n\n${elements}` };
}

async function actionExecuteJs(input: ToolInput): Promise<ToolResult> {
  let javascript: string;
  try {
    javascript = requireString(input, "javascript");
  } catch (err) {
    if (err instanceof ToolInputError) return { content: err.message, is_error: true };
    throw err;
  }

  const page = await browserSession.getPage();

  // Execute in the page context (sandboxed browser environment, NOT Node.js)
  const result = await page.evaluate((code: string) => {
    // eslint-disable-next-line no-eval
    const val = eval(code);
    // Serialize the result for transport back to Node.js
    if (val === undefined) return "undefined";
    if (val === null) return "null";
    try {
      return JSON.stringify(val, null, 2);
    } catch {
      return String(val);
    }
  }, javascript);

  let output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  if (output.length > MAX_TEXT_OUTPUT) {
    output = safeTruncate(output, MAX_TEXT_OUTPUT) + "\n... (output truncated)";
  }

  return { content: `JavaScript result:\n${output}` };
}

async function actionWait(input: ToolInput): Promise<ToolResult> {
  const selector = optionalString(input, "selector");
  const timeout = optionalInteger(input, "timeout") ?? 10_000;
  const page = await browserSession.getPage();

  if (selector) {
    const locator = resolveLocator(page, selector);
    await locator.waitFor({ state: "visible", timeout });
    return { content: `Element "${selector}" is now visible.` };
  } else {
    // Wait for network idle
    await page.waitForLoadState("networkidle", { timeout });
    return { content: "Page has reached network idle state." };
  }
}

async function actionScroll(input: ToolInput): Promise<ToolResult> {
  const direction = optionalString(input, "direction") ?? "down";
  const amount = optionalInteger(input, "amount") ?? 500;
  const selector = optionalString(input, "selector");
  const page = await browserSession.getPage();

  if (selector) {
    // Scroll element into view
    const locator = resolveLocator(page, selector);
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 });
    return { content: `Scrolled element "${selector}" into view.` };
  }

  let deltaX = 0;
  let deltaY = 0;
  switch (direction) {
    case "down": deltaY = amount; break;
    case "up": deltaY = -amount; break;
    case "right": deltaX = amount; break;
    case "left": deltaX = -amount; break;
    default:
      return { content: `Invalid scroll direction "${direction}". Use: up, down, left, right.`, is_error: true };
  }

  await page.evaluate(({ dx, dy }: { dx: number; dy: number }) => {
    window.scrollBy(dx, dy);
  }, { dx: deltaX, dy: deltaY });

  // Get new scroll position
  const scrollPos = await page.evaluate(() => ({
    x: window.scrollX,
    y: window.scrollY,
    maxY: document.body.scrollHeight - window.innerHeight,
    maxX: document.body.scrollWidth - window.innerWidth,
  }));

  return {
    content: `Scrolled ${direction} by ${amount}px. Position: (${scrollPos.x}, ${scrollPos.y}) / max: (${scrollPos.maxX}, ${scrollPos.maxY})`,
  };
}

async function actionHover(input: ToolInput): Promise<ToolResult> {
  let selector: string;
  try {
    selector = requireString(input, "selector");
  } catch (err) {
    if (err instanceof ToolInputError) return { content: err.message, is_error: true };
    throw err;
  }

  const page = await browserSession.getPage();
  const locator = resolveLocator(page, selector);
  await locator.hover({ timeout: 10_000 });

  return { content: `Hovered over "${selector}".` };
}

async function actionBack(): Promise<ToolResult> {
  const page = await browserSession.getPage();
  await page.goBack({ waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
  const summary = await getPageSummary(page);
  return { content: `Navigated back.\n${summary}` };
}

async function actionForward(): Promise<ToolResult> {
  const page = await browserSession.getPage();
  await page.goForward({ waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
  const summary = await getPageSummary(page);
  return { content: `Navigated forward.\n${summary}` };
}

async function actionReload(): Promise<ToolResult> {
  const page = await browserSession.getPage();
  await page.reload({ waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
  const summary = await getPageSummary(page);
  return { content: `Page reloaded.\n${summary}` };
}

async function actionNewTab(): Promise<ToolResult> {
  const { tabId } = await browserSession.newTab();
  return { content: `Opened new tab: ${tabId}. It is now the active tab.` };
}

async function actionSwitchTab(input: ToolInput): Promise<ToolResult> {
  let tabId: string;
  try {
    tabId = requireString(input, "tab_id");
  } catch (err) {
    if (err instanceof ToolInputError) return { content: err.message, is_error: true };
    throw err;
  }

  const page = browserSession.switchTab(tabId);
  const summary = await getPageSummary(page);
  return { content: `Switched to tab ${tabId}.\n${summary}` };
}

async function actionCloseTab(input: ToolInput): Promise<ToolResult> {
  let tabId: string;
  try {
    tabId = requireString(input, "tab_id");
  } catch (err) {
    if (err instanceof ToolInputError) return { content: err.message, is_error: true };
    throw err;
  }

  const activeTab = await browserSession.closeTab(tabId);
  return { content: `Closed tab ${tabId}. Active tab is now: ${activeTab}` };
}

async function actionListTabs(): Promise<ToolResult> {
  const tabs = browserSession.listTabs();
  if (tabs.length === 0) {
    return { content: "No tabs are open. Use 'navigate' to open a page." };
  }

  // Fetch titles (async)
  const page = await browserSession.getPage();
  for (const tab of tabs) {
    try {
      // We can only get the title of the active page easily
      if (tab.active) {
        tab.title = await page.title();
      }
    } catch {
      tab.title = "(unknown)";
    }
  }

  const lines = tabs.map(
    (t) => `  ${t.active ? "→ " : "  "}${t.tabId}: ${t.url} — ${t.title || "(untitled)"}`
  );
  return {
    content: `Open tabs (${tabs.length}):\n${lines.join("\n")}`,
  };
}

async function actionClose(): Promise<ToolResult> {
  // Auto-save to default profile before closing so auth state is preserved
  // across idle-timeout closes and explicit close actions.
  if (browserSession.isRunning) {
    try {
      const page = await browserSession.getPage();
      const context = page.context();
      const authPath = getAuthFilePath("default");
      await context.storageState({ path: authPath });
    } catch {
      // Best-effort — don't fail the close action if save fails
    }
  }
  await browserSession.close();
  return { content: "Browser closed. Auth state auto-saved to 'default' profile. All tabs and session data have been cleared." };
}

// ── Auth action implementations ─────────────────────────────────────────────

async function actionSaveAuth(input: ToolInput): Promise<ToolResult> {
  const profile = optionalString(input, "profile") ?? "default";
  const authPath = getAuthFilePath(profile);

  const page = await browserSession.getPage();
  const context = page.context();

  // Save storage state (cookies + localStorage) to disk
  await context.storageState({ path: authPath });

  // Count what was saved for a useful summary
  const state = JSON.parse(readFileSync(authPath, "utf-8"));
  const cookieCount = Array.isArray(state.cookies) ? state.cookies.length : 0;
  const originCount = Array.isArray(state.origins) ? state.origins.length : 0;

  // Extract cookie domains for the summary and metadata
  const domains = new Set<string>();
  if (Array.isArray(state.cookies)) {
    for (const c of state.cookies) {
      if (c.domain) {
        // Normalize domain: strip leading dot for clean patterns
        const d = c.domain.replace(/^\./, "");
        domains.add(d);
      }
    }
  }

  // Save metadata so domain-based auto-load works even without settings.json
  const meta: ProfileMetadata = {
    name: profile,
    domains: [...domains],
    savedAt: new Date().toISOString(),
    cookieCount,
  };
  saveProfileMetadata(profile, meta);

  // Invalidate profile match cache since we just saved new domain associations
  _profileMatchCache = null;

  return {
    content: [
      `Auth state saved to profile "${profile}".`,
      `  Cookies: ${cookieCount} (domains: ${[...domains].join(", ") || "none"})`,
      `  localStorage origins: ${originCount}`,
      `  Path: ${authPath}`,
      "",
      `This profile will auto-load when navigating to: ${[...domains].join(", ") || "(no domains)"}`,
      `Use load_auth with profile "${profile}" to manually restore this session.`,
    ].join("\n"),
  };
}

async function actionLoadAuth(input: ToolInput): Promise<ToolResult> {
  const profile = optionalString(input, "profile") ?? "default";
  const authPath = getAuthFilePath(profile);

  if (!existsSync(authPath)) {
    const available = listAuthProfiles();
    return {
      content: `Auth profile "${profile}" not found. ` +
        (available.length > 0
          ? `Available profiles: ${available.join(", ")}`
          : "No saved profiles. Use save_auth after logging in."),
      is_error: true,
    };
  }

  // Validate the file before using it
  try {
    JSON.parse(readFileSync(authPath, "utf-8"));
  } catch {
    return {
      content: `Auth profile "${profile}" is corrupted. Delete it with delete_auth and re-login.`,
      is_error: true,
    };
  }

  // Close existing browser and restart with the saved state.
  // We must create a new BrowserContext with the storageState — Playwright
  // doesn't support merging storage state into an existing context.
  await browserSession.close();

  // Override the default storage state for the next ensureBrowser() call.
  // We write the target profile to the default path so ensureBrowser picks it up.
  // But we also keep the original profile file intact.
  const defaultPath = getAuthFilePath("default");
  if (profile !== "default") {
    writeFileSync(defaultPath, readFileSync(authPath, "utf-8"));
  }

  // Force re-launch with the storage state
  const page = await browserSession.getPage();

  const state = JSON.parse(readFileSync(authPath, "utf-8"));
  const cookieCount = Array.isArray(state.cookies) ? state.cookies.length : 0;

  return {
    content: [
      `Auth profile "${profile}" loaded. Browser restarted with saved session.`,
      `  ${cookieCount} cookies restored.`,
      `  The browser now has the saved cookies and localStorage.`,
      `  Navigate to the target site to verify the session is active.`,
    ].join("\n"),
  };
}

async function actionListAuth(): Promise<ToolResult> {
  const profiles = listAuthProfiles();

  if (profiles.length === 0) {
    return { content: "No saved auth profiles. Use save_auth after logging in to save a session." };
  }

  // Also load configured profiles from settings.json
  const configs = loadProfileConfigs();

  const lines: string[] = ["Saved auth profiles:"];
  for (const profile of profiles) {
    const authPath = getAuthFilePath(profile);
    try {
      const state = JSON.parse(readFileSync(authPath, "utf-8"));
      const cookieCount = Array.isArray(state.cookies) ? state.cookies.length : 0;
      const originCount = Array.isArray(state.origins) ? state.origins.length : 0;
      // Get domains from metadata (preferred) or from cookies (fallback)
      const meta = loadProfileMetadata(profile);
      const domains = meta?.domains ?? [];
      const configDomains = configs[profile]?.domains ?? [];
      const allDomains = new Set([...domains, ...configDomains]);
      const autoLoad = configs[profile]?.autoLoad !== false;

      lines.push(`  • ${profile}: ${cookieCount} cookies, ${originCount} localStorage origins`);
      if (allDomains.size > 0) {
        lines.push(`    Domains: ${[...allDomains].join(", ")}${autoLoad ? " (auto-load)" : " (manual)"}`);
      }
      if (meta?.savedAt) {
        lines.push(`    Saved: ${meta.savedAt}`);
      }
    } catch {
      lines.push(`  • ${profile}: (corrupted — delete and re-save)`);
    }
  }

  // Show configured profiles that don't have saved state yet
  for (const [name, config] of Object.entries(configs)) {
    if (!profiles.includes(name)) {
      lines.push(`  • ${name}: (configured but not saved yet)`);
      lines.push(`    Domains: ${config.domains.join(", ")}`);
      lines.push(`    → Log in and use save_auth with profile "${name}" to enable auto-load`);
    }
  }

  return { content: lines.join("\n") };
}

async function actionDeleteAuth(input: ToolInput): Promise<ToolResult> {
  const profile = optionalString(input, "profile") ?? "default";
  const authPath = getAuthFilePath(profile);
  const metaPath = getMetaFilePath(profile);

  if (!existsSync(authPath)) {
    return { content: `Auth profile "${profile}" does not exist.`, is_error: true };
  }

  try {
    unlinkSync(authPath);
    // Also delete metadata file if it exists
    try { unlinkSync(metaPath); } catch { /* ok if missing */ }
    // Invalidate cache and auto-load tracking
    _profileMatchCache = null;
    autoLoadedProfiles.delete(profile);
    return { content: `Auth profile "${profile}" deleted (storage state + metadata).` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: `Failed to delete auth profile "${profile}": ${msg}`, is_error: true };
  }
}

async function actionSetCookies(input: ToolInput): Promise<ToolResult> {
  const rawCookies = input.cookies;
  if (!rawCookies || !Array.isArray(rawCookies)) {
    return {
      content: 'set_cookies requires a "cookies" array parameter. Each cookie: {name, value, domain, path?, expires?, httpOnly?, secure?, sameSite?}.',
      is_error: true,
    };
  }

  if (rawCookies.length === 0) {
    return { content: "No cookies provided.", is_error: true };
  }

  if (rawCookies.length > 100) {
    return { content: `Too many cookies (${rawCookies.length}). Maximum 100 at a time.`, is_error: true };
  }

  // Validate and transform cookies to Playwright format
  const cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Strict" | "Lax" | "None";
  }> = [];

  for (let i = 0; i < rawCookies.length; i++) {
    const c = rawCookies[i];
    if (!c || typeof c !== "object") {
      return { content: `cookies[${i}] is not an object.`, is_error: true };
    }
    if (!c.name || typeof c.name !== "string") {
      return { content: `cookies[${i}].name is required and must be a string.`, is_error: true };
    }
    if (typeof c.value !== "string") {
      return { content: `cookies[${i}].value is required and must be a string.`, is_error: true };
    }
    if (!c.domain || typeof c.domain !== "string") {
      return { content: `cookies[${i}].domain is required and must be a string.`, is_error: true };
    }

    // SSRF check: don't let cookies be set for private/internal domains
    const domain = c.domain.replace(/^\./, ""); // strip leading dot
    if (isPrivateOrReservedHost(domain)) {
      return {
        content: `cookies[${i}].domain "${c.domain}" resolves to a private/internal address. Blocked for security.`,
        is_error: true,
      };
    }

    cookies.push({
      name: c.name,
      value: c.value,
      domain: c.domain,
      path: typeof c.path === "string" ? c.path : "/",
      expires: typeof c.expires === "number" ? c.expires : -1,
      httpOnly: typeof c.httpOnly === "boolean" ? c.httpOnly : false,
      secure: typeof c.secure === "boolean" ? c.secure : false,
      sameSite: (c.sameSite === "Strict" || c.sameSite === "Lax" || c.sameSite === "None")
        ? c.sameSite
        : "Lax",
    });
  }

  const page = await browserSession.getPage();
  const context = page.context();
  await context.addCookies(cookies);

  const domains = new Set(cookies.map((c) => c.domain));
  return {
    content: `Set ${cookies.length} cookie(s) for domain(s): ${[...domains].join(", ")}. Navigate to the site to use the session.`,
  };
}

async function actionGetCookies(input: ToolInput): Promise<ToolResult> {
  const url = optionalString(input, "url");
  const page = await browserSession.getPage();
  const context = page.context();

  // Get cookies — filter by URL if provided
  const cookies = await context.cookies(url ? [url] : [page.url()]);

  if (cookies.length === 0) {
    return { content: "No cookies found for the current page/URL." };
  }

  // Format cookies for readability (redact values for security — show first 8 chars)
  const lines = cookies.map((c) => {
    const valuePreview = c.value.length > 8 ? c.value.slice(0, 8) + "..." : c.value;
    const parts = [`  ${c.name}=${valuePreview}`];
    parts.push(`domain=${c.domain}`);
    parts.push(`path=${c.path}`);
    if (c.httpOnly) parts.push("httpOnly");
    if (c.secure) parts.push("secure");
    if (c.expires > 0) {
      const expDate = new Date(c.expires * 1000);
      parts.push(`expires=${expDate.toISOString()}`);
    } else {
      parts.push("session");
    }
    return parts.join(" | ");
  });

  return {
    content: `Cookies (${cookies.length}):\n${lines.join("\n")}`,
  };
}

// ── Headed / Human-in-the-loop action implementations ───────────────────────

async function actionShowBrowser(): Promise<ToolResult> {
  if (browserSession.isHeaded) {
    return { content: "Browser is already in headed (visible) mode." };
  }

  // Navigate back to current page after restart so user sees where we were
  let currentUrl: string | null = null;
  if (browserSession.isRunning) {
    try {
      const page = await browserSession.getPage();
      const url = page.url();
      if (url && url !== "about:blank") currentUrl = url;
    } catch { /* no page yet */ }
  }

  await browserSession.switchToHeaded();

  // Restore the previous page
  if (currentUrl) {
    try {
      const page = await browserSession.getPage();
      await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
    } catch { /* best-effort */ }
  }

  const summary = browserSession.isRunning
    ? await getPageSummary(await browserSession.getPage())
    : "Browser launched in headed mode.";

  return {
    content: [
      "🖥️  Browser switched to HEADED mode — a visible browser window is now open.",
      summary,
      "",
      "The human can now see and interact with the browser directly.",
      "Use 'wait_for_user' to pause while the human completes an action (e.g., CAPTCHA, 2FA).",
      "Use 'hide_browser' when human interaction is complete to switch back to headless.",
    ].join("\n"),
  };
}

async function actionHideBrowser(): Promise<ToolResult> {
  if (!browserSession.isHeaded) {
    return { content: "Browser is already in headless mode." };
  }

  // Save where we are before switching
  let currentUrl: string | null = null;
  if (browserSession.isRunning) {
    try {
      const page = await browserSession.getPage();
      const url = page.url();
      if (url && url !== "about:blank") currentUrl = url;
    } catch { /* no page yet */ }
  }

  await browserSession.switchToHeadless();

  // Restore the page
  if (currentUrl) {
    try {
      const page = await browserSession.getPage();
      await page.goto(currentUrl, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
    } catch { /* best-effort */ }
  }

  const summary = browserSession.isRunning
    ? await getPageSummary(await browserSession.getPage())
    : "Browser running in headless mode.";

  return {
    content: [
      "Browser switched back to HEADLESS mode (window closed).",
      summary,
      "Agent has full control again.",
    ].join("\n"),
  };
}

/**
 * Maximum wait time for wait_for_user action: 5 minutes.
 * This is intentionally long because humans may need time to solve CAPTCHAs,
 * enter 2FA codes from their phone, or navigate complex SSO flows.
 */
const WAIT_FOR_USER_MAX_TIMEOUT = 5 * 60 * 1000;

/** Polling interval for wait_for_user condition checks. */
const WAIT_FOR_USER_POLL_INTERVAL = 1_000;

async function actionWaitForUser(input: ToolInput, context: ToolContext): Promise<ToolResult> {
  const waitUntil = optionalString(input, "wait_until") ?? "url_change";
  const selector = optionalString(input, "selector");
  const message = optionalString(input, "message") ?? "Please complete the required action in the browser.";
  const timeout = optionalInteger(input, "timeout") ?? WAIT_FOR_USER_MAX_TIMEOUT;

  // Clamp timeout
  const effectiveTimeout = Math.min(Math.max(timeout, 5000), WAIT_FOR_USER_MAX_TIMEOUT);

  // Warn if not in headed mode — user can't see anything
  if (!browserSession.isHeaded) {
    return {
      content: [
        "⚠️  Browser is in headless mode — the user cannot see it!",
        "Call show_browser first to make the browser visible, then call wait_for_user.",
      ].join("\n"),
      is_error: true,
    };
  }

  if (waitUntil === "element" && !selector) {
    return {
      content: 'wait_for_user with wait_until="element" requires a "selector" parameter to know what element to wait for.',
      is_error: true,
    };
  }

  const page = await browserSession.getPage();
  const startUrl = page.url();
  const startTime = Date.now();

  // Tell the agent (and user) what we're waiting for
  const waitDescription = waitUntil === "url_change"
    ? "Waiting for the page URL to change (e.g., login redirect)..."
    : waitUntil === "element"
      ? `Waiting for element "${selector}" to appear...`
      : "Waiting for network activity to settle...";

  // Poll until the condition is met, the timeout expires, or the agent is aborted
  let conditionMet = false;
  let lastError = "";

  while (Date.now() - startTime < effectiveTimeout) {
    // Check abort signal
    if (context.abortController.signal.aborted) {
      return { content: "wait_for_user was aborted by the user.", is_error: true };
    }

    try {
      switch (waitUntil) {
        case "url_change": {
          const currentUrl = page.url();
          if (currentUrl !== startUrl) {
            conditionMet = true;
          }
          break;
        }
        case "element": {
          if (selector) {
            const locator = resolveLocator(page, selector);
            const count = await locator.count();
            if (count > 0) {
              const isVisible = await locator.first().isVisible();
              if (isVisible) conditionMet = true;
            }
          }
          break;
        }
        case "network_idle": {
          // Check if the page has been stable (no pending requests) for 2 seconds
          try {
            await page.waitForLoadState("networkidle", { timeout: 2000 });
            conditionMet = true;
          } catch {
            // Still loading — keep polling
          }
          break;
        }
        default:
          return { content: `Unknown wait_until condition: "${waitUntil}". Use: url_change, element, network_idle.`, is_error: true };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // Page may have navigated — check if it's still valid
      if (page.isClosed()) {
        return {
          content: "The browser tab was closed during wait_for_user. The user may have closed the browser window.",
          is_error: true,
        };
      }
    }

    if (conditionMet) break;

    // Sleep between polls
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, WAIT_FOR_USER_POLL_INTERVAL);
      if (typeof timer === "object" && typeof timer.unref === "function") {
        timer.unref();
      }
    });
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

  if (!conditionMet) {
    return {
      content: [
        `⏰ wait_for_user timed out after ${elapsed}s.`,
        `Condition: ${waitDescription}`,
        lastError ? `Last error: ${lastError}` : "",
        "",
        "The human may not have completed the action in time.",
        "You can call wait_for_user again to continue waiting, or try a different approach.",
      ].filter(Boolean).join("\n"),
      is_error: true,
    };
  }

  // Condition was met — get the new page state
  const summary = await getPageSummary(page);
  const elements = await extractInteractiveElements(page, 30);

  return {
    content: [
      `✅ Human interaction completed (${elapsed}s).`,
      `Condition met: ${waitDescription}`,
      summary,
      "",
      "── Interactive elements ──",
      elements,
      "",
      "You can now continue the automation. Consider:",
      "• Use save_auth to persist the login session",
      "• Use hide_browser to switch back to headless mode",
    ].join("\n"),
  };
}

// ── Locator helper ──────────────────────────────────────────────────────────
// Resolves a flexible selector string to a Playwright Locator.
// Supports:
//   - CSS selectors: "#id", ".class", "div > a"
//   - Text selectors: "text=Click me"
//   - Role selectors: "role=button[name='Submit']"
//   - Test ID selectors: "data-testid=login-btn"

function resolveLocator(page: Page, selector: string) {
  if (selector.startsWith("text=")) {
    return page.getByText(selector.slice(5));
  }
  if (selector.startsWith("role=")) {
    const roleStr = selector.slice(5);
    const match = roleStr.match(/^(\w+)(?:\[name=['"](.+)['"]\])?$/);
    if (match) {
      const [, role, name] = match;
      if (name) {
        return page.getByRole(role as Parameters<typeof page.getByRole>[0], { name });
      }
      return page.getByRole(role as Parameters<typeof page.getByRole>[0]);
    }
    return page.locator(selector);
  }
  if (selector.startsWith("data-testid=")) {
    return page.getByTestId(selector.slice(12));
  }
  if (selector.startsWith("label=")) {
    return page.getByLabel(selector.slice(6));
  }
  if (selector.startsWith("placeholder=")) {
    return page.getByPlaceholder(selector.slice(12));
  }
  if (selector.startsWith("alt=")) {
    return page.getByAltText(selector.slice(4));
  }
  if (selector.startsWith("title=")) {
    return page.getByTitle(selector.slice(6));
  }
  return page.locator(selector);
}

// ── Export the session manager for cleanup from external code ────────────────

/**
 * Close the browser session. Called by session management code to ensure
 * cleanup when the agent session ends or the user runs /clear.
 */
export async function closeBrowserSession(): Promise<void> {
  await browserSession.close();
}
