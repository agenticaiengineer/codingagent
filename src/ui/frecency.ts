/**
 * Frecency tracker — frequency × recency scoring for command usage.
 *
 * Stores command usage counts and last-used timestamps. Scores decay
 * exponentially so recently-used commands rank higher than commands
 * used heavily in the distant past.
 *
 * Data persists to ~/.codingagent/command-frecency.json. Loaded lazily
 * on first access, saved on process exit and periodically after updates.
 *
 * This module is intentionally dependency-free (no imports from ui.ts
 * or index.ts) to avoid circular dependencies.
 */

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir, tmpdir } from "os";

interface FrecencyEntry {
  count: number;
  lastUsed: number; // Date.now() timestamp
}

interface FrecencyData {
  version: 1;
  commands: Record<string, FrecencyEntry>;
}

let data: FrecencyData | null = null;
let dirty = false;

function getDataDir(): string {
  try {
    return join(homedir(), ".codingagent");
  } catch {
    return join(tmpdir(), ".codingagent");
  }
}

function getDataPath(): string {
  return join(getDataDir(), "command-frecency.json");
}

function loadFrecency(): FrecencyData {
  if (data) return data;
  try {
    const raw = readFileSync(getDataPath(), "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed && parsed.version === 1 && typeof parsed.commands === "object") {
      data = parsed as FrecencyData;
    } else {
      data = { version: 1, commands: {} };
    }
  } catch {
    data = { version: 1, commands: {} };
  }
  return data;
}

/**
 * Record a command invocation. Updates the usage count and last-used timestamp.
 * Schedules a debounced save to disk.
 */
export function recordCommandUse(command: string): void {
  const d = loadFrecency();
  const baseCmd = command.split(/\s+/)[0].toLowerCase();
  const entry = d.commands[baseCmd] ?? { count: 0, lastUsed: 0 };
  entry.count++;
  entry.lastUsed = Date.now();
  d.commands[baseCmd] = entry;
  dirty = true;
  scheduleSave();
}

/**
 * Compute frecency scores for all tracked commands.
 * Score = count × exp(-daysSinceLastUse / 7)  (half-life of ~7 days).
 *
 * Returns a Map keyed by lowercase command name (e.g., "/model").
 */
export function getFrecencyScores(): Map<string, number> {
  const d = loadFrecency();
  const now = Date.now();
  const result = new Map<string, number>();
  const DAY_MS = 86_400_000;

  for (const [cmd, entry] of Object.entries(d.commands)) {
    const daysSince = (now - entry.lastUsed) / DAY_MS;
    const recencyWeight = Math.exp(-daysSince / 7);
    const score = entry.count * recencyWeight;
    result.set(cmd, score);
  }
  return result;
}

/**
 * Save frecency data to disk. No-ops if nothing has changed.
 * Called on process exit and periodically via debounced timer.
 */
export function saveFrecency(): void {
  if (!dirty || !data) return;
  try {
    mkdirSync(getDataDir(), { recursive: true });
    writeFileSync(getDataPath(), JSON.stringify(data, null, 2), "utf-8");
    dirty = false;
  } catch {
    // Best-effort; don't crash on write failure
  }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleSave(): void {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveFrecency();
    saveTimer = null;
  }, 5000);
  saveTimer.unref(); // Don't keep the process alive for saving
}

// Save on process exit
process.on("exit", saveFrecency);
