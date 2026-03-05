import { readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import type { AppConfig } from "../core/types.js";
import { hasErrnoCode } from "../tools/validate.js";
import { printWarning } from "../ui/ui.js";
import { loadAllEnv } from "./env.js";

/**
 * Strictly parse a string as a **decimal** integer, rejecting:
 *   - trailing non-numeric characters: `parseInt("123abc", 10)` → 123
 *     (silently ignores "abc"), but `strictParseInt` returns NaN
 *   - floats: "16384.5" → NaN
 *   - hex literals: "0x1A" → NaN  (previously accepted as 26 via `Number()`)
 *   - octal literals: "0o17" → NaN (previously accepted as 15 via `Number()`)
 *   - binary literals: "0b1010" → NaN (previously accepted as 10)
 *
 * `Number()` supports hex/octal/binary literal syntax: `Number("0x1A")` → 26,
 * `Number("0o17")` → 15, `Number("0b1010")` → 10. All of these pass
 * `Number.isInteger()`, so the old implementation silently accepted them.
 * Users who type `ANTHROPIC_COMPACTION_THRESHOLD=0x20000` (131072) or
 * `ANTHROPIC_MAX_OUTPUT_TOKENS=0x4000` (16384) would get a valid but
 * unexpected numeric value with no warning that it was interpreted as
 * hex/octal. Now we reject non-decimal inputs by pre-checking with a regex
 * that only allows an optional leading minus and ASCII digits.
 */
function strictParseInt(value: string): number {
  // Reject hex (0x...), octal (0o...), binary (0b...), and leading-zero
  // octal (e.g., "0177") before calling Number(). Only allow optional
  // negative sign + ASCII digits (the decimal integer format).
  if (!/^-?\d+$/.test(value)) return NaN;
  const n = Number(value);
  if (Number.isInteger(n)) return n;
  return NaN;
}

/**
 * Redact userinfo (username:password) from a URL string to prevent
 * credential leaks in warning messages logged to the terminal.
 *
 * URLs like `https://user:s3cret@proxy.example.com/v1` are valid and
 * used by corporate HTTP proxies that require Basic authentication.
 * When `ANTHROPIC_BASE_URL` validation warnings print the URL, the
 * embedded credentials appear in plain text in the terminal output
 * (and potentially in log files, CI output, or screen recordings).
 *
 * Uses the URL constructor to safely extract and replace userinfo,
 * falling back to a regex for URLs that fail to parse. Only the
 * password is fully redacted; the username is preserved (it's usually
 * non-sensitive and helps identify which proxy account is configured).
 *
 * Examples:
 *   "https://user:s3cret@proxy.com" → "https://user:***@proxy.com"
 *   "https://proxy.com"             → "https://proxy.com" (no change)
 *   "not-a-url"                     → "not-a-url" (no change)
 */
function redactUrlCredentials(url: string): string {
  try {
    const parsed = new URL(url);
    if (!parsed.username && !parsed.password) return url;
    // Reconstruct the URL with the password redacted. The URL constructor
    // normalizes the URL, so we use string replacement on the original to
    // preserve the user's exact formatting (trailing slashes, casing, etc.).
    const userinfo = `${parsed.username}:${parsed.password}@`;
    const redacted = `${parsed.username}:***@`;
    // Replace only the first occurrence (the userinfo portion) in the
    // original URL string. The userinfo appears between "://" and "@",
    // so this is unambiguous.
    return url.replace(userinfo, redacted);
  } catch {
    // URL didn't parse — try a simple regex match for user:pass@host.
    // Match the pattern between :// and @ (if present).
    return url.replace(/(\/\/)([^@/]*):([^@/]+)@/, "$1$2:***@");
  }
}

let cachedConfig: AppConfig | null = null;

/**
 * Callbacks invoked when `resetConfig()` is called.
 * Used by `client.ts` to reset the client singleton when config changes,
 * avoiding a circular dependency between config and client modules.
 *
 * Stored as a Set to prevent duplicate registrations. If the same callback
 * function is registered multiple times (e.g., `onConfigReset(resetClient)`
 * called twice due to module re-initialization or hot-reload), using an array
 * would invoke it multiple times — potentially resetting the client twice or
 * causing redundant work. A Set naturally deduplicates by reference equality.
 */
const resetCallbacks = new Set<() => void>();

/**
 * Register a callback to be invoked when `resetConfig()` is called.
 * This allows dependent singletons (e.g., the Anthropic client) to
 * invalidate their caches without creating circular imports.
 *
 * Safe to call multiple times with the same function reference — duplicates
 * are silently ignored (Set semantics).
 */
export function onConfigReset(callback: () => void): void {
  resetCallbacks.add(callback);
}

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  // Ensure all .env files, settings.json, and secrets.json are loaded into
  // process.env before reading config values. This is idempotent — safe to
  // call even if the caller already loaded env files.
  loadAllEnv();

  // homedir() can throw on systems where HOME/USERPROFILE is unset (common in
  // containerized/CI environments with minimal env setup). Without a try/catch,
  // an unhandled Error would crash the process before the REPL starts, with a
  // confusing "Could not determine home directory" message from Node.js.
  let settingsPath: string | null;
  try {
    settingsPath = join(homedir(), ".claude", "settings.json");
  } catch {
    settingsPath = null;
    // Warn the user that their settings.json is being ignored. Without this,
    // users in Docker containers or CI environments with no HOME/USERPROFILE
    // have no idea that their settings.json configuration (API key, model,
    // env vars, compaction threshold, etc.) is being silently skipped. They
    // see all defaults being used and may waste time debugging why their
    // settings aren't taking effect. The warning is printed once at startup
    // and suggests setting HOME as a fix.
    printWarning(
      "Could not determine home directory (HOME/USERPROFILE not set) — " +
      "~/.claude/settings.json will not be loaded. " +
      "Set the HOME environment variable to enable settings.json support."
    );
  }
  let settings: Record<string, unknown> = {};

  if (settingsPath) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf-8"));
      // JSON.parse can return any JSON primitive: null, true, 42, "hello",
      // [1,2,3], etc. Only plain objects are valid settings files. Without
      // this check, `null` causes a TypeError on `settings.env` access
      // (Cannot read properties of null), and arrays/primitives proceed
      // with no env/config validation — silently using all defaults with
      // no warning that the settings file was ignored.
      if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
        settings = parsed as Record<string, unknown>;
      } else {
        printWarning(
          `${settingsPath} contains ${parsed === null ? "null" : Array.isArray(parsed) ? "an array" : `a ${typeof parsed}`} instead of a JSON object — using defaults.`
        );
      }
    } catch (err: unknown) {
      // Distinguish between "file not found" (normal) and "file exists but is invalid JSON"
      if (hasErrnoCode(err) && err.code === "ENOENT") {
        // File doesn't exist — use defaults silently
      } else {
        // File exists but failed to parse — warn the user
        const msg = err instanceof Error ? err.message : String(err);
        printWarning(`Failed to parse ${settingsPath}: ${msg} — using defaults.`);
      }
    }
  }

  // Validate settings.env — must be a plain object whose values are strings.
  // Guard against malformed settings like `"env": 42` or `"env": ["foo"]`.
  let env: Record<string, string> = {};
  if (settings.env != null) {
    if (
      typeof settings.env === "object" &&
      !Array.isArray(settings.env)
    ) {
      // Validate that each value is a string. Non-string values like
      // `"ANTHROPIC_MODEL": 42` would silently pass through and cause
      // confusing errors at the API call level.  Filter them out with a
      // warning so the rest of the env object is still usable.
      const rawEnv = settings.env as Record<string, unknown>;
      for (const [key, value] of Object.entries(rawEnv)) {
        if (typeof value === "string") {
          env[key] = value;
        } else {
          printWarning(
            `env.${key} in settings.json should be a string, got ${typeof value} — ignoring.`
          );
        }
      }
    } else {
      printWarning(
        `"env" in settings.json should be an object, got ${typeof settings.env} — ignoring.`
      );
    }
  }

  // Parse compaction threshold from env or settings, with validation.
  // Must be a positive integer ≥ 10,000 (below that, auto-compaction would
  // fire on nearly every turn, making the agent unusable).
  const DEFAULT_COMPACTION_THRESHOLD = 160_000;
  const rawThreshold =
    (env.ANTHROPIC_COMPACTION_THRESHOLD || process.env.ANTHROPIC_COMPACTION_THRESHOLD || "").trim();
  let compactionThreshold = DEFAULT_COMPACTION_THRESHOLD;
  if (rawThreshold) {
    const parsed = strictParseInt(rawThreshold);
    if (Number.isNaN(parsed) || parsed < 10_000) {
      printWarning(
        `ANTHROPIC_COMPACTION_THRESHOLD="${rawThreshold}" is invalid (must be an integer ≥ 10000). Using default ${DEFAULT_COMPACTION_THRESHOLD.toLocaleString()}.`
      );
    } else if (parsed > 1_000_000) {
      // Values above 1M tokens effectively disable auto-compaction. Most models
      // have 128K–200K context windows, so a threshold above ~180K rarely triggers
      // compaction anyway. At 1M+, the context will hit the API's hard context
      // limit and fail with "context too long" long before compaction runs. Warn
      // but still accept the value since the user may have a specific reason.
      printWarning(
        `ANTHROPIC_COMPACTION_THRESHOLD=${parsed.toLocaleString()} is very high — ` +
        `auto-compaction may never trigger, causing API "context too long" errors. ` +
        `Most models support 128K–200K tokens. Consider a value ≤ 200000.`
      );
      compactionThreshold = parsed;
    } else {
      compactionThreshold = parsed;
    }
  }

  // Validate base URL format — a malformed URL like "not-a-url" or
  // "ftp://example.com" would silently pass through and only fail at API
  // call time with a confusing error (e.g., "Invalid URL" deep inside the
  // HTTP client). Validate early so users get a clear warning at startup.
  // Apply `.trim()` for consistency with model names and compaction threshold
  // — whitespace-only `ANTHROPIC_BASE_URL="  "` is truthy so it passes the
  // `||` fallback, but then fails the regex check with a misleading warning
  // about the URL format (the user sees `""` with no clue it was whitespace).
  const rawBaseUrl =
    (env.ANTHROPIC_BASE_URL || process.env.ANTHROPIC_BASE_URL || "").trim();
  let baseUrl = "https://api.anthropic.com";
  if (rawBaseUrl) {
    if (!/^https?:\/\//i.test(rawBaseUrl)) {
      printWarning(
        `ANTHROPIC_BASE_URL="${redactUrlCredentials(rawBaseUrl)}" does not start with http:// or https://. Using default ${baseUrl}.`
      );
    } else {
      try {
        // Use the URL constructor to validate the full URL format (catches
        // malformed URLs like "https://" with no host, or "https://foo:bar:baz")
        new URL(rawBaseUrl);
        // Strip trailing slashes to prevent double-slash URLs. The Anthropic SDK
        // concatenates baseURL + "/v1/messages", so a trailing slash produces
        // "https://my-proxy.com/v1//messages" which some proxies reject with 404.
        // Multiple trailing slashes (e.g., "https://host///") are also handled.
        baseUrl = rawBaseUrl.replace(/\/+$/, "");
        // Warn if the URL path ends with "/v1" — a very common misconfiguration
        // when copying from OpenAI-style proxy docs. The Anthropic SDK appends
        // its own "/v1/messages" path, so a base URL of "https://proxy.com/v1"
        // produces "https://proxy.com/v1/v1/messages" (double-pathed), which
        // returns a 404 from the proxy. The user gets a confusing "Not Found"
        // error with no indication that the base URL itself is the problem.
        // Warn but still accept the value — some non-standard proxy setups may
        // actually route "/v1/v1/messages" correctly.
        const urlPath = new URL(baseUrl).pathname;
        if (/\/v1$/i.test(urlPath)) {
          const safeUrl = redactUrlCredentials(baseUrl);
          const safeUrlNoV1 = redactUrlCredentials(baseUrl.replace(/\/v1$/i, ""));
          printWarning(
            `ANTHROPIC_BASE_URL="${safeUrl}" ends with "/v1". ` +
            `The Anthropic SDK automatically appends "/v1/messages", so this will produce ` +
            `a double-pathed URL like "${safeUrl}/v1/messages". ` +
            `Did you mean "${safeUrlNoV1}"?`
          );
        }
        // Warn if the URL contains a query string or fragment. The Anthropic SDK
        // concatenates baseURL + "/v1/messages" as a plain string, so a base URL
        // like "https://proxy.com?key=abc" produces the request URL
        // "https://proxy.com?key=abc/v1/messages" — the "/v1/messages" path gets
        // embedded inside the query string instead of forming the URL path, which
        // every server/proxy will reject with a 404 or routing error. Similarly,
        // a fragment "#section" is stripped by HTTP clients and the path suffix is
        // lost entirely. Warn but still accept the value since some SDK versions
        // may handle URL construction differently.
        //
        // Reuse the URL object already parsed above (line ~239) to avoid a
        // redundant `new URL()` allocation. The `urlPath` variable is from the
        // same parse, so the object is implicitly available via re-parsing — but
        // for clarity use a fresh parse of `baseUrl` (which may have had trailing
        // slashes stripped since the `rawBaseUrl` was validated).
        {
          const parsed = new URL(baseUrl);
          if (parsed.search) {
            const safeUrl = redactUrlCredentials(baseUrl);
            printWarning(
              `ANTHROPIC_BASE_URL="${safeUrl}" contains a query string. ` +
              `The SDK appends "/v1/messages" to this URL, which will produce a malformed ` +
              `request URL. Remove the query string from the base URL.`
            );
          }
          if (parsed.hash) {
            const safeUrl = redactUrlCredentials(baseUrl);
            printWarning(
              `ANTHROPIC_BASE_URL="${safeUrl}" contains a URL fragment (#). ` +
              `Fragments are not sent in HTTP requests, and the SDK appends "/v1/messages" ` +
              `after the fragment, producing a malformed URL. Remove the fragment.`
            );
          }
        }
      } catch {
        printWarning(
          `ANTHROPIC_BASE_URL="${redactUrlCredentials(rawBaseUrl)}" is not a valid URL. Using default ${baseUrl}.`
        );
      }
    }
  }

  // Resolve model names from env/settings.  Use `.trim()` to reject
  // whitespace-only values (e.g., `ANTHROPIC_MODEL="  "`): these are truthy
  // so they pass the `||` fallback, but the API rejects them with a confusing
  // "model not found" error.  `||` on the trimmed result falls through to
  // the default when the value is empty or whitespace-only.
  const DEFAULT_MODEL = "claude-sonnet-4-20250514";
  const DEFAULT_SMALL_MODEL = "claude-haiku-3-5-20241022";
  const rawModel = (env.ANTHROPIC_MODEL || process.env.ANTHROPIC_MODEL || "").trim();
  const rawSmallModel = (env.ANTHROPIC_SMALL_FAST_MODEL || process.env.ANTHROPIC_SMALL_FAST_MODEL || "").trim();

  // Warn if model names contain embedded whitespace (e.g., a typo like
  // "claude-sonnet-4 -20250514" with an accidental space). Leading/trailing
  // whitespace is already stripped by `.trim()` above, but embedded spaces
  // pass through silently and cause a confusing 404 "model not found" error
  // from the API. We warn but still use the value because some custom proxy
  // setups or future API versions may accept space-containing identifiers.
  if (rawModel && /\s/.test(rawModel)) {
    printWarning(
      `ANTHROPIC_MODEL="${rawModel}" contains whitespace — this is likely a typo. ` +
      `The API will probably reject this model name. Check for accidental spaces.`
    );
  }
  if (rawSmallModel && /\s/.test(rawSmallModel)) {
    printWarning(
      `ANTHROPIC_SMALL_FAST_MODEL="${rawSmallModel}" contains whitespace — this is likely a typo. ` +
      `The API will probably reject this model name. Check for accidental spaces.`
    );
  }

  // Warn if model names contain control characters. printable ASCII and
  // extended UTF-8 are fine, but control characters (0x00–0x1F, 0x7F) are
  // never valid in model identifiers and cause confusing HTTP errors when
  // injected into the API request body (or headers in some SDK versions).
  // Common source: copy-pasting from terminals that embed escape sequences.
  // eslint-disable-next-line no-control-regex
  const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;
  if (rawModel && CONTROL_CHAR_RE.test(rawModel)) {
    printWarning(
      `ANTHROPIC_MODEL contains control characters (tabs, newlines, escape sequences, etc.) — ` +
      `this is likely corrupted input. The API will reject this model name. ` +
      `Check your environment variable or settings.json for hidden characters.`
    );
  }
  if (rawSmallModel && CONTROL_CHAR_RE.test(rawSmallModel)) {
    printWarning(
      `ANTHROPIC_SMALL_FAST_MODEL contains control characters (tabs, newlines, escape sequences, etc.) — ` +
      `this is likely corrupted input. The API will reject this model name. ` +
      `Check your environment variable or settings.json for hidden characters.`
    );
  }

  // Parse max output tokens from env or settings. Must be a positive integer
  // between 1 and 128000 (API maximum for Claude models). Defaults to 16384
  // which is sufficient for most tool-use turns. Users working with long-form
  // code generation (e.g., writing entire files) may want to increase this.
  const DEFAULT_MAX_OUTPUT_TOKENS = 16384;
  const rawMaxOutputTokens =
    (env.ANTHROPIC_MAX_OUTPUT_TOKENS || process.env.ANTHROPIC_MAX_OUTPUT_TOKENS || "").trim();
  let maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS;
  if (rawMaxOutputTokens) {
    const parsed = strictParseInt(rawMaxOutputTokens);
    if (Number.isNaN(parsed) || parsed < 1) {
      printWarning(
        `ANTHROPIC_MAX_OUTPUT_TOKENS="${rawMaxOutputTokens}" is invalid (must be a positive integer). Using default ${DEFAULT_MAX_OUTPUT_TOKENS.toLocaleString()}.`
      );
    } else if (parsed < 1024) {
      // Values below 1024 tokens cause the model to truncate nearly every
      // response mid-sentence (a typical tool_use response is 200–500 tokens,
      // but multi-step reasoning and code generation regularly exceed 1024).
      // The model hits `max_tokens` → stops → `stop_reason: "max_tokens"` →
      // the agentic loop continues with a truncated assistant message, often
      // producing garbled tool calls or incomplete code. Users who set this
      // low usually misunderstand the unit (confusing characters with tokens)
      // or made a typo (e.g., "128" instead of "12800"). Warn but accept the
      // value since the user may be deliberately testing truncation behavior.
      printWarning(
        `ANTHROPIC_MAX_OUTPUT_TOKENS=${parsed} is very low — ` +
        `the model will truncate most responses mid-sentence. ` +
        `Most tool-use responses require 500–2000 tokens. ` +
        `Consider a value ≥ 4096 (default: ${DEFAULT_MAX_OUTPUT_TOKENS.toLocaleString()}).`
      );
      maxOutputTokens = parsed;
    } else if (parsed > 128_000) {
      printWarning(
        `ANTHROPIC_MAX_OUTPUT_TOKENS=${parsed.toLocaleString()} exceeds 128000 — ` +
        `the API may reject this value. Check your model's maximum output token limit in the Anthropic documentation. ` +
        `Using the value anyway in case your model/API supports it.`
      );
      maxOutputTokens = parsed;
    } else {
      maxOutputTokens = parsed;
    }
  }

  const resolvedModel = rawModel || DEFAULT_MODEL;
  const resolvedSmallModel = rawSmallModel || DEFAULT_SMALL_MODEL;

  // Warn when model and smallModel are the same. The small model is intended
  // for cheap/fast tasks (compaction summarization, Explore agents) — using the
  // same expensive model for both means compaction API calls cost as much as
  // regular turns (e.g., Sonnet at $3/$15 per MTok for summarization instead of
  // Haiku at $0.80/$4.00). This is almost always a misconfiguration: the user
  // set ANTHROPIC_MODEL but forgot to set ANTHROPIC_SMALL_FAST_MODEL (which
  // defaults to Haiku), or set both to the same value by mistake. The warning
  // is non-blocking — some users may intentionally want the same model for
  // quality reasons (e.g., using Opus for everything).
  if (resolvedModel === resolvedSmallModel && rawSmallModel) {
    printWarning(
      `ANTHROPIC_MODEL and ANTHROPIC_SMALL_FAST_MODEL are both "${resolvedModel}". ` +
      `The small model is used for compaction and exploration — a cheaper/faster model ` +
      `(e.g., claude-haiku-3-5-20241022) is recommended to reduce costs.`
    );
  }

  // Parse debug flag from env or settings. Truthy values: "1", "true", "yes", "on".
  const rawDebug = (env.CODINGAGENT_DEBUG || process.env.CODINGAGENT_DEBUG || "").trim().toLowerCase();
  const debug = ["1", "true", "yes", "on"].includes(rawDebug);

  // Parse streaming disable flag from env or settings. When true, the agent
  // skips `client.messages.stream()` and calls `client.messages.create()`
  // (non-streaming) directly. Useful behind proxies that don't support SSE,
  // or for integration testing with mock servers that only serve JSON.
  const rawDisableStreaming = (env.ANTHROPIC_DISABLE_STREAMING || process.env.ANTHROPIC_DISABLE_STREAMING || "").trim().toLowerCase();
  const disableStreaming = ["1", "true", "yes", "on"].includes(rawDisableStreaming);

  // Parse additional skill directories from settings.json. Must be an array of
  // non-empty strings. Supports `~` expansion (expanded to homedir at resolution
  // time by the skills module). These directories are loaded IN ADDITION to the
  // built-in default paths (`~/.claude/skills` and `.claude/skills`), which are
  // always searched. User-configured directories are searched last, so they take
  // precedence when skill names collide.
  //
  // Configure via `"skillDirs"` in `~/.claude/settings.json`:
  //   { "skillDirs": ["/shared/team-skills", "C:\\company\\prompts"] }
  let skillDirs: string[] = [];
  if (settings.skillDirs != null) {
    if (Array.isArray(settings.skillDirs)) {
      for (let i = 0; i < settings.skillDirs.length; i++) {
        const item = settings.skillDirs[i];
        if (typeof item === "string" && item.trim()) {
          skillDirs.push(item.trim());
        } else {
          printWarning(
            `skillDirs[${i}] in settings.json should be a non-empty string, got ${typeof item} — skipping.`
          );
        }
      }
    } else {
      printWarning(
        `"skillDirs" in settings.json should be an array of directory paths, got ${typeof settings.skillDirs} — ignoring.`
      );
    }
  }

  cachedConfig = {
    baseUrl,
    model: resolvedModel,
    smallModel: resolvedSmallModel,
    compactionThreshold,
    maxOutputTokens,
    debug,
    disableStreaming,
    skillDirs,
    // Source the API key using the same `env.X || process.env.X` precedence
    // pattern used for every other config value (baseUrl, model, etc.).
    // Previously, `client.ts` only checked `process.env.ANTHROPIC_API_KEY`,
    // so a key set in `settings.json` under `"env"` was silently ignored —
    // unlike every other setting, which respected settings.json. The `?.trim()`
    // strips whitespace (a common copy-paste mistake that causes confusing 401
    // errors because spaces are not valid in HTTP auth headers).
    apiKey: (() => {
      const rawKey = (env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY)?.trim();
      if (!rawKey) return undefined;
      // Reject suspiciously long keys. Valid Anthropic API keys are ~100–200
      // characters. A multi-KB or multi-MB value (e.g., from accidentally
      // sourcing an entire file into the env var: `export ANTHROPIC_API_KEY=$(cat file)`,
      // or a corrupt settings.json with a large base64 blob) would be sent as
      // an HTTP header (`Authorization: Bearer <key>`). Most HTTP servers and
      // proxies reject headers larger than 8–16 KB (nginx default: 8 KB,
      // Apache: 8 KB, Cloudflare: 16 KB), producing confusing 431 "Request
      // Header Fields Too Large" or silent connection resets with no indication
      // that the API key itself is the problem. Catch this early with a clear
      // message. 500 chars is generous — real keys are ~108 chars — while
      // catching the pathological multi-KB/MB cases.
      if (rawKey.length > 500) {
        printWarning(
          `ANTHROPIC_API_KEY is suspiciously long (${rawKey.length.toLocaleString()} chars). ` +
          `Valid Anthropic keys are typically ~100 characters. ` +
          `Check that the environment variable or settings.json doesn't contain a file or extra data.`
        );
        // Still accept the key — custom proxy setups may use long tokens
      }
      // Reject keys containing control characters (newlines, tabs, null bytes,
      // etc.) that could cause HTTP header injection when the SDK inserts the
      // key into the `Authorization: Bearer <key>` header. A newline in the key
      // (e.g., from a malformed settings.json or env var with embedded `\n`)
      // would split the header, potentially injecting arbitrary HTTP headers.
      // This is defense-in-depth — the user controls their own config, but a
      // corrupted or misconfigured settings file shouldn't become a security
      // issue. ASCII control chars are C0 (0x00–0x1F) and DEL (0x7F).
      if (/[\x00-\x1f\x7f]/.test(rawKey)) {
        printWarning(
          `ANTHROPIC_API_KEY contains control characters (newlines, tabs, etc.) — ignoring. ` +
          `Check your settings.json or environment variable for hidden characters.`
        );
        return undefined;
      }
      // Warn if the API key doesn't look like an Anthropic key.
      // Anthropic API keys start with "sk-ant-" (e.g., sk-ant-api03-...).
      // A common mistake is using an OpenAI key (sk-...) or a different
      // provider's key. The API returns a generic 401 error with no
      // indication that the key format itself is wrong — the user assumes
      // the key is correct but expired or lacks permissions, wasting time
      // debugging the wrong issue. Warning at startup gives immediate,
      // actionable feedback. We still accept the key because non-standard
      // proxy setups may use custom key formats that happen not to match.
      if (!rawKey.startsWith("sk-ant-")) {
        printWarning(
          `ANTHROPIC_API_KEY does not start with "sk-ant-" — this may not be a valid Anthropic API key. ` +
          `Anthropic keys look like "sk-ant-api03-...". If you're using a proxy, you can ignore this warning.`
        );
      } else if (rawKey.length < 20) {
        // The key has the correct "sk-ant-" prefix (7 chars) but is
        // suspiciously short — real Anthropic keys are 90+ characters.
        // A key like "sk-ant-" or "sk-ant-api03" is almost certainly
        // truncated (partial paste, incomplete env var, or a placeholder
        // value from documentation). The API returns a generic 401 error
        // with no indication that the key is truncated. Warning at startup
        // gives the user immediate feedback so they can fix the key before
        // hitting a cryptic authentication error.
        printWarning(
          `ANTHROPIC_API_KEY looks truncated (${rawKey.length} chars). ` +
          `Valid Anthropic keys are typically 90+ characters (e.g., "sk-ant-api03-..."). ` +
          `Check that the full key was pasted correctly.`
        );
      }
      return rawKey;
    })(),
  };

  return cachedConfig;
}

export function getConfig(): AppConfig {
  return cachedConfig ?? loadConfig();
}

/**
 * Reset the cached config and all dependent singletons (e.g., the API
 * client). Call this after changing API settings mid-session so the next
 * `getConfig()` / `getClient()` calls pick up the new values.
 *
 * Each callback is invoked in its own try/catch so a failure in one
 * (e.g., `resetClient()` throwing) does not skip the remaining callbacks.
 * Without this, a single throw would leave later singletons in a stale
 * state — for example, if a future callback to reset a logging sink was
 * registered after `resetClient`, it would never fire.
 */
export function resetConfig(): void {
  cachedConfig = null;
  for (const cb of resetCallbacks) {
    try {
      cb();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // Use printWarning for consistent formatting. The try/catch here ensures
      // that if printWarning itself failed (e.g., a future refactor added
      // an import that broke during reset), we don't lose the diagnostic
      // message. In that unlikely case, we fall back to a direct console.warn.
      try {
        printWarning(`Config reset callback failed: ${msg}`);
      } catch {
        console.warn(`[Warning] Config reset callback failed: ${msg}`);
      }
    }
  }
}
