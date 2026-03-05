/**
 * Shared environment loading utilities.
 *
 * Loads environment variables from `.env` files, `~/.claude/settings.json`,
 * and `~/.codingagent/secrets.json` into `process.env`. All loaders use
 * "first wins" semantics — they never override variables already set.
 *
 * This module is intentionally **lightweight** — no imports from core/,
 * tools/, or ui/ — so it can be used by any entry point (gateway, worker,
 * standalone scripts) without pulling in heavy dependencies.
 *
 * @module env
 */

import { readFileSync } from "fs";
import { join, resolve } from "path";
import { homedir } from "os";

// ═══════════════════════════════════════════════════════════════════════════════
// Individual loaders
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Minimal .env file loader — reads KEY=VALUE lines into `process.env`.
 *
 * - Supports `# comments` and blank lines
 * - Supports `export KEY=VALUE` syntax
 * - Strips surrounding single/double quotes from values
 * - Does NOT override variables already set in the environment
 * - Silently returns if the file doesn't exist
 */
export function loadEnvFile(filePath: string): void {
  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return; // file doesn't exist — that's fine
  }
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    // Support `export KEY=VALUE` syntax
    const normalized = trimmed.startsWith("export ") ? trimmed.slice(7) : trimmed;
    const eqIdx = normalized.indexOf("=");
    if (eqIdx < 1) continue;
    const key = normalized.slice(0, eqIdx).trim();
    let value = normalized.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

/**
 * Load env vars from `~/.claude/settings.json` `"env"` object into `process.env`.
 * Does NOT override variables already set.
 */
export function loadSettingsEnv(): void {
  let settingsPath: string;
  try {
    settingsPath = join(homedir(), ".claude", "settings.json");
  } catch {
    return; // HOME not set — skip
  }
  let content: string;
  try {
    content = readFileSync(settingsPath, "utf-8");
  } catch {
    return; // file doesn't exist — that's fine
  }
  try {
    const settings = JSON.parse(content);
    if (
      settings?.env &&
      typeof settings.env === "object" &&
      !Array.isArray(settings.env)
    ) {
      for (const [key, value] of Object.entries(settings.env)) {
        if (typeof value === "string" && process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    }
  } catch {
    // config.ts will warn about parse errors — no need to duplicate
  }
}

/**
 * Load secrets from `~/.codingagent/secrets.json` into `process.env`.
 * Does NOT override variables already set.
 *
 * Keeps sensitive tokens (API keys, bot tokens) in the user's home
 * directory instead of in the project tree where they can be accidentally
 * committed, exposed in logs, or overwritten by self-improve.
 */
export function loadSecretsFile(): void {
  let secretsPath: string;
  try {
    secretsPath = join(homedir(), ".codingagent", "secrets.json");
  } catch {
    return; // HOME not set — skip
  }
  let content: string;
  try {
    content = readFileSync(secretsPath, "utf-8");
  } catch {
    return; // file doesn't exist — that's fine
  }
  try {
    const secrets = JSON.parse(content);
    if (secrets && typeof secrets === "object" && !Array.isArray(secrets)) {
      for (const [key, value] of Object.entries(secrets)) {
        if (typeof value === "string" && process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    }
  } catch {
    console.warn(`[env] Failed to parse ${secretsPath} — skipping.`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Consolidated loader
// ═══════════════════════════════════════════════════════════════════════════════

let _envLoaded = false;

/**
 * Load all environment sources into `process.env` in priority order.
 *
 * Load order (first wins — never overrides already-set vars):
 *   1. Actual environment variables (already in `process.env`)
 *   2. `.env.<transport>` files (`.env.gateway`, `.env.telegram`, `.env.teams`)
 *   3. `.env` (generic)
 *   4. `~/.claude/settings.json` `"env"` object
 *   5. `~/.codingagent/secrets.json`
 *
 * All `.env.*` files in the cwd are loaded — not just the "current" transport.
 * This is intentional: when the gateway spawns a worker, the worker should
 * see the same env vars the gateway loaded. Loading all transport-specific
 * files ensures vars from `.env.telegram` (API keys, model, base URL) are
 * available regardless of which entry point is running.
 *
 * Safe to call multiple times — only loads once.
 *
 * @param cwd - The working directory to resolve `.env*` files from.
 *              Defaults to `process.cwd()`.
 */
export function loadAllEnv(cwd?: string): void {
  if (_envLoaded) return;
  _envLoaded = true;

  const dir = cwd ?? process.cwd();

  // Transport-specific env files (order doesn't matter because
  // each uses "first wins" and they have disjoint keys in practice)
  loadEnvFile(resolve(dir, ".env.gateway"));
  loadEnvFile(resolve(dir, ".env.telegram"));
  loadEnvFile(resolve(dir, ".env.teams"));

  // Generic .env
  loadEnvFile(resolve(dir, ".env"));

  // User-level config sources
  loadSettingsEnv();
  loadSecretsFile();
}
