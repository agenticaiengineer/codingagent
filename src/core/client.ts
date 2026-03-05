import Anthropic from "@anthropic-ai/sdk";
import { getConfig, onConfigReset } from "../config/config.js";
import { printWarning } from "../ui/ui.js";

/**
 * Shared Anthropic API client singleton.
 *
 * All modules that need the Anthropic client should import `getClient()`
 * rather than constructing their own instance, ensuring consistent
 * configuration and connection reuse.
 */
let clientInstance: Anthropic | null = null;

export function getClient(): Anthropic {
  if (!clientInstance) {
    const config = getConfig();
    // Use the API key from config, which sources from both settings.json
    // and process.env (with settings.json taking priority, matching the
    // precedence pattern used for all other config values like model, baseUrl).
    // Whitespace trimming is already done in config.ts.
    const apiKey = config.apiKey;
    if (!apiKey) {
      const setCmd =
        process.platform === "win32"
          ? "PowerShell:  $env:ANTHROPIC_API_KEY = \"sk-ant-...\"\n" +
            "         cmd:  set ANTHROPIC_API_KEY=sk-ant-..."
          : "export ANTHROPIC_API_KEY=sk-ant-...";
      // Use printWarning for consistent formatting with the rest of the
      // codebase. Previously used console.warn, which produced a different
      // format ("[Warning]..." vs "⚠ ...") — making this warning look like
      // it came from a different application.
      printWarning(
        `ANTHROPIC_API_KEY is not set. API calls will fail with 401 Unauthorized.\n` +
        `Set it via: ${setCmd}\n` +
        `Or add it to ~/.claude/settings.json under "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }`
      );
    }
    clientInstance = new Anthropic({
      baseURL: config.baseUrl,
      apiKey: apiKey || "not-set",
    });
  }
  return clientInstance;
}

/**
 * Reset the cached client instance. Called automatically when
 * `resetConfig()` is invoked, so the next `getClient()` call
 * picks up the new configuration (e.g., changed base URL).
 */
export function resetClient(): void {
  clientInstance = null;
}

// Automatically invalidate the client when config is reset,
// ensuring baseUrl changes take effect without callers needing
// to remember to call resetClient() separately.
onConfigReset(resetClient);
