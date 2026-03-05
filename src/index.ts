#!/usr/bin/env node
import { createInterface, type Interface as ReadlineInterface } from "readline";
import { execSync } from "child_process";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";
import { loadConfig, getConfig } from "./config/config.js";
import { createContext } from "./core/context.js";
import { getAllTools, registerMcpTools } from "./tools/index.js";
import { agenticLoop } from "./core/loop.js";
import { MAX_EVAL_ROUNDS } from "./eval/eval.js";
import { spawnAgent, listRunningAgents, abortAllAgents } from "./core/agent.js";
import { microCompact, autoCompact, estimateTokens, repairOrphanedToolUse } from "./core/compaction.js";
import { toggleDebug, isDebugEnabled, getDebugLogPath, enableDebug, setDebugSessionId } from "./core/debug.js";
import type { Message, ToolContext, AppConfig, Tool } from "./core/types.js";
import {
  bold,
  cyan,
  dim,
  green,
  yellow,
  red,
  magenta,
  Spinner,
  formatDuration,
  formatToolResult,
  formatToolUse,
  formatError,
  renderWelcomeBanner,
  renderStatusBar,
  renderHelp,
  printInfo,
  printSuccess,
  printWarning,
  commandCompleter,
  renderCommandSuggestions,
  InlineHintManager,
  setFrecencyScores,
  output,
} from "./ui/ui.js";
import { renderMarkdown, isMarkdownEnabled } from "./ui/markdown.js";
import { safeTruncate, hasErrnoCode } from "./tools/validate.js";
import {
  generateSessionId,
  saveSession,
  loadSession,
  listSessions,
  deleteSession,
  getLastSessionId,
  pruneSessions,
  formatSessionEntry,
  type SavedSession,
} from "./session/session.js";
import { registerCommand, findUnregisteredCommands, getRegisteredCommands, registerSkillCommands, clearSkillCommands, registerArgumentProvider } from "./ui/commands.js";
import {
  loadMcpServers,
  getMcpTools,
  getMcpServerStatus,
  getMcpInstructions,
  shutdownMcpServers,
} from "./core/mcp-client.js";
import {
  loadProjectMemory,
  loadSkills,
  getSkill,
  getInvocableSkills,
  getSkillDescriptions,
  substituteArguments,
  resetMemoryCache,
} from "./config/skills.js";
import { recordCommandUse, getFrecencyScores } from "./ui/frecency.js";

// ── Command Registration ──
// Register all REPL commands here, next to their implementations in handleCommand().
// This is the single source of truth — /help, tab-completion, inline hints, and
// CLI --help all derive from these registrations. Adding a new `case "/foo":` in
// handleCommand() without a corresponding registerCommand() call will be caught
// by the validation check at the bottom of this block.
registerCommand({ command: "/help",                description: "Show this help message" });
registerCommand({ command: "/clear",               description: "Clear conversation history" });
registerCommand({ command: "/compact [--force]",    description: "Compact context (--force to compact below threshold)" });
registerCommand({ command: "/tokens",              description: "Show estimated token count" });
registerCommand({ command: "/status",              description: "Show session info & statistics" });
registerCommand({ command: "/history",             description: "Show recent prompt history" });
registerCommand({ command: "/model <name>",        description: "Switch to a different model" });
registerCommand({ command: "/smallmodel <name>",   description: "Switch small model (compaction/exploration)" });
registerCommand({ command: "/undo",                description: "Stash uncommitted file changes" });
registerCommand({ command: "/retry",               description: "Re-send last prompt (removes last exchange)" });
registerCommand({ command: "/agents [id]",          description: "Show background agent status (or full result by ID)" });
registerCommand({ command: "/save",                description: "Save current session to disk" });
registerCommand({ command: "/sessions",            description: "List saved sessions" });
registerCommand({ command: "/resume [id|#]",        description: "Resume a saved session (by ID or number)" });
registerCommand({ command: "/delete-session <id>",  description: "Delete a saved session" });
registerCommand({ command: "/cache",               description: "Show explore cache statistics" });
registerCommand({ command: "/mcp",                 description: "Show MCP server status & tools" });
registerCommand({ command: "/memory",              description: "Show loaded project memory (CLAUDE.md)" });
registerCommand({ command: "/skills",              description: "List available skills (SKILL.md)" });
registerCommand({ command: "/reload",              description: "Hot restart (reload code + tools)" });
registerCommand({ command: "/debug",               description: "Toggle debug mode (log all LLM interactions)" });
registerCommand({ command: "/quit",                description: "Exit the REPL (also: /exit)", aliases: ["/exit"] });

// ── Command Registration Validation ──
// Verify at module load time that every command handled by the switch statement in
// handleCommand() has a corresponding registerCommand() call above. This catches
// the exact class of bug that prompted this refactor — a new command added to the
// switch but not to the help/hints system.
{
  const expectedCommands = [
    "/help", "/clear", "/compact", "/tokens", "/status", "/history",
    "/model", "/smallmodel", "/undo", "/retry", "/agents", "/save",
    "/sessions", "/resume", "/delete-session", "/cache",
    "/mcp", "/memory", "/skills",
    "/reload", "/debug", "/quit", "/exit",
  ];
  const missing = findUnregisteredCommands(expectedCommands);
  if (missing.length > 0) {
    // Use console.warn (not throw) so the REPL still starts — a missing help
    // entry is annoying but not fatal. The developer sees this immediately
    // during dev/test and adds the missing registerCommand() call.
    console.warn(
      `[commands] Warning: ${missing.length} command(s) not registered for help/hints: ${missing.join(", ")}. ` +
      `Add registerCommand() calls in index.ts.`
    );
  }
}

// ── Argument Provider Registration ──
// Register argument providers for commands that accept arguments.
// These provide contextual suggestions in the inline hint menu when
// the user types a command followed by a space.
registerArgumentProvider("/model", () => [
  { value: "claude-sonnet-4-20250514", description: "Sonnet (fast, balanced)" },
  { value: "claude-opus-4-20250514", description: "Opus (most capable)" },
  { value: "claude-haiku-3.5-20241022", description: "Haiku (fastest)" },
]);

registerArgumentProvider("/smallmodel", () => [
  { value: "claude-haiku-3.5-20241022", description: "Haiku (cheapest)" },
  { value: "claude-sonnet-4-20250514", description: "Sonnet (balanced)" },
]);

registerArgumentProvider("/resume", () => {
  try {
    const sessions = listSessions();
    return sessions.slice(0, 10).map((s, i) => ({
      value: String(i + 1),
      description: `${s.id.slice(0, 12)}.. (${s.turnCount} turns)`,
    }));
  } catch {
    return [];
  }
});

registerArgumentProvider("/delete-session", () => {
  try {
    const sessions = listSessions();
    return sessions.slice(0, 10).map((s) => ({
      value: s.id,
      description: `${s.turnCount} turns`,
    }));
  } catch {
    return [];
  }
});

registerArgumentProvider("/agents", () => {
  const agents = listRunningAgents();
  return agents.map((a) => ({
    value: a.id,
    description: a.done ? "completed" : "running",
  }));
});

registerArgumentProvider("/compact", () => [
  { value: "--force", description: "Compact even below threshold" },
]);

// ── Project root (for /reload type-checking) ──
// Resolve the project root directory from this file's location (src/index.ts → ../)
// so /reload runs `tsc` against the codingagent project's tsconfig.json, not the
// user's working directory which may have no tsconfig or a different project entirely.
const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(dirname(__filename), "..");

// ── System prompt ──

/**
 * Cache the session start date so the system prompt is stable across turns.
 *
 * Previously `new Date().toISOString()` was called on every turn, producing
 * a different system prompt string each time (down to the millisecond). This
 * broke Anthropic's prompt caching: the system prompt is the first content
 * sent in every API call, and prompt caching requires an exact prefix match.
 * A single-character change in the timestamp invalidates the cache, causing
 * every turn to re-process the full system prompt (~200 tokens) instead of
 * hitting the cache — adding unnecessary latency and cost on every API call.
 *
 * Using a session-stable date (truncated to the minute) keeps the system
 * prompt identical across all turns within the same session, enabling
 * prompt caching. The date is truncated to the minute (not second/ms)
 * because sub-second precision in the system prompt provides no useful
 * information to the model and would still break caching if a non-interactive
 * invocation regenerates the prompt within the same second.
 */
let sessionStartDate: string | null = null;

/**
 * Sync skill definitions into the command registry so they appear in
 * tab-completion, inline hints, /help, and fuzzy suggestions.
 * Called at startup and after /reload or /clear.
 */
function syncSkillCommands(cwd: string): void {
  const skills = getInvocableSkills(cwd);
  registerSkillCommands(
    skills.map((s) => ({
      command: `/${s.name}`,
      description: s.description,
    }))
  );
}

function getSessionDate(): string {
  if (!sessionStartDate) {
    // Truncate to the minute to maximize cache hits and avoid revealing
    // sub-minute timing information that serves no purpose to the model.
    const now = new Date();
    now.setSeconds(0, 0);
    sessionStartDate = now.toISOString();
  }
  return sessionStartDate;
}

function getSystemPrompt(cwd: string): string {
  // ── Base system prompt ──
  let prompt = `You are a coding assistant with access to tools for reading, writing, and editing files, searching codebases, and executing commands.

You have access to the following tools:
- Read: Read files from the filesystem
- Write: Write files to the filesystem
- Edit: Edit files with exact string replacements
- Glob: Find files matching glob patterns
- Grep: Search file contents with ripgrep (regex supported)
- Bash: Execute ${process.platform === "win32" ? "commands (via cmd.exe on Windows)" : "bash commands"}
- Task: Spawn sub-agents for complex tasks
- WebFetch: Fetch content from URLs
- WebSearch: Search the web using DuckDuckGo

Important rules:
- Always read a file before editing or overwriting it
- Use Glob and Grep to explore the codebase before making changes
- Be concise in your responses
- All tool calls are auto-approved — no permission prompts

Current working directory: ${cwd}
Platform: ${process.platform}
Date: ${getSessionDate()}
`;

  // ── MCP server tools ──
  // Append descriptions of MCP tools so the model knows they exist and
  // how to use them. MCP tools are prefixed with `mcp__<server>__<tool>`.
  const mcpTools = getMcpTools();
  if (mcpTools.length > 0) {
    const mcpToolLines = mcpTools.map(t => `- ${t.name}: ${t.description.split("\n")[0]}`);
    prompt += `\nMCP (Model Context Protocol) tools from connected servers:\n${mcpToolLines.join("\n")}\n`;
  }

  // ── MCP server instructions ──
  // Some MCP servers provide instructions for how the AI should behave
  // when using their tools. Include these after the tool list.
  const mcpInstr = getMcpInstructions();
  if (mcpInstr) {
    prompt += `\n${mcpInstr}\n`;
  }

  // ── Project memory (CLAUDE.md) ──
  // Hierarchical project memory from CLAUDE.md files. More specific
  // entries (local > project > user) appear later, giving them implicit
  // precedence for the model.
  const memory = loadProjectMemory(cwd);
  if (memory) {
    prompt += memory;
  }

  // ── Skills ──
  // List available skills so the model can auto-invoke them when relevant.
  const skillDescs = getSkillDescriptions(cwd);
  if (skillDescs) {
    prompt += skillDescs;
  }

  return prompt;
}

// ── Cost estimation ──

/**
 * Estimate API cost in USD based on token usage and model name.
 *
 * Uses approximate published pricing for Claude models (as of mid-2025):
 * - Haiku:  $0.25/$1.25 per MTok (input/output)
 * - Sonnet: $3/$15 per MTok
 * - Opus:   $15/$75 per MTok
 *
 * This is intentionally approximate — actual costs depend on prompt caching,
 * batching discounts, committed-use pricing, and rate tier. The estimate
 * gives users a rough ballpark so they can track spend without leaving the
 * REPL or checking the Anthropic dashboard after every session.
 *
 * Unknown model names (custom proxies, future models) fall back to Sonnet
 * pricing as a reasonable middle ground.
 */
function estimateApiCost(
  inputTokens: number,
  outputTokens: number,
  model: string
): number {
  // Pricing in dollars per million tokens [input, output]
  // Source: https://docs.anthropic.com/en/docs/about-claude/models
  let inputRate: number;
  let outputRate: number;

  const lowerModel = model.toLowerCase();
  if (lowerModel.includes("opus")) {
    inputRate = 15;
    outputRate = 75;
  } else if (lowerModel.includes("haiku")) {
    // Distinguish Haiku 3.5 ($0.80/$4.00) from Haiku 3 ($0.25/$1.25).
    // The default small model is claude-haiku-3-5-20241022; using Haiku 3
    // rates for all Haiku models would underestimate costs by ~3× for
    // Haiku 3.5 users. Match "3-5" or "3.5" in the model name (the API
    // uses hyphens, but users might type dots). If neither matches, fall
    // back to Haiku 3 pricing (the cheaper rate — better to underestimate
    // for older models than overestimate).
    if (lowerModel.includes("3-5") || lowerModel.includes("3.5")) {
      inputRate = 0.8;
      outputRate = 4;
    } else {
      inputRate = 0.25;
      outputRate = 1.25;
    }
  } else {
    // Default: Sonnet pricing (also covers unknown models)
    inputRate = 3;
    outputRate = 15;
  }

  return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
}

// ── Session state ──

/**
 * Per-model token breakdown for accurate cost estimation across model switches.
 * When the user changes models via `/model` mid-session, tokens consumed under
 * the old model should still be priced at the old model's rates. Without this,
 * `estimateApiCost(totalInput, totalOutput, currentModel)` prices *all* prior
 * tokens at the current model's rates — e.g., switching from Haiku to Opus
 * would retroactively price cheap Haiku tokens at Opus rates (60× overestimate
 * for input tokens), or worse, switching from Opus to Haiku would make the
 * session appear 60× cheaper than it actually was.
 */
interface PerModelTokens {
  inputTokens: number;
  outputTokens: number;
}

interface SessionState {
  startTime: number;
  turnCount: number;
  totalApiDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  /** Per-model token breakdown. Key is the model name at the time the API call
   *  was made (not the current model). Used by `/status` for accurate cost
   *  estimation across model switches. */
  tokensByModel: Map<string, PerModelTokens>;
  history: { timestamp: number; text: string }[];
}

function createSessionState(): SessionState {
  return {
    startTime: Date.now(),
    turnCount: 0,
    totalApiDurationMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    tokensByModel: new Map(),
    history: [],
  };
}

/**
 * Compute the cumulative estimated cost in USD for a session.
 *
 * Uses per-model token breakdowns when available (accurate across model
 * switches via `/model`). Falls back to pricing all tokens at the given
 * `fallbackModel`'s rate for older restored sessions where `tokensByModel`
 * is empty.
 */
function computeSessionCost(session: SessionState, fallbackModel: string): number {
  if (session.tokensByModel.size > 0) {
    let cost = 0;
    for (const [modelName, modelTokens] of session.tokensByModel) {
      cost += estimateApiCost(modelTokens.inputTokens, modelTokens.outputTokens, modelName);
    }
    return cost;
  }
  return estimateApiCost(
    session.totalInputTokens,
    session.totalOutputTokens,
    fallbackModel
  );
}

// ── Auto-save ──

const AUTO_SAVE_INTERVAL_MS = 60_000; // Auto-save every 60 seconds
const AUTO_SAVE_AFTER_TURNS = 1; // Auto-save after every turn

/**
 * Maximum number of history entries (user prompts) to retain. The history
 * is used by `/history` (shows recent 20) and `/retry` (needs the last
 * entry). Without a cap, the array grows unboundedly over long sessions
 * and is serialized to disk on every auto-save, bloating session files.
 * 1000 entries is generous for any practical session.
 */
const MAX_HISTORY_ENTRIES = 1000;

// ── Command handling ──

interface CommandResult {
  handled: boolean;
  shouldContinue: boolean;
  /** If set, the REPL should immediately submit this text as a user prompt
   *  (used by /retry to re-run the last user message without requiring re-entry). */
  retryPrompt?: string;
}

interface ReplState {
  messages: Message[];
  context: ToolContext;
  session: SessionState;
  config: AppConfig;
  tools: readonly Tool[];
  sessionId: string;
  lastSaveTurn: number;
  lastSaveTime: number;
  /** Readline interface, needed by /reload to close stdin before spawning
   *  the child process. Without closing, both parent and child compete for
   *  stdin input via `stdio: "inherit"`, causing lost/duplicated keystrokes. */
  rl?: ReadlineInterface;
  /** Message count at which auto-compaction was suppressed (savings < 10%).
   *  When set, auto-compaction is skipped until the message count grows by
   *  at least MIN_NEW_MESSAGES_AFTER_SUPPRESS (4). This prevents the
   *  compaction loop where every turn triggers a useless summarization API
   *  call that achieves < 10% savings. Reset by /clear, /resume, and
   *  successful /compact. */
  autoCompactSuppressedAt: number | null;
}

async function handleCommand(
  input: string,
  state: ReplState
): Promise<CommandResult> {
  const { messages, context, session, config } = state;
  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case "/quit":
    case "/exit": {
      // Save session on exit
      autoSaveSession(state);
      const elapsed = formatDuration(Date.now() - session.startTime);
      console.log(
        `\n${dim("Session duration:")} ${elapsed} ${dim("|")} ${session.turnCount} turn${session.turnCount !== 1 ? "s" : ""}`
      );
      console.log(dim(`Session saved: ${state.sessionId}`));
      printResumeHint(state.sessionId);
      console.log(dim("Goodbye.\n"));
      process.exit(0);
    }

    case "/clear": {
      // Auto-save the current session before clearing so the user can
      // recover via `/resume` if the clear was accidental. Without this,
      // `/clear` permanently destroys all conversation context with no
      // way to recover — a single mistyped command loses an entire session.
      const prevSessionId = state.sessionId;
      if (messages.length > 0) {
        autoSaveSession(state);
      }
      messages.length = 0;
      session.history.length = 0;
      session.turnCount = 0;
      session.totalApiDurationMs = 0;
      session.totalInputTokens = 0;
      session.totalOutputTokens = 0;
      session.tokensByModel.clear();
      session.startTime = Date.now();
      // Reset auto-save tracking so the new session's first turn is saved
      // immediately. Without this, `lastSaveTurn` retains the old session's
      // turn count (e.g., 15) and `shouldAutoSave` compares `0 - 15 >= 1`
      // which is false — deferring the first save to the 60-second time-based
      // fallback, risking data loss if the process crashes before then.
      state.lastSaveTurn = 0;
      state.lastSaveTime = Date.now();
      // Reset the read-file-state cache so the agent must re-read files
      // before editing them in the new conversation. Without this, stale
      // entries from the prior session persist, allowing the agent to edit
      // files it hasn't re-read — which may have changed on disk since the
      // prior session's read, leading to edits based on outdated content.
      context.readFileState.clear();
      context.exploreCache?.clear();
      // Reset project memory and skills cache so they are re-read from
      // disk on the next system prompt build. This ensures changes to
      // CLAUDE.md or SKILL.md files take effect after /clear.
      resetMemoryCache();
      // Re-sync skill commands so newly added/removed skills are reflected
      // in tab-completion and inline hints immediately after /clear.
      syncSkillCommands(context.cwd);
      // Reset the session date so the system prompt reflects the current
      // time for the new conversation. Without this, `sessionStartDate`
      // retains the time from the original session start — for sessions
      // spanning midnight or running for hours, the model sees a stale
      // date/time in the system prompt (e.g., "Current date: 2025-01-14
      // 23:50" when it's actually 2025-01-15 01:30). The date is lazily
      // re-computed on the next `getSystemPrompt()` call.
      sessionStartDate = null;
      // Reset auto-compaction loop suppression so the new session starts fresh.
      state.autoCompactSuppressedAt = null;
      // Start a new session ID
      state.sessionId = generateSessionId();
      // Rebind debug logging to the new session folder so subsequent
      // debug files land in the correct session's debug directory.
      setDebugSessionId(state.sessionId);
      printSuccess("Conversation cleared", `new session: ${state.sessionId}`);
      if (prevSessionId !== state.sessionId) {
        printInfo(`Previous session saved as ${cyan(prevSessionId)} — use ${cyan(`/resume ${prevSessionId}`)} to recover.`);
      }
      return { handled: true, shouldContinue: true };
    }

    case "/compact": {
      const forceCompact = parts.includes("--force") || parts.includes("-f");
      const before = messages.length;
      // Include system prompt length so the before/after token counts shown to
      // the user match what the API actually sees — consistent with /status,
      // /tokens, and the auto-compaction logic. Without this, the "X → Y tokens"
      // display underreports by ~100–500 tokens, and the "already compact" info
      // message shows a lower count than /status for the same conversation.
      const systemPromptForCompact = getSystemPrompt(context.cwd);
      const tokensBefore = estimateTokens(messages, systemPromptForCompact.length);
      // Show a spinner during the compaction API call so the user knows
      // something is happening — compaction calls the summarization model,
      // which can take several seconds of silence without visual feedback.
      const compactSpinner = new Spinner("Compacting…");
      compactSpinner.start();
      let compacted: Message[];
      const compactStart = performance.now();
      try {
        compacted = await autoCompact(messages, systemPromptForCompact, context.abortController.signal, forceCompact);
      } finally {
        compactSpinner.stop();
      }
      const compactDurationMs = performance.now() - compactStart;
      // autoCompact returns the same array reference when tokens are below
      // the compaction threshold (and not forced) or when there are too few
      // messages. Detect this case and inform the user instead of showing a
      // misleading "Compacted" success message with identical before/after numbers.
      if (compacted === messages) {
        if (messages.length <= 4) {
          printInfo(
            `Too few messages to compact (${messages.length}). Continue the conversation first.`
          );
        } else {
          printInfo(
            `Context is already compact (~${tokensBefore.toLocaleString()} tokens, threshold: ${config.compactionThreshold.toLocaleString()}). Use ${cyan("/compact --force")} to compact anyway.`
          );
        }
      } else {
        messages.length = 0;
        messages.push(...compacted);
        // Repair orphaned tool_use blocks that may result from compaction
        // truncating the conversation at a point where an assistant tool_use
        // message exists but its matching user tool_result was summarized away.
        // Without this, the next API call fails with a validation error.
        // Same fix applied to auto-compaction below and in runOnce.
        repairOrphanedToolUse(messages);
        const tokensAfter = estimateTokens(messages, systemPromptForCompact.length);
        printSuccess(
          "Compacted",
          `${before} → ${messages.length} messages, ~${tokensBefore.toLocaleString()} → ~${tokensAfter.toLocaleString()} tokens (${formatDuration(compactDurationMs)})`
        );
        // Clear auto-compaction loop suppression — the /compact command
        // performed a (potentially force-) compaction, so the conversation
        // state has changed and future auto-compaction should be retried.
        state.autoCompactSuppressedAt = null;
      }
      return { handled: true, shouldContinue: true };
    }

    case "/tokens": {
      // Include system prompt length for consistency with /status and auto-
      // compaction — the system prompt contributes ~100–500 tokens that are
      // sent with every API call but are not part of the messages array.
      // Without this, /tokens shows a lower count than /status (which now
      // includes the system prompt), and both disagree with the auto-
      // compaction threshold check. The status bar rendered by /tokens should
      // reflect the same token count the user sees in /status.
      const systemPromptForTokens = getSystemPrompt(context.cwd);
      const tokens = estimateTokens(messages, systemPromptForTokens.length);
      console.log(
        renderStatusBar(tokens, messages.length, config.model, Date.now() - session.startTime, {
          inputTokens: session.totalInputTokens,
          outputTokens: session.totalOutputTokens,
        }, config.compactionThreshold, computeSessionCost(session, config.model))
      );
      return { handled: true, shouldContinue: true };
    }

    case "/help": {
      console.log(renderHelp());
      return { handled: true, shouldContinue: true };
    }

    case "/history": {
      if (session.history.length === 0) {
        printInfo("No history yet.");
      } else {
        const recent = session.history.slice(-20);
        console.log(`\n${bold("Recent prompts")} ${dim(`(${session.history.length} total)`)}\n`);
        for (const entry of recent) {
          const time = new Date(entry.timestamp).toLocaleTimeString();
          const preview =
            entry.text.length > 80
              ? safeTruncate(entry.text, 77) + "…"
              : entry.text;
          console.log(`  ${dim(time)}  ${preview}`);
        }
        console.log();
      }
      return { handled: true, shouldContinue: true };
    }

    case "/undo": {
      try {
        // Use `git diff --stat HEAD` to detect both staged and unstaged changes.
        // Plain `git diff --stat` only shows unstaged changes, so staged files
        // would be silently stashed without being shown to the user.
        // Fall back to `git diff --stat` when there are no commits yet (HEAD
        // is invalid in a fresh repo).
        // Also list untracked files — the agent frequently creates new files,
        // and `git diff` doesn't show those, so without this, `/undo` would
        // stash them (via --include-untracked) without previewing them.
        // All git commands in /undo use a 15-second timeout to prevent the
        // REPL from hanging indefinitely if git is stuck (e.g., corrupted
        // .git directory, NFS mount stall, or an unexpected interactive prompt).
        const gitOpts = { encoding: "utf-8" as const, cwd: context.cwd, timeout: 15_000 };
        let diff: string;
        try {
          diff = execSync("git diff --stat HEAD", gitOpts).trim();
        } catch {
          // HEAD may not exist yet in a fresh repo with no commits
          diff = execSync("git diff --stat", gitOpts).trim();
        }

        // Append untracked files to the diff preview so the user sees
        // new files that will also be stashed by --include-untracked.
        const untracked = execSync("git ls-files --others --exclude-standard", gitOpts).trim();
        if (untracked) {
          const untrackedLines = untracked.split("\n").map(f => ` ${f} (new file)`).join("\n");
          diff = diff ? `${diff}\n${untrackedLines}` : untrackedLines;
        }

        if (!diff) {
          printInfo("No uncommitted changes to undo.");
        } else {
          // Count affected files so the success message gives a clear summary.
          // `git diff --stat` lines end with ` | N +/-`, and untracked lines
          // end with ` (new file)`. Count all non-empty lines except the
          // summary line from --stat (which shows "N files changed, ...").
          const diffLines = diff.split("\n").filter(l => l.trim());
          const statSummaryRe = /^\s*\d+\s+files?\s+changed/;
          const fileCount = diffLines.filter(l => !statSummaryRe.test(l)).length;

          console.log(`\n${yellow("Changes to revert:")}`);
          // Truncate the diff preview for large changesets to avoid flooding
          // the terminal. 40 lines is generous enough to show most realistic
          // diffs in full while preventing a screen-filling wall of text when
          // the agent touched dozens of files.
          const MAX_UNDO_PREVIEW_LINES = 40;
          const allDiffLines = diff.split("\n");
          if (allDiffLines.length > MAX_UNDO_PREVIEW_LINES) {
            const shown = allDiffLines.slice(0, MAX_UNDO_PREVIEW_LINES).join("\n");
            const omitted = allDiffLines.length - MAX_UNDO_PREVIEW_LINES;
            console.log(dim(shown));
            console.log(dim(`  … ${omitted} more line${omitted !== 1 ? "s" : ""}`));
          } else {
            console.log(dim(diff));
          }
          // Stash timeout is longer (30s) because git stash with large
          // untracked files or binary blobs can take noticeably longer
          // than a lightweight diff --stat.
          execSync("git stash push --include-untracked -m codingagent-undo", {
            ...gitOpts,
            timeout: 30_000,
          });
          // Retrieve the stash ref (e.g., "stash@{0}") so the recovery message
          // is precise. Without this, users with multiple stashes won't know
          // which entry to pop — `git stash pop` pops the latest, which may not
          // be the codingagent-undo entry if another stash was created since.
          // Best-effort: fall back to generic advice if the ref can't be read.
          let stashRef = "stash@{0}";
          try {
            const stashList = execSync("git stash list -1", { ...gitOpts, timeout: 5_000 }).trim();
            const match = stashList.match(/^(stash@\{\d+\})/);
            if (match) stashRef = match[1];
          } catch { /* best-effort — use default stash@{0} */ }
          const fileCountStr = fileCount > 0
            ? `${fileCount} file${fileCount !== 1 ? "s" : ""} stashed`
            : "Changes stashed";
          printSuccess(
            fileCountStr,
            `(use 'git stash pop ${stashRef}' to recover)`
          );
          // After stashing, the working tree has changed — invalidate the
          // explore cache so subsequent reads/searches reflect the reverted state.
          context.exploreCache?.clear();
        }
      } catch (err: unknown) {
        // Differentiate error causes so the user gets actionable guidance
        // instead of the previous catch-all "not a git repository" message
        // which was misleading when the actual cause was a timeout, permission
        // error, or git stash failure.
        if (err != null && typeof err === "object") {
          const errObj = err as Record<string, unknown>;
          // execSync timeout: Node sets `killed: true` and `signal: "SIGTERM"` on the error
          if (errObj.killed === true || errObj.signal === "SIGTERM") {
            printWarning(
              "Git command timed out. The repository may be very large, on a slow filesystem, or git may be stuck. " +
              "Try running 'git stash push --include-untracked -m codingagent-undo' manually."
            );
          } else if (hasErrnoCode(err) && (err as { code: string }).code === "ENOENT") {
            printWarning(
              "Could not undo — git is not installed or not in PATH."
            );
          } else {
            // Include the actual error message for other failures (e.g., git stash
            // conflicts, permission errors, "not a git repository"). The original
            // catch-all hid the real error, making debugging impossible.
            const msg = err instanceof Error ? err.message : String(err);
            // execSync errors include stderr in the `stderr` property
            const stderr = typeof errObj.stderr === "string" ? errObj.stderr.trim() : "";
            const detail = stderr
              ? stderr.split("\n")[0] // Show first line of stderr (most informative)
              : (msg.length > 200 ? safeTruncate(msg, 200) + "…" : msg);
            printWarning(`Could not undo: ${detail}`);
          }
        } else {
          printWarning(
            "Could not undo — not a git repository or git not available."
          );
        }
      }
      return { handled: true, shouldContinue: true };
    }

    case "/status": {
      const elapsed = Date.now() - session.startTime;
      // Include the system prompt length for accuracy — the system prompt is
      // sent with every API call but isn't part of the messages array. Without
      // it, the token estimate shown here is systematically lower than what the
      // API actually sees (by ~100–500 tokens depending on CWD path length and
      // platform). This also makes the compaction percentage below accurate:
      // without systemprompt tokens, `/status` could show "95% used" when the
      // real ratio is "98% used" — misleading the user into thinking they have
      // more room than they actually do before auto-compaction triggers.
      // Matches the `estimateTokens(messages, systemPromptText.length)` calls
      // used by auto-compaction (line ~1936, ~1982).
      const systemPromptForStatus = getSystemPrompt(context.cwd);
      const tokens = estimateTokens(messages, systemPromptForStatus.length);

      console.log(`\n${bold("Session Status")}\n`);
      console.log(`  ${dim("Session ID:")}    ${cyan(state.sessionId)}`);
      console.log(`  ${dim("Duration:")}      ${formatDuration(elapsed)}`);
      console.log(`  ${dim("Turns:")}         ${session.turnCount}`);
      console.log(`  ${dim("Messages:")}      ${messages.length}`);
      console.log(`  ${dim("Est. tokens:")}   ~${tokens.toLocaleString()}`);
      console.log(`  ${dim("Model:")}         ${config.model}`);
      console.log(`  ${dim("Small model:")}   ${config.smallModel}`);
      const compactionPct = Math.round((tokens / config.compactionThreshold) * 100);
      const compactionLabel = compactionPct > 100
        ? `${yellow(`${compactionPct}%`)} ${yellow("⚠ above threshold — auto-compaction pending")}`
        : `${compactionPct}% used`;
      console.log(`  ${dim("Compaction:")}    threshold ${config.compactionThreshold.toLocaleString()} tokens (${compactionLabel})`);
      console.log(`  ${dim("Max output:")}    ${config.maxOutputTokens.toLocaleString()} tokens`);
      console.log(`  ${dim("CWD:")}           ${context.cwd}`);

      // Show debug mode status
      if (isDebugEnabled()) {
        const debugPath = getDebugLogPath();
        console.log(`  ${dim("Debug:")}         ${green("ON")} → ${debugPath}`);
      }

      // Show background agent status if any are tracked — helps debug
      // sub-agent issues and track resource usage without needing /agents.
      const bgAgents = listRunningAgents();
      if (bgAgents.length > 0) {
        const running = bgAgents.filter((a) => !a.done).length;
        const done = bgAgents.length - running;
        const parts: string[] = [];
        if (running > 0) parts.push(`${running} running`);
        if (done > 0) parts.push(`${done} completed`);
        console.log(`  ${dim("Bg agents:")}     ${parts.join(", ")}`);
      }

      if (session.totalInputTokens > 0) {
        console.log(
          `  ${dim("API tokens:")}    ${session.totalInputTokens.toLocaleString()} in / ${session.totalOutputTokens.toLocaleString()} out`
        );
        const cost = computeSessionCost(session, config.model);
        if (cost >= 0.001) {
          const costStr = cost < 0.01 ? cost.toFixed(4) : cost < 1 ? cost.toFixed(3) : cost.toFixed(2);
          const dollarStr = "~$" + costStr;
          console.log(
            `  ${dim("Est. cost:")}     ${dollarStr} ${dim("(approximate)")}`
          );
        }
        console.log(
          `  ${dim("API time:")}      ${formatDuration(session.totalApiDurationMs)}`
        );
        // Show average API response time per turn so the user can gauge latency.
        // Total API time alone doesn't reveal whether individual calls are slow
        // (e.g., 30s total across 3 turns = 10s/turn → possible latency issue)
        // or fast (30s across 30 turns = 1s/turn → normal). This helps diagnose
        // slow proxies, rate-limiting, or model-specific latency differences
        // without the user needing to mentally divide total time by turn count.
        if (session.turnCount > 0) {
          const avgMs = session.totalApiDurationMs / session.turnCount;
          console.log(
            `  ${dim("Avg API/turn:")}  ${formatDuration(avgMs)}`
          );
        }
      }

      console.log();
      return { handled: true, shouldContinue: true };
    }

    case "/cache": {
      const cache = context.exploreCache;
      if (!cache) {
        printInfo("Explore cache is not enabled.");
      } else {
        const stats = cache.getStats();
        console.log(`\n${bold("Explore Cache")}`);
        console.log(`  ${dim("Entries:")}      ${stats.size}`);
        console.log(`  ${dim("Hits:")}         ${stats.hits}`);
        console.log(`  ${dim("Misses:")}       ${stats.misses}`);
        console.log(`  ${dim("Invalidations:")} ${stats.invalidations}`);
        console.log(`  ${dim("Evictions:")}    ${stats.evictions}`);
        const total = stats.hits + stats.misses;
        if (total > 0) {
          const hitRate = ((stats.hits / total) * 100).toFixed(1);
          console.log(`  ${dim("Hit rate:")}     ${hitRate}%`);
        }
        console.log();
      }
      return { handled: true, shouldContinue: true };
    }

    case "/model": {
      const newModel = input.slice(6).trim();
      if (!newModel) {
        printInfo(`Current model: ${config.model}`);
      } else {
        // Basic validation: model names should look plausible.
        // Reject strings with whitespace (likely copy-paste errors),
        // strings that are too short (accidental single chars), and
        // strings that are unreasonably long.
        if (newModel.length < 3) {
          printWarning(`Model name "${newModel}" is too short. Expected a model identifier like "claude-sonnet-4-20250514".`);
        } else if (newModel.length > 128) {
          printWarning(`Model name is too long (${newModel.length} chars). Maximum is 128.`);
        } else if (/\s/.test(newModel)) {
          printWarning(`Model name contains whitespace. Did you mean "${newModel.replace(/\s+/g, "-")}"?`);
        // Reject model names containing control characters (tabs, newlines,
        // escape sequences, null bytes, etc.). These cause confusing HTTP
        // errors when the SDK serializes the model name into the API request
        // body — a newline or null byte can corrupt the JSON payload, producing
        // a cryptic 400 "invalid JSON" error with no indication that the model
        // name itself is the problem. The same validation is already performed
        // at startup by loadConfig() (config.ts), but /model bypasses
        // loadConfig() and directly mutates config.model — so model names set
        // via /model were never checked for control characters. Common source:
        // copy-pasting from terminals or editors that embed invisible control
        // characters in the selection.
        // eslint-disable-next-line no-control-regex
        } else if (/[\x00-\x1f\x7f]/.test(newModel)) {
          printWarning(
            `Model name contains control characters (tabs, newlines, escape sequences, etc.). ` +
            `The API will reject this. Check for hidden characters in the name.`
          );
        } else {
          const oldModel = config.model;
          config.model = newModel;
          // Show old→new so the user can verify the switch and see what they
          // switched from (useful for reverting if the new model doesn't work).
          printSuccess("Model switched", `${oldModel} → ${newModel}`);
          // Soft warning for non-Anthropic model names. The Anthropic API
          // only accepts claude-* models; a typo like "claude-sonnet-4-20250514x"
          // or a non-Anthropic name like "gpt-4" would be accepted here but
          // fail on the next API call with a confusing 400/404 error. The
          // warning is non-blocking (the switch still happens) because the
          // user may be using a proxy/gateway that maps custom model names.
          if (!/^claude-/i.test(newModel)) {
            printWarning(
              `"${newModel}" doesn't look like an Anthropic model name (expected "claude-..."). ` +
              `The next API call may fail if this isn't a valid model. Use /model to change it.`
            );
          }
        }
      }
      return { handled: true, shouldContinue: true };
    }

    case "/smallmodel": {
      const newModel = input.slice(11).trim();
      if (!newModel) {
        printInfo(`Current small model: ${config.smallModel}`);
      } else {
        if (newModel.length < 3) {
          printWarning(`Model name "${newModel}" is too short. Expected a model identifier like "claude-haiku-4-20250514".`);
        } else if (newModel.length > 128) {
          printWarning(`Model name is too long (${newModel.length} chars). Maximum is 128.`);
        } else if (/\s/.test(newModel)) {
          printWarning(`Model name contains whitespace. Did you mean "${newModel.replace(/\s+/g, "-")}"?`);
        // Same control character validation as /model — see comment above.
        // eslint-disable-next-line no-control-regex
        } else if (/[\x00-\x1f\x7f]/.test(newModel)) {
          printWarning(
            `Model name contains control characters (tabs, newlines, escape sequences, etc.). ` +
            `The API will reject this. Check for hidden characters in the name.`
          );
        } else {
          const oldModel = config.smallModel;
          config.smallModel = newModel;
          printSuccess("Small model switched", `${oldModel} → ${newModel}`);
          if (!/^claude-/i.test(newModel)) {
            printWarning(
              `"${newModel}" doesn't look like an Anthropic model name (expected "claude-..."). ` +
              `The next compaction or Explore agent call may fail if this isn't a valid model. Use /smallmodel to change it.`
            );
          }
        }
      }
      return { handled: true, shouldContinue: true };
    }

    // ── Session management commands ──

    case "/save": {
      const saved = autoSaveSession(state);
      if (saved) {
        printSuccess("Session saved", state.sessionId);
      } else if (state.messages.length === 0) {
        printWarning("Nothing to save — no messages in current session.");
      } else {
        printWarning("Session save failed — check the warning above for details.");
      }
      return { handled: true, shouldContinue: true };
    }

    case "/sessions": {
      const sessions = listSessions();
      if (sessions.length === 0) {
        printInfo("No saved sessions.");
      } else {
        console.log(`\n${bold("Saved Sessions")} ${dim(`(${sessions.length} total)`)}\n`);
        const display = sessions.slice(0, 15);
        for (let i = 0; i < display.length; i++) {
          const isCurrent = display[i].id === state.sessionId;
          const marker = isCurrent ? ` ${green("← current")}` : "";
          console.log(formatSessionEntry(display[i], i) + marker);
        }
        if (sessions.length > 15) {
          console.log(`\n  ${dim(`… and ${sessions.length - 15} more`)}`);
        }
        console.log(`\n  ${dim("Use")} ${cyan("/resume <id>")} ${dim("or")} ${cyan("/resume <#>")} ${dim("to load a session (e.g.")} ${cyan("/resume 1")}${dim(")")}`);
        console.log(`  ${dim("Use")} ${cyan("/resume")} ${dim("to load the most recent session")}`);
        console.log();
      }
      return { handled: true, shouldContinue: true };
    }

    case "/resume": {
      const targetId = parts[1]?.trim();
      let sessionToLoad: SavedSession | null = null;
      let resolvedId: string | null = null;

      if (targetId) {
        // Support numeric index: `/resume 1` loads the first session from
        // `/sessions` (most recent), `/resume 2` the second, etc. This saves
        // users from copy-pasting long session IDs like "20250514123456-a1b2".
        // Only treat as numeric if the entire string is a small positive integer
        // (to avoid matching hex-heavy session IDs like "1234" as numbers).
        const numericIdx = /^\d+$/.test(targetId) ? parseInt(targetId, 10) : NaN;
        if (!Number.isNaN(numericIdx) && numericIdx >= 1) {
          const allSessions = listSessions();
          if (numericIdx > allSessions.length) {
            printWarning(`Session #${numericIdx} does not exist. There ${allSessions.length === 1 ? "is" : "are"} ${allSessions.length} saved session${allSessions.length !== 1 ? "s" : ""}.`);
            printInfo("Use /sessions to see available sessions.");
            return { handled: true, shouldContinue: true };
          }
          resolvedId = allSessions[numericIdx - 1].id;
          sessionToLoad = loadSession(resolvedId);
        } else {
          // Try exact match first
          sessionToLoad = loadSession(targetId);
          resolvedId = targetId;

          // Try partial match if exact fails
          if (!sessionToLoad) {
            const allSessions = listSessions();
            const matches = allSessions.filter((s) => s.id.includes(targetId));
            if (matches.length === 1) {
              resolvedId = matches[0].id;
              sessionToLoad = loadSession(resolvedId);
            } else if (matches.length > 1) {
              printWarning(`Multiple sessions match "${targetId}":`);
              for (let i = 0; i < Math.min(matches.length, 5); i++) {
                console.log(formatSessionEntry(matches[i], i));
              }
              return { handled: true, shouldContinue: true };
            }
          }
        }
      } else {
        // Load most recent session
        resolvedId = getLastSessionId();
        if (resolvedId) {
          sessionToLoad = loadSession(resolvedId);
        }
      }

      if (!sessionToLoad || !resolvedId) {
        printWarning(targetId ? `Session "${targetId}" not found.` : "No saved sessions to resume.");
        printInfo("Use /sessions to see available sessions.");
        return { handled: true, shouldContinue: true };
      }

      // Restore the session
      messages.length = 0;
      messages.push(...sessionToLoad.messages);

      // Reset the read-file-state cache so the agent must re-read files
      // before editing them in this restored session. The prior session's
      // readFileState entries contain stale mtimes from files that may have
      // been modified on disk since the session was saved — allowing edits
      // based on outdated content without a fresh read.
      context.readFileState.clear();
      // Restore the explore cache from the saved session. Read entries are
      // mtime-validated during restore — stale entries (where the file was
      // modified since the session was saved) are automatically discarded.
      // This avoids re-reading unchanged files on resume, saving I/O and
      // tool execution time for large codebases.
      context.exploreCache?.clear();
      if (sessionToLoad.exploreCache && context.exploreCache) {
        context.exploreCache.restore(sessionToLoad.exploreCache);
      }

      // Repair any orphaned tool_use blocks in the restored messages.
      // Sessions saved via force-quit (Ctrl+C twice) or process signals
      // (SIGTERM, beforeExit) bypass the post-turn repairOrphanedToolUse
      // call, so the saved session may contain tool_use blocks without
      // matching tool_result entries. Without this repair, the first API
      // call after /resume would fail with a 400 "missing tool_result"
      // error. Same fix applied to the --resume CLI path above.
      repairOrphanedToolUse(messages);

      // Restore session state
      const ss = sessionToLoad.sessionState;
      session.turnCount = ss.turnCount;
      // Default to 0 for numeric fields that may be absent in older session
      // files. The session validator (`isValidSessionShape`) only requires
      // `turnCount` to be a number; the other numeric fields are optional
      // (checked only when present). Without defaulting, `undefined` is
      // assigned to the `number`-typed session fields, and subsequent
      // arithmetic (`undefined + 100 = NaN`) silently produces NaN —
      // corrupting /status cost estimates, API time display, auto-save
      // threshold checks (`NaN >= 1` is false, so shouldAutoSave never
      // triggers), and per-model token tracking. The same risk exists for
      // `totalApiDurationMs` used in formatDuration (NaN ms → "NaN ms").
      session.totalApiDurationMs = ss.totalApiDurationMs ?? 0;
      session.totalInputTokens = ss.totalInputTokens ?? 0;
      session.totalOutputTokens = ss.totalOutputTokens ?? 0;
      // tokensByModel is a per-REPL-session tracking structure (Map, not
      // serialized to JSON) so it starts empty on resume. The fallback path
      // in /status handles this gracefully by pricing all tokens at the
      // current model's rate — acceptable because we can't know which model
      // was used for each token in the saved session.
      session.tokensByModel.clear();
      // Default to empty array if the session was saved before the history
      // field was introduced. Without this, `ss.history` is `undefined` when
      // loading old session files (isValidSessionShape doesn't validate it),
      // causing `session.history.length` to throw "Cannot read properties of
      // undefined" and `session.history.push()` to crash on the next turn.
      session.history = Array.isArray(ss.history) ? ss.history : [];
      // Cap history length in case the saved session predates the limit
      if (session.history.length > MAX_HISTORY_ENTRIES) {
        session.history.splice(0, session.history.length - MAX_HISTORY_ENTRIES);
      }
      session.startTime = Date.now(); // Reset timer for this sitting

      // Reset auto-save tracking so the restored session's first new turn
      // triggers an immediate save. Without this, `lastSaveTurn` retains the
      // value from the *pre-resume* session (e.g., 0 from startup), while
      // `session.turnCount` is restored from the saved session (e.g., 20),
      // making `shouldAutoSave` work — but `lastSaveTime` could be recent
      // from the pre-resume session, skipping the time-based trigger too.
      state.lastSaveTurn = session.turnCount;
      state.lastSaveTime = Date.now();
      // Reset auto-compaction loop suppression — the resumed session may
      // have different context size characteristics.
      state.autoCompactSuppressedAt = null;

      state.sessionId = resolvedId;
      // Rebind debug logging to the resumed session's folder.
      setDebugSessionId(resolvedId);

      // Restore the model from the saved session so /model changes persist
      // across /resume. Without this, a user who switched to a different
      // model via /model would silently revert to the env var / config
      // default when resuming the session. Only restore if the saved model
      // is a non-empty string (older session files may lack this field).
      const savedModel = sessionToLoad.metadata.model;
      const modelChanged = savedModel && savedModel !== config.model;
      if (savedModel) {
        config.model = savedModel;
      }

      const tokens = estimateTokens(messages, getSystemPrompt(context.cwd).length);
      const meta = sessionToLoad.metadata;
      printSuccess("Session restored", resolvedId);
      console.log(`  ${dim("Turns:")}    ${meta.turnCount} | ${dim("Messages:")} ${meta.messageCount} | ${dim("Tokens:")} ~${tokens.toLocaleString()}`);
      if (modelChanged) {
        console.log(`  ${dim("Model:")}    ${cyan(savedModel)} ${dim("(restored from session)")}`);
      }
      console.log(`  ${dim("Preview:")} ${meta.preview}`);
      console.log(`  ${dim("From:")}    ${new Date(meta.updatedAt).toLocaleString()}`);
      console.log();

      return { handled: true, shouldContinue: true };
    }

    case "/delete-session": {
      const idToDelete = parts[1]?.trim();
      if (!idToDelete) {
        printWarning("Usage: /delete-session <id>");
        return { handled: true, shouldContinue: true };
      }

      // Support partial ID matching, consistent with /resume behavior.
      // Try exact match first, then fall back to substring matching.
      let resolvedDeleteId: string = idToDelete;

      // Check if exact match exists by listing sessions
      const allSessionsForDelete = listSessions();
      const exactMatch = allSessionsForDelete.some((s) => s.id === idToDelete);
      if (!exactMatch) {
        // Try partial match
        const matches = allSessionsForDelete.filter((s) => s.id.includes(idToDelete));
        if (matches.length === 1) {
          resolvedDeleteId = matches[0].id;
        } else if (matches.length > 1) {
          printWarning(`Multiple sessions match "${idToDelete}":`);
          for (let i = 0; i < Math.min(matches.length, 5); i++) {
            console.log(formatSessionEntry(matches[i], i));
          }
          printInfo("Be more specific to identify a single session.");
          return { handled: true, shouldContinue: true };
        } else {
          printWarning(`Session "${idToDelete}" not found.`);
          return { handled: true, shouldContinue: true };
        }
      }

      if (resolvedDeleteId === state.sessionId) {
        printWarning("Cannot delete the current session. Use /clear instead.");
        return { handled: true, shouldContinue: true };
      }
      if (deleteSession(resolvedDeleteId)) {
        printSuccess("Session deleted", resolvedDeleteId);
      } else {
        printWarning(`Session "${resolvedDeleteId}" not found.`);
      }
      return { handled: true, shouldContinue: true };
    }

    // ── MCP ──

    case "/mcp": {
      const statuses = getMcpServerStatus();
      if (statuses.length === 0) {
        printInfo("No MCP servers configured.");
        printInfo(`Add servers via ${cyan(".mcp.json")} (project) or ${cyan("~/.claude.json")} (user).`);
      } else {
        console.log(`\n${bold("MCP Servers")} (${statuses.length})\n`);
        for (const s of statuses) {
          const stateColor = s.state === "connected" ? green
            : s.state === "error" ? red
            : s.state === "connecting" ? yellow
            : dim;
          const stateIcon = s.state === "connected" ? "●"
            : s.state === "error" ? "✖"
            : s.state === "connecting" ? "◌"
            : "○";
          console.log(
            `  ${stateColor(stateIcon)} ${bold(s.name)} ${dim(`(${s.type})`)} — ${stateColor(s.state)}`
          );
          if (s.serverInfo) {
            console.log(`    Server: ${s.serverInfo.name} v${s.serverInfo.version}`);
          }
          if (s.toolCount > 0) {
            console.log(`    Tools: ${s.toolCount}`);
          }
          if (s.resourceCount > 0) {
            console.log(`    Resources: ${s.resourceCount}`);
          }
          if (s.error) {
            console.log(`    Error: ${red(s.error)}`);
          }
        }
        console.log();
      }
      return { handled: true, shouldContinue: true };
    }

    // ── Memory ──

    case "/memory": {
      const memory = loadProjectMemory(context.cwd);
      if (!memory.trim()) {
        printInfo("No project memory loaded.");
        printInfo(`Create ${cyan("CLAUDE.md")} in your project root, or ${cyan("~/.claude/CLAUDE.md")} for global memory.`);
      } else {
        console.log(`\n${bold("Project Memory")}\n`);
        // Show a preview — full memory can be very long
        const lines = memory.trim().split("\n");
        const MAX_PREVIEW_LINES = 40;
        if (lines.length > MAX_PREVIEW_LINES) {
          console.log(lines.slice(0, MAX_PREVIEW_LINES).join("\n"));
          console.log(dim(`\n... (${lines.length - MAX_PREVIEW_LINES} more lines — ${lines.length} total)`));
        } else {
          console.log(memory.trim());
        }
        console.log();
      }
      return { handled: true, shouldContinue: true };
    }

    // ── Skills ──

    case "/skills": {
      const skills = getInvocableSkills(context.cwd);
      if (skills.length === 0) {
        printInfo("No skills found.");
        printInfo(`Create ${cyan(".claude/skills/*/SKILL.md")} in your project, or ${cyan("~/.claude/skills/*/SKILL.md")} for personal skills.`);
        printInfo(`Configure custom directories via ${cyan('"skillDirs"')} in ${cyan("~/.claude/settings.json")}.`);
      } else {
        console.log(`\n${bold("Available Skills")} (${skills.length})\n`);
        for (const skill of skills) {
          console.log(`  ${cyan(`/${skill.name}`)} — ${skill.description}`);
          if (skill.context === "fork") {
            console.log(`    ${dim(`Runs in isolated sub-agent (${skill.agent ?? "general-purpose"})`)}`);
          }
          if (skill.allowedTools?.length) {
            console.log(`    ${dim(`Tools: ${skill.allowedTools.join(", ")}`)}`);
          }
        }
        console.log();
      }
      return { handled: true, shouldContinue: true };
    }

    // ── Hot restart ──

    case "/reload": {
      await handleHotReload(state);
      return { handled: true, shouldContinue: true };
    }

    // ── Debug mode ──

    case "/debug": {
      const result = toggleDebug(state.sessionId);
      if (result.enabled) {
        printSuccess("Debug mode", "ON");
        printInfo(`Logging all LLM interactions to: ${cyan(result.logPath)}`);
        printInfo("Each event is a separate timestamped JSON file in the session's debug folder.");
        printInfo("Use /debug again to turn off. Logs persist on disk for review.");
      } else {
        printInfo(`Debug mode ${bold("OFF")}`);
        if (result.logPath) {
          printInfo(`Debug logs: ${dim(result.logPath)}`);
        }
      }
      return { handled: true, shouldContinue: true };
    }

    // ── Retry ──

    case "/retry": {
      // Find the last user text message (not a tool_result message — those
      // are system-generated). Walk backward through messages to find it.
      // Checks both string content AND array content with text blocks,
      // because `repairOrphanedToolUse` in compaction.ts can convert a
      // user message's string content to an array (TextBlock + synthetic
      // ToolResultBlocks) to maintain tool_use/tool_result pairing. Without
      // checking array content, /retry can't find the user's prompt after
      // such a conversion and unnecessarily falls back to session.history.
      let lastUserTextIdx = -1;
      let lastUserText = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg.role !== "user") continue;

        let extractedText: string | null = null;
        if (typeof msg.content === "string") {
          extractedText = msg.content;
        } else if (Array.isArray(msg.content)) {
          // Extract text from the first TextBlock in the array.
          // repairOrphanedToolUse places the original text as the first
          // element; user messages with only tool_result blocks (no text)
          // are system-generated and should be skipped.
          const textBlock = msg.content.find(
            (b): b is { type: "text"; text: string } =>
              b.type === "text" && typeof (b as { text?: unknown }).text === "string"
          );
          if (textBlock) {
            extractedText = textBlock.text;
          }
        }
        if (extractedText == null) continue;

        // Skip the compaction summary placeholder — it's not a real user
        // prompt and retrying it would re-submit the summary text as a
        // question, producing nonsensical results.
        if (extractedText.startsWith("[Previous conversation summary]")) {
          continue;
        }
        lastUserTextIdx = i;
        lastUserText = extractedText;
        break;
      }

      if (lastUserTextIdx === -1) {
        // No user text message found in `messages` — this can happen after
        // compaction replaces all messages with a summary + acknowledgment,
        // losing the original user prompts. Fall back to `session.history`
        // which always preserves the raw user inputs regardless of compaction.
        if (session.history.length > 0) {
          const lastHistoryEntry = session.history[session.history.length - 1];
          lastUserText = lastHistoryEntry.text;
          // Decrement turnCount just like the normal retry path (line ~647).
          // Without this, the REPL loop increments turnCount when it re-submits
          // the retried prompt, inflating the count by 1 per retry — e.g., after
          // 3 turns, /compact, and /retry, /status would show "4 turns" instead
          // of the correct 3.
          if (session.turnCount > 0) {
            session.turnCount--;
          }
          const preview = lastUserText.length > 80
            ? safeTruncate(lastUserText, 77) + "…"
            : lastUserText;
          printInfo(`Retrying from history: ${dim(preview)} ${dim("(original messages were compacted)")}`);
          return { handled: true, shouldContinue: true, retryPrompt: lastUserText };
        }
        printWarning("Nothing to retry — no previous user prompt found.");
        return { handled: true, shouldContinue: true };
      }

      // Remove all messages from the last user text message onward (inclusive).
      // This drops the user's prompt, the assistant's response, and any tool
      // use/result messages that followed — effectively rewinding the
      // conversation to just before the last prompt was submitted.
      const removedCount = messages.length - lastUserTextIdx;
      messages.length = lastUserTextIdx;

      // Decrement turnCount to undo the count for the turn being retried.
      // Without this, the REPL loop increments turnCount again when it
      // re-submits the retried prompt (line ~1057), inflating the count
      // by 1 per retry — e.g., after 3 turns and 1 /retry, /status would
      // show "4 turns" instead of the correct 3.
      if (session.turnCount > 0) {
        session.turnCount--;
      }

      const preview = lastUserText.length > 80
        ? safeTruncate(lastUserText, 77) + "…"
        : lastUserText;
      printInfo(`Retrying: ${dim(preview)} ${dim(`(removed ${removedCount} message${removedCount !== 1 ? "s" : ""})`)}`);

      // Signal the REPL to re-submit this prompt immediately
      return { handled: true, shouldContinue: true, retryPrompt: lastUserText };
    }

    case "/agents": {
      const agentArg = parts[1]?.trim();
      const agents = listRunningAgents();

      // If an agent ID (or partial ID) is provided, show its full result
      // instead of the truncated 120-char preview. This lets users inspect
      // the complete output of a background agent without reading its temp
      // file manually — especially useful when the truncated preview shows
      // something interesting that needs the full context.
      if (agentArg) {
        // Find by exact or partial match, consistent with /resume behavior
        const matches = agents.filter((a) => a.id === agentArg || a.id.includes(agentArg));
        if (matches.length === 0) {
          printWarning(`No agent found matching "${agentArg}". Use /agents to see tracked agents.`);
        } else if (matches.length > 1) {
          printWarning(`Multiple agents match "${agentArg}":`);
          for (const a of matches) {
            const status = a.done ? green("✓ done") : yellow("⟳ running");
            console.log(`  ${cyan(a.id)}  ${status}`);
          }
          printInfo("Be more specific to identify a single agent.");
        } else {
          const agent = matches[0];
          const status = agent.done ? green("✓ done") : yellow("⟳ running");
          console.log(`\n${bold("Agent")} ${cyan(agent.id)}  ${status}\n`);
          console.log(`  ${dim("Output file:")} ${agent.outputFile}`);
          if (agent.done && agent.result) {
            // Show the full result, but cap at a reasonable limit to avoid
            // flooding the terminal. 5000 chars is generous for inspection
            // while preventing a screen-filling wall of text.
            const MAX_FULL_RESULT = 5000;
            if (agent.result.length > MAX_FULL_RESULT) {
              console.log(`\n${safeTruncate(agent.result, MAX_FULL_RESULT)}`);
              console.log(`\n${dim(`… (${agent.result.length - MAX_FULL_RESULT} more chars — see ${agent.outputFile} for full output)`)}`);
            } else {
              console.log(`\n${agent.result}`);
            }
          } else if (!agent.done) {
            printInfo("Agent is still running. Check back later.");
          } else {
            printInfo("Agent completed but produced no output.");
          }
          console.log();
        }
      } else if (agents.length === 0) {
        printInfo("No background agents are currently tracked.");
      } else {
        console.log(`\n${bold("Background Agents")} ${dim(`(${agents.length} tracked)`)}\n`);
        for (const agent of agents) {
          const status = agent.done
            ? green("✓ done")
            : yellow("⟳ running");
          console.log(`  ${dim("ID:")} ${cyan(agent.id)}  ${status}`);
          console.log(`  ${dim("Output:")} ${agent.outputFile}`);
          if (agent.done && agent.result) {
            const preview = agent.result.length > 120
              ? safeTruncate(agent.result, 117) + "…"
              : agent.result;
            console.log(`  ${dim("Result:")} ${preview}`);
          }
          console.log();
        }
        printInfo(`Use ${cyan("/agents <id>")} to see the full result of a specific agent.`);
      }
      return { handled: true, shouldContinue: true };
    }

    default:
      return { handled: false, shouldContinue: true };
  }
}

// ── Auto-save logic ──

function autoSaveSession(state: ReplState, precomputedTokens?: number): boolean {
  if (state.messages.length === 0) return false;

  const tokens = precomputedTokens ?? estimateTokens(state.messages);
  const ok = saveSession(
    state.sessionId,
    state.messages,
    {
      turnCount: state.session.turnCount,
      totalApiDurationMs: state.session.totalApiDurationMs,
      totalInputTokens: state.session.totalInputTokens,
      totalOutputTokens: state.session.totalOutputTokens,
      history: state.session.history,
    },
    state.context.cwd,
    state.config.model,
    tokens,
    state.context.exploreCache?.serialize()
  );
  if (ok) {
    state.lastSaveTurn = state.session.turnCount;
    state.lastSaveTime = Date.now();
  }
  return ok;
}

function shouldAutoSave(state: ReplState): boolean {
  // Save if enough turns have elapsed
  if (state.session.turnCount - state.lastSaveTurn >= AUTO_SAVE_AFTER_TURNS) {
    return true;
  }
  // Save if enough time has elapsed
  if (Date.now() - state.lastSaveTime >= AUTO_SAVE_INTERVAL_MS) {
    return true;
  }
  return false;
}

/**
 * Strip session-specific flags from argv so the resulting command can be
 * cleanly reused with a new `--resume` argument. Removes `--resume`, `-p`,
 * and `--prompt` along with their following argument values.
 *
 * Handles both `--flag value` (two args) and `--flag=value` (single arg)
 * syntax. Without the `=` syntax support, `codingagent --resume=abc123`
 * followed by `/reload` would pass `--resume=abc123` through to the child
 * process alongside the new `--resume <id>`, causing a double-resume.
 *
 * Used by both `printResumeHint` (display command) and `handleHotReload`
 * (spawn child process). Previously each had its own inline filter, and
 * the hot-reload version only stripped `--resume` — missing `-p`/`--prompt`
 * could cause the resumed child process to re-run the original prompt
 * instead of resuming interactively.
 */
function cleanArgvForResume(): string[] {
  const FLAGS_WITH_VALUE = new Set(["--resume", "-p", "--prompt"]);
  return process.argv.slice(1).filter((a, i, arr) => {
    if (FLAGS_WITH_VALUE.has(a)) return false;
    // Handle --flag=value syntax (e.g., --resume=abc123, --prompt="fix bug")
    if (a.includes("=")) {
      const flagPart = a.slice(0, a.indexOf("="));
      if (FLAGS_WITH_VALUE.has(flagPart)) return false;
    }
    // Also skip the argument following a flag-with-value
    if (i > 0 && FLAGS_WITH_VALUE.has(arr[i - 1])) return false;
    return true;
  });
}

/**
 * Quote an argument that contains spaces so displayed commands are
 * copy-paste safe. Common on Windows where paths like
 * "C:\Program Files\nodejs\node.exe" contain spaces.
 *
 * Also escapes embedded double quotes — without this, an arg like
 * `C:\folder "name"\node.exe` would produce `"C:\folder "name"\node.exe"`
 * which is broken when pasted into a shell. Escaping inner quotes with
 * backslash produces a valid `"C:\folder \"name\"\node.exe"` for both
 * bash and PowerShell/cmd (where `\"` is a common escape).
 */
function quoteIfNeeded(arg: string): string {
  if (!arg.includes(" ")) return arg;
  // Escape any embedded double quotes so the wrapping quotes aren't broken
  const escaped = arg.replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Print a hint showing the command to resume this session.
 * Uses `process.argv` to reconstruct the actual invocation command rather
 * than a hardcoded `npx tsx src/index.ts` path — the user may be running
 * via a globally-installed binary, an npm script, or a different entry point.
 */
function printResumeHint(sessionId: string): void {
  const baseArgs = cleanArgvForResume();
  // Use the actual Node/tsx/npx binary from argv[0]
  const cmd = [process.argv[0], ...baseArgs, "--resume", sessionId]
    .map(quoteIfNeeded)
    .join(" ");
  console.log(
    `\n  ${dim("To resume this session, run:")}  ${cyan(cmd)}\n`
  );
}

// ── Hot reload ──

async function handleHotReload(state: ReplState): Promise<void> {
  const spinner = new Spinner("Rebuilding…");
  spinner.start();

  try {
    // Step 1: Save current session
    autoSaveSession(state);

    // Step 2: Check for TypeScript build errors
    try {
      execSync("npx tsc --noEmit", {
        encoding: "utf-8",
        // Use the codingagent project root, NOT state.context.cwd (the user's
        // working directory). The user may be working in a completely different
        // project that either has no tsconfig.json (causing tsc to fail) or has
        // its own tsconfig (type-checking the wrong codebase).
        cwd: PROJECT_ROOT,
        timeout: 30_000,
        stdio: "pipe",
      });
    } catch (err: unknown) {
      spinner.stop();
      const tscOutput = (err != null && typeof err === "object" && "stdout" in err && typeof (err as { stdout: unknown }).stdout === "string")
        ? (err as { stdout: string }).stdout
        : String(err);
      const errorCount = (tscOutput.match(/error TS\d+/g) ?? []).length;
      console.log(`\n${red("✗")} ${bold("Build failed")} ${dim(`(${errorCount} error${errorCount !== 1 ? "s" : ""})`)}`);
      console.log(dim(safeTruncate(tscOutput, 1000)));
      printWarning("Fix the errors and try /reload again.");
      return;
    }

    // Step 3: Perform the restart
    spinner.update("Restarting…");

    // Save the session ID so we can resume
    const sessionId = state.sessionId;

    spinner.stop(`${green("✓")} ${bold("Build passed")} — restarting with session ${cyan(sessionId)}…`);

    // Close the parent's readline interface BEFORE spawning the child so
    // both processes don't compete for stdin. With `stdio: "inherit"`, the
    // child inherits the parent's stdin/stdout/stderr file descriptors.
    // If the parent's readline is still active, it continues listening for
    // input on stdin — any keystrokes the user types may be consumed by the
    // parent's readline instead of the child's, causing lost or duplicated
    // input and confusing the user.
    output.detachReadline();
    if (state.rl) {
      state.rl.close();
    }

    // Spawn a new process with --resume flag, inheriting stdio.
    // Use cleanArgvForResume() to strip --resume, -p, --prompt and their
    // args — prevents duplication and avoids re-running a -p prompt in the
    // child process instead of resuming interactively.
    const { spawn } = await import("child_process");
    const cleanArgs = cleanArgvForResume();
    const child = spawn(
      process.argv[0],
      [...cleanArgs, "--resume", sessionId],
      {
        cwd: state.context.cwd,
        stdio: "inherit",
        env: { ...process.env, CODINGAGENT_RELOAD: "1" },
        // On Windows, use shell to resolve tsx properly
        shell: process.platform === "win32",
      }
    );

    child.on("exit", (code) => {
      process.exit(code ?? 0);
    });

    // Handle spawn failure (e.g., process.argv[0] doesn't exist, ENOENT,
    // permissions error). Without this, the error is unhandled and the parent
    // process hangs silently because the readline was already closed above.
    child.on("error", (err) => {
      console.error(`\n${formatError(`Hot reload spawn failed: ${err.message}`)}`);
      process.exit(1);
    });

    // Give the child a moment to start, then don't process further input
    // The readline loop will end when the parent exits
  } catch (err: unknown) {
    spinner.stop();
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n${formatError(`Hot reload failed: ${msg}`)}`);
  }
}

// ── Main ──

async function main() {
  const config = loadConfig();
  const context: ToolContext = createContext();

  // ── Early API key validation ──
  // Check that the API key is set before the REPL starts. Without this,
  // a missing key only surfaces as a confusing 401 error on the first prompt.
  // Use `config.apiKey` which checks both settings.json and process.env
  // (same source as client.ts), so the warning fires only when neither
  // source provides a key.
  const apiKey = config.apiKey;
  if (!apiKey) {
    const setCmd =
      process.platform === "win32"
        ? `  PowerShell:  $env:ANTHROPIC_API_KEY = "sk-ant-..."\n  cmd:         set ANTHROPIC_API_KEY=sk-ant-...`
        : `  export ANTHROPIC_API_KEY=sk-ant-...`;
    console.warn(
      `\n${yellow("⚠")} ${bold("ANTHROPIC_API_KEY is not set.")}\n\n` +
      `The API key is required for all interactions. Set it before starting:\n\n` +
      `${setCmd}\n\n` +
      `Or add it to ~/.claude/settings.json under "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }\n`
    );
  } else if (!apiKey.startsWith("sk-ant-")) {
    // Common mistakes: setting a placeholder like "your-key-here", pasting an
    // OpenAI key (starts with "sk-"), or accidentally copying extra whitespace.
    // The key format check is non-blocking: users with API proxies/gateways
    // may use custom key formats, so we warn but don't reject. Without this,
    // an invalid key only surfaces as a confusing 401 error on the first prompt.
    printWarning(
      `ANTHROPIC_API_KEY doesn't start with "sk-ant-" — it may be invalid. ` +
      `Anthropic API keys typically start with "sk-ant-api...".`
    );
  }

  // Wire up sub-agent spawning
  context.spawnAgent = (prompt, options) =>
    spawnAgent(prompt, options, context);

  // ── Auto-enable debug mode from config ──
  // When CODINGAGENT_DEBUG=1 is set in environment or settings.json,
  // enable debug logging before any API calls are made.
  if (config.debug) {
    const logPath = enableDebug();
    printInfo(`Debug mode enabled (CODINGAGENT_DEBUG). Logging to: ${logPath}`);
  }

  // ── Load MCP servers ──
  // Connect to configured MCP servers and discover their tools.
  // This runs in parallel with the REPL startup — a slow MCP server
  // won't block the user from typing their first prompt.
  //
  // The printInfo/printWarning calls here are readline-safe via the
  // OutputManager singleton — once `output.setReadline()` is called
  // (after creating `rl`), any async output automatically clears the
  // prompt, prints, and re-draws the prompt. No manual ANSI gymnastics
  // needed.
  const mcpLoadPromise = loadMcpServers(context.cwd).then(() => {
    const mcpToolList = getMcpTools();
    if (mcpToolList.length > 0) {
      registerMcpTools(mcpToolList);
      printInfo(`Loaded ${mcpToolList.length} tool(s) from MCP servers.`);
    }
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    printWarning(`MCP server loading failed: ${msg}`);
  });

  // ── Register skill commands ──
  // Load skills from SKILL.md files and register them as slash commands
  // so they appear in tab-completion, inline hints, and /help.
  syncSkillCommands(context.cwd);

  // ── Initialize frecency scores ──
  // Load command usage history for frecency-boosted hint ranking.
  setFrecencyScores(getFrecencyScores());

  const messages: Message[] = [];
  const tools = getAllTools();
  const session = createSessionState();

  // Parse CLI args
  const args = process.argv.slice(2);

  // ── --help / -h flag ──
  // Show usage information and exit. This must be checked before any other
  // flag parsing, since users running `codingagent --help` expect immediate
  // output rather than being dropped into the REPL or waiting for an API key.
  if (args.includes("--help") || args.includes("-h")) {
    // Build the REPL Commands section dynamically from the command registry
    // so it stays in sync with the actual commands. Previously this was a
    // hardcoded list that could drift out of sync with handleCommand().
    const registeredCmds = getRegisteredCommands();
    const cmdLines = registeredCmds.map((c) => {
      const padded = c.command.padEnd(22);
      return `  ${padded} ${c.description}`;
    }).join("\n");

    console.log(`
${bold("CodingAgent")} — AI coding assistant with tool use

${bold("Usage:")}
  codingagent                    Start interactive REPL
  codingagent -p "prompt"        Run a single prompt and exit
  codingagent --resume [id]      Resume a saved session
  echo "prompt" | codingagent    Read prompt from stdin

${bold("Options:")}
  -p, --prompt <text>    Run non-interactively with the given prompt
  --resume [id]          Resume a session (latest if no ID given)
  --eval                 Enable multi-judge evaluation gate (verify completion)
  -h, --help             Show this help message

${bold("Environment Variables:")}
  ANTHROPIC_API_KEY              API key (required)
  ANTHROPIC_MODEL                Model name (default: claude-sonnet-4-20250514)
  ANTHROPIC_SMALL_FAST_MODEL     Model for compaction/exploration
  ANTHROPIC_BASE_URL             Custom API base URL
  ANTHROPIC_MAX_OUTPUT_TOKENS    Max output tokens per response (default: 16384)
  ANTHROPIC_COMPACTION_THRESHOLD Token threshold for auto-compaction (default: 160000)
  CODINGAGENT_DEBUG              Enable debug logging (1/true/yes/on)

${bold("REPL Commands:")}
${cmdLines}

${dim("Config file: ~/.claude/settings.json")}
`);
    process.exit(0);
  }

  let sessionId = generateSessionId();
  let resumedSession = false;
  // Track whether --resume changed the active model (for user notification).
  // Set inside the --resume block, consumed by the banner display below.
  let resumeModelChangedFlag: string | null = null;

  // Check for --resume flag (used by hot reload or manual resume)
  // Supports both `--resume <id>` (two args) and `--resume=<id>` (one arg).
  const resumeIdx = args.findIndex((a) => a === "--resume" || a.startsWith("--resume="));
  if (resumeIdx !== -1) {
    // Extract value from --resume=<id> or --resume <id>
    const resumeArg = args[resumeIdx];
    const equalsValue = resumeArg.includes("=") ? resumeArg.slice(resumeArg.indexOf("=") + 1) : undefined;
    const nextArg = args[resumeIdx + 1];
    const hasExplicitId = equalsValue
      ? equalsValue.length > 0
      : (nextArg != null && !nextArg.startsWith("-"));
    let resumeId: string | null = hasExplicitId
      ? (equalsValue ?? nextArg)
      : getLastSessionId();

    if (resumeId) {
      const saved = loadSession(resumeId);
      if (saved) {
        messages.push(...saved.messages);
        session.turnCount = saved.sessionState.turnCount;
        // Default to 0 for numeric fields that may be absent in older session
        // files — same rationale as the /resume command handler above (line ~765).
        session.totalApiDurationMs = saved.sessionState.totalApiDurationMs ?? 0;
        session.totalInputTokens = saved.sessionState.totalInputTokens ?? 0;
        session.totalOutputTokens = saved.sessionState.totalOutputTokens ?? 0;
        session.history = Array.isArray(saved.sessionState.history) ? saved.sessionState.history : [];
        // Cap history length in case the saved session predates the limit
        if (session.history.length > MAX_HISTORY_ENTRIES) {
          session.history.splice(0, session.history.length - MAX_HISTORY_ENTRIES);
        }
        // Reset read-file-state cache so the agent must re-read files before
        // editing them in this restored session. Same fix applied to the
        // /resume command handler (improvement #14), but this CLI --resume
        // path was missed — stale mtimes from a previous session could allow
        // edits based on outdated file content without a fresh read.
        context.readFileState.clear();
        // Restore the explore cache from the saved session. Read entries are
        // mtime-validated during restore — stale entries are automatically
        // discarded. Same logic as the /resume command handler above.
        context.exploreCache?.clear();
        if (saved.exploreCache && context.exploreCache) {
          context.exploreCache.restore(saved.exploreCache);
        }
        // Repair any orphaned tool_use blocks in the restored messages.
        // Sessions saved via force-quit (Ctrl+C twice) or process signals
        // (SIGTERM, beforeExit) bypass the post-turn repairOrphanedToolUse
        // call — the exit handler calls autoSaveSession directly without
        // repairing first. If the session was interrupted mid-agentic-loop
        // (between the assistant's tool_use message and the user's tool_result
        // message), the saved session contains an orphaned tool_use block.
        // Without this repair, the first API call after resume would fail with
        // a 400 "missing tool_result" error from the Anthropic API, forcing the
        // user to /clear and lose their conversation.
        repairOrphanedToolUse(messages);
        // Restore the model from the saved session so /model changes persist
        // across --resume and /reload. Without this, the model silently
        // reverts to the env var / config default. Same fix applied to
        // the /resume command handler above.
        //
        // Track whether the model changed so we can notify the user below
        // (matching the feedback already shown by the /resume command handler
        // at line ~746). Without this, a user who set ANTHROPIC_MODEL=opus
        // in their env and then --resumed a session that used Sonnet would
        // silently use Sonnet with no visible indication that their env var
        // was overridden.
        const savedModel = saved.metadata.model;
        const resumeModelChanged = savedModel && savedModel !== config.model;
        if (savedModel) {
          config.model = savedModel;
        }
        sessionId = resumeId;
        resumedSession = true;
        // Store the flag for use in the resume banner below (outside this scope).
        // We can't show the message here because the banner hasn't been printed yet.
        resumeModelChangedFlag = resumeModelChanged ? savedModel : null;
      } else {
        printWarning(`Session "${resumeId}" not found.`);
      }
    } else {
      printWarning("No saved sessions to resume.");
    }
    // Remove --resume and its arg so they don't interfere with other flag parsing.
    // --resume=value is 1 arg; --resume value is 2 args (when hasExplicitId).
    const spliceCount = equalsValue != null ? 1 : (hasExplicitId ? 2 : 1);
    args.splice(resumeIdx, spliceCount);
  }

  // ── Bind debug logging to the session ID ──
  // Now that the session ID is finalized (either freshly generated or
  // restored via --resume), point the debug logger at the session's
  // debug folder. If debug was auto-enabled from CODINGAGENT_DEBUG
  // (line ~1718) before the ID was known, this migrates it to the
  // correct session folder.
  setDebugSessionId(sessionId);

  // Check for -p or --prompt flag (non-interactive mode)
  // Supports both `-p "text"` / `--prompt "text"` (two args) and `--prompt="text"` (one arg).
  const promptIdx = args.findIndex((a) => a === "-p" || a === "--prompt" || a.startsWith("--prompt="));
  const enableEval = args.includes("--eval");
  if (promptIdx !== -1) {
    const promptArg = args[promptIdx];
    // Extract value from --prompt=value or -p value / --prompt value
    const promptEqualsValue = promptArg.includes("=") ? promptArg.slice(promptArg.indexOf("=") + 1) : undefined;
    const prompt = promptEqualsValue ?? args[promptIdx + 1];
    // Reject missing prompt value. Only reject strings that look like known
    // flags (--resume, -h, --help) — NOT arbitrary strings starting with "-".
    // Previously `prompt.startsWith("-")` rejected valid prompts like
    // "-1 bug found" or "-Fix the off-by-one error", which are legitimate
    // user inputs. The original check was meant to catch `codingagent -p --resume`
    // (missing value before the next flag), so we now check against known flags
    // instead of rejecting all dash-prefixed strings.
    const KNOWN_FLAGS = new Set(["-p", "--prompt", "--resume", "--eval", "-h", "--help"]);
    if (!prompt || KNOWN_FLAGS.has(prompt)) {
      const flagName = promptEqualsValue != null ? "--prompt" : promptArg;
      console.error(
        `${red("Error:")} Missing prompt after ${bold(flagName)}.\n\n` +
        `${bold("Usage:")} codingagent ${flagName} "your prompt here"\n` +
        `${bold("Example:")} codingagent ${flagName} "Explain the main function in index.ts"`
      );
      process.exit(1);
    }
    await runOnce(prompt, messages, tools, context, enableEval);
    return;
  }

  // Check for piped stdin
  if (!process.stdin.isTTY) {
    // Cap the total input size to prevent OOM when someone accidentally pipes
    // a large file (e.g., `cat hugefile.bin | codingagent`). 1 MB is generous
    // for any realistic prompt while preventing unbounded memory growth. This
    // matches the MAX_INPUT_BUFFER_CHARS pattern used for interactive multiline
    // input (line ~1621), but uses bytes for piped input since chunk sizes are
    // measured in bytes from the stream.
    const MAX_PIPED_STDIN_BYTES = 1_000_000; // ~1 MB
    const chunks: string[] = [];
    let totalBytes = 0;
    let truncated = false;
    for await (const chunk of process.stdin) {
      const str = chunk.toString();
      totalBytes += Buffer.byteLength(str, "utf-8");
      if (totalBytes > MAX_PIPED_STDIN_BYTES) {
        // Take only the portion that fits within the limit
        const excess = totalBytes - MAX_PIPED_STDIN_BYTES;
        if (excess < Buffer.byteLength(str, "utf-8")) {
          // Part of this chunk fits
          const bytesToKeep = Buffer.byteLength(str, "utf-8") - excess;
          // Approximate char count from bytes (slightly over-truncates for
          // multi-byte chars, which is fine — better to truncate a bit more
          // than to exceed the limit)
          chunks.push(str.slice(0, bytesToKeep));
        }
        truncated = true;
        break;
      }
      chunks.push(str);
    }
    const input = chunks.join("").trim();
    if (truncated) {
      console.error(
        `${yellow("⚠")} Piped input exceeded ${(MAX_PIPED_STDIN_BYTES / 1_000_000).toFixed(0)} MB limit — truncated. ` +
        `Use a file and the Read tool for larger inputs.`
      );
    }
    if (input) {
      await runOnce(input, messages, tools, context, enableEval);
    } else {
      // Empty piped stdin — e.g., `echo "" | codingagent` or `cat /dev/null | codingagent`.
      // Without feedback, the process silently exits 0, and the user may think
      // it failed or wasn't invoked correctly.
      console.error(
        `${yellow("⚠")} No input received from stdin.\n\n` +
        `${bold("Usage:")}\n` +
        `  echo "your prompt" | codingagent\n` +
        `  codingagent -p "your prompt"\n` +
        `  codingagent                      ${dim("(interactive mode)")}`
      );
      process.exitCode = 1;
    }
    return;
  }

  // ── Interactive REPL ──

  const isReload = process.env.CODINGAGENT_RELOAD === "1";

  if (isReload && resumedSession) {
    // Hot reload: show compact banner
    const tokens = estimateTokens(messages, getSystemPrompt(context.cwd).length);
    console.log(`\n${green("✓")} ${bold("Hot reload complete")} — session ${cyan(sessionId)} restored`);
    console.log(`  ${dim("Messages:")} ${messages.length} | ${dim("Turns:")} ${session.turnCount} | ${dim("Tokens:")} ~${tokens.toLocaleString()}`);
    if (resumeModelChangedFlag) {
      console.log(`  ${dim("Model:")}    ${cyan(resumeModelChangedFlag)} ${dim("(restored from session)")}`);
    }
    console.log(`  ${dim("All tools and code reloaded from disk.")}\n`);
  } else if (resumedSession) {
    // Manual resume: show banner + session info
    console.log(renderWelcomeBanner(config, context.cwd));
    const tokens = estimateTokens(messages, getSystemPrompt(context.cwd).length);
    printSuccess("Resumed session", sessionId);
    console.log(`  ${dim("Turns:")} ${session.turnCount} | ${dim("Messages:")} ${messages.length} | ${dim("Tokens:")} ~${tokens.toLocaleString()}`);
    // Notify when the restored session's model differs from the current
    // env/config model. This matches the feedback already shown by the
    // /resume command handler — without it, a user who sets ANTHROPIC_MODEL
    // in their env and then --resumes a session that used a different model
    // would silently use the session's model with no visible indication.
    if (resumeModelChangedFlag) {
      console.log(`  ${dim("Model:")}    ${cyan(resumeModelChangedFlag)} ${dim("(restored from session)")}`);
    }
    console.log();
  } else {
    console.log(renderWelcomeBanner(config, context.cwd));
  }

  // Prune old sessions in the background
  try { pruneSessions(); } catch { /* best-effort */ }

  const replState: ReplState = {
    messages,
    context,
    session,
    config,
    tools,
    sessionId,
    // When resuming via CLI --resume, session.turnCount is restored from the
    // saved session (e.g., 20), so `lastSaveTurn` must match to avoid an
    // immediate redundant save on the first turn. `shouldAutoSave` compares
    // `session.turnCount - lastSaveTurn >= 1`, which would always be true
    // with `lastSaveTurn: 0` and a restored `turnCount` of 20+.
    // For fresh sessions, session.turnCount is 0, so this is equivalent.
    // The /resume command handler already does this (line ~666), but the
    // CLI --resume path was missed.
    lastSaveTurn: session.turnCount,
    lastSaveTime: Date.now(),
    autoCompactSuppressedAt: null,
  };

  // ── Real-time inline command hints ──
  const hintManager = new InlineHintManager();

  const rl = createInterface({
    input: hintManager.createInputStream(),
    output: process.stdout,
    prompt: `\n${cyan(">")} `,
    completer: commandCompleter,
  });

  hintManager.attachReadline(rl);

  // Expose the readline interface to ReplState so /reload can close it
  // before spawning the child process (see handleHotReload).
  replState.rl = rl;

  // Attach readline to the OutputManager so all output (printInfo,
  // printWarning, printSuccess, etc.) becomes readline-safe. Any async
  // callback that calls these functions will automatically clear the
  // prompt, print cleanly, and re-draw the prompt below the message.
  output.setReadline(rl, hintManager);

  // Handle Ctrl+C gracefully
  let pendingForceQuit = false;
  let forceQuitTimer: ReturnType<typeof setTimeout> | null = null;

  rl.on("SIGINT", () => {
    hintManager.clearHints();
    if (pendingForceQuit) {
      // Auto-save before force quit
      try { autoSaveSession(replState); } catch { /* best-effort */ }
      try { abortAllAgents(); } catch { /* best-effort */ }
      console.log(`\n${dim("Session saved.")}`);
      printResumeHint(replState.sessionId);
      console.log(dim("Force quit."));
      process.exit(0);
    }
    console.log(`\n${yellow("[Interrupted]")} ${dim("Press Ctrl+C again within 3s to exit")}`);
    context.abortController.abort();
    context.abortController = new AbortController();

    pendingForceQuit = true;
    if (forceQuitTimer) clearTimeout(forceQuitTimer);
    // 3 seconds gives the user enough time to read the "Press Ctrl+C again"
    // message and react. The previous 1.5s was too narrow — by the time the
    // user reads the message and presses Ctrl+C again, the window had often
    // already expired, requiring a third press.
    forceQuitTimer = setTimeout(() => {
      pendingForceQuit = false;
      forceQuitTimer = null;
    }, 3000);
    forceQuitTimer.unref();

    rl.prompt();
  });

  // Auto-save and cleanup on process exit signals.
  //
  // Guard with `exitHandlerRan` to avoid redundant work. `beforeExit` fires
  // every time the event loop drains with nothing left to do — *not* just
  // once — so without a guard, `autoSaveSession` would perform I/O on every
  // drain cycle (once per event loop tick after the REPL goes idle). SIGTERM
  // may also fire right before `beforeExit`, causing double-save.
  let exitHandlerRan = false;
  const exitHandler = () => {
    if (exitHandlerRan) return;
    exitHandlerRan = true;
    try { autoSaveSession(replState); } catch { /* best-effort */ }
    // Abort any running background agents so their in-flight API calls
    // don't keep the process alive (or consume API credits) after the user
    // exits. Also clears the registry to release references for GC.
    try { abortAllAgents(); } catch { /* best-effort */ }
    // Shut down MCP server connections (kill stdio child processes,
    // reject pending requests). Without this, spawned MCP server
    // processes outlive the parent and become orphans.
    shutdownMcpServers().catch(() => { /* best-effort */ });
  };
  process.on("SIGTERM", exitHandler);
  process.on("beforeExit", exitHandler);

  rl.prompt();

  // ── Multiline input support ──
  // Lines ending with \ are continued on the next line.
  // Cap buffer size to prevent unbounded memory growth if the user
  // accidentally pastes a very large block where every line ends with \.
  const MAX_INPUT_BUFFER_CHARS = 500_000; // ~500 KB — generous for any realistic prompt
  let inputBuffer = "";

  for await (const line of rl) {
    // Clear any inline hints before processing the submitted line
    hintManager.clearHints();

    // Handle line continuation
    if (line.endsWith("\\")) {
      const addition = line.slice(0, -1) + "\n";
      if (inputBuffer.length + addition.length > MAX_INPUT_BUFFER_CHARS) {
        printWarning(
          `Multiline input too large (>${(MAX_INPUT_BUFFER_CHARS / 1000).toFixed(0)} KB). ` +
          `Submitting what was buffered so far. Consider using a file instead.`
        );
        // Submit the accumulated buffer + this line (without continuation
        // backslash) rather than silently discarding everything. Truncate
        // inputBuffer to the cap size so we don't send an oversized prompt
        // to the API — previously the full oversized buffer was submitted
        // because the code fell through without truncating.
        inputBuffer = safeTruncate(inputBuffer, MAX_INPUT_BUFFER_CHARS);
        // Fall through to line submission below (line without trailing \)
      } else {
        inputBuffer += addition;
        // Show the number of buffered lines in the continuation prompt so
        // users know how many lines they've entered. "... (2 lines) " is
        // more informative than a bare "... " — especially when pasting
        // large blocks, it confirms lines are being captured.
        const lineCount = inputBuffer.split("\n").length - 1;
        rl.setPrompt(`${dim(`... (${lineCount} line${lineCount !== 1 ? "s" : ""})`)} `);
        rl.prompt();
        continue;
      }
    }

    let input = (inputBuffer + line).trim();
    inputBuffer = "";
    rl.setPrompt(`\n${cyan(">")} `);

    if (!input) {
      rl.prompt();
      continue;
    }

    // Handle slash commands
    if (input.startsWith("/")) {
      const result = await handleCommand(input, replState);
      if (result.handled) {
        // Record command usage for frecency ranking
        recordCommandUse(input);
        setFrecencyScores(getFrecencyScores());
        // If the command returned a retry prompt (e.g., /retry), fall through
        // to the message submission logic below instead of prompting for input.
        if (result.retryPrompt) {
          input = result.retryPrompt;
          // Fall through to the agentic loop below
        } else {
          rl.prompt();
          continue;
        }
      } else {
        // ── Skill invocation ──
        // Check if the unrecognized command matches a skill name.
        // Skills are invoked as `/skill-name <arguments>`.
        const skillCmd = input.split(/\s+/)[0].slice(1); // remove leading /
        const skillArgs = input.slice(input.indexOf(skillCmd) + skillCmd.length).trim();
        const skill = getSkill(context.cwd, skillCmd);
        if (skill && skill.userInvocable) {
          // Substitute arguments into the skill template
          const expandedInstructions = substituteArguments(skill.instructions, skillArgs);
          printInfo(`Running skill: ${bold(skill.name)}`);
          // Inject the skill instructions as the user's prompt
          input = expandedInstructions;
          // Fall through to the agentic loop below
        } else {
          // Unrecognized slash command — show suggestions instead of sending to LLM
          const cmd = input.split(/\s+/)[0].toLowerCase();
          console.log(renderCommandSuggestions(cmd));
          rl.prompt();
          continue;
        }
      }
    }

    // Run the agentic loop
    messages.push({ role: "user", content: input });
    session.history.push({ timestamp: Date.now(), text: input });
    // Evict oldest history entries if the array exceeds the cap.
    // Uses splice(0, excess) to remove from the front in one operation
    // rather than repeated shift() calls.
    if (session.history.length > MAX_HISTORY_ENTRIES) {
      session.history.splice(0, session.history.length - MAX_HISTORY_ENTRIES);
    }
    session.turnCount++;

    const turnStart = performance.now();
    const spinner = new Spinner("Thinking…");
    let tokens = 0; // set after the turn completes, reused for auto-compact check

    try {
      let spinnerActive = false;
      // ── Markdown streaming state ──
      // Accumulate assistant_text chunks so we can replace the raw streamed
      // text with rendered markdown when the response is complete (on
      // turn_complete or before tool_use). Mirrors the TerminalOutputPort
      // approach in terminal-port.ts.
      const mdEnabled = isMarkdownEnabled();
      let assistantTextBuffer = "";
      let streamedCharCount = 0;

      /**
       * Erase raw streamed text and replace with rendered markdown.
       * Called when the assistant's text segment is complete (before a
       * tool_use or on turn_complete).
       */
      function flushMarkdown(): void {
        if (!mdEnabled || !assistantTextBuffer) return;
        // Erase the raw streamed text by computing how many terminal rows
        // it occupied, moving the cursor up, and clearing to end of screen.
        if (streamedCharCount > 0) {
          const cols = process.stdout.columns || 80;
          const rawLines = assistantTextBuffer.split("\n");
          let totalRows = 0;
          for (const line of rawLines) {
            totalRows += Math.max(1, Math.ceil((line.length || 1) / cols));
          }
          if (totalRows > 0) {
            const upCount = totalRows - 1;
            let eraseSeq = "\r";
            if (upCount > 0) {
              eraseSeq += `\x1b[${upCount}A`;
            }
            eraseSeq += "\x1b[0J";
            process.stdout.write(eraseSeq);
          }
        }
        // Render and output the full markdown
        const rendered = renderMarkdown(assistantTextBuffer);
        process.stdout.write(rendered);
        // Reset buffer
        assistantTextBuffer = "";
        streamedCharCount = 0;
      }

      for await (const event of agenticLoop(
        messages,
        getSystemPrompt(context.cwd),
        tools,
        context,
        undefined, // model — use default
        undefined, // maxTurns — use default
        enableEval
      )) {
        switch (event.type) {
          case "api_call_start":
            spinner.start();
            spinnerActive = true;
            break;

          case "api_call_end":
            if (spinnerActive) {
              spinner.stop();
              spinnerActive = false;
            }
            session.totalApiDurationMs += event.durationMs;
            if (event.usage) {
              session.totalInputTokens += event.usage.inputTokens;
              session.totalOutputTokens += event.usage.outputTokens;
              // Track per-model token usage for accurate cost estimation
              // across model switches. Uses `config.model` (the model active
              // at the time of this API call) rather than a model string from
              // the event, because the event doesn't carry the model name.
              const modelKey = config.model;
              const modelTokens = session.tokensByModel.get(modelKey);
              if (modelTokens) {
                modelTokens.inputTokens += event.usage.inputTokens;
                modelTokens.outputTokens += event.usage.outputTokens;
              } else {
                session.tokensByModel.set(modelKey, {
                  inputTokens: event.usage.inputTokens,
                  outputTokens: event.usage.outputTokens,
                });
              }
            }
            break;

          case "assistant_text":
            if (spinnerActive) {
              spinner.stop();
              spinnerActive = false;
            }
            // Stream raw text for immediate visual feedback; accumulate
            // in the buffer so we can replace with rendered markdown later.
            process.stdout.write(event.text);
            if (mdEnabled) {
              assistantTextBuffer += event.text;
              streamedCharCount += event.text.length;
            }
            break;

          case "tool_use":
            if (spinnerActive) {
              spinner.stop();
              spinnerActive = false;
            }
            // Flush any accumulated text as markdown before showing tool use
            flushMarkdown();
            console.log(`\n${formatToolUse(event.toolName, event.input)}`);
            spinner.update(`Running ${event.toolName}…`);
            spinner.start();
            spinnerActive = true;
            break;

          case "tool_result":
            if (spinnerActive) {
              spinner.stop();
              spinnerActive = false;
            }
            console.log(
              formatToolResult(
                event.toolName,
                event.result.content,
                event.durationMs,
                event.result.is_error
              )
            );
            break;

          case "turn_complete":
            if (spinnerActive) {
              spinner.stop();
              spinnerActive = false;
            }
            // Flush any remaining accumulated text as rendered markdown
            flushMarkdown();
            // Note: max_tokens truncation warning is already emitted by
            // loop.ts (line ~574) when it detects stop_reason === "max_tokens".
            // A second warning here would confuse the user with two slightly
            // different messages for the same event. Removed in favor of the
            // loop.ts version which fires closer to the truncation point and
            // includes actionable advice (ask to "continue", increase env var).
            break;

          case "eval_start":
            if (spinnerActive) {
              spinner.stop();
              spinnerActive = false;
            }
            console.log(`\n${bold(`🔍 Eval round ${event.round}/${MAX_EVAL_ROUNDS}`)} — ${event.judgeCount} judges evaluating…`);
            spinner.update("Evaluating…");
            spinner.start();
            spinnerActive = true;
            break;

          case "eval_judge_verdict":
            if (spinnerActive) {
              spinner.stop();
              spinnerActive = false;
            }
            {
              const icon = event.verdict.isComplete ? green("✓") : yellow("✗");
              console.log(`  ${icon} ${bold(event.verdict.judgeName)}: ${event.verdict.reasoning}`);
            }
            break;

          case "eval_complete":
            if (spinnerActive) {
              spinner.stop();
              spinnerActive = false;
            }
            if (event.passed) {
              console.log(`\n${green("✅")} ${bold("Eval passed")} — majority of judges approved (round ${event.round})`);
            } else {
              console.log(`\n${yellow("🔄")} ${bold("Eval failed")} — refining (round ${event.round}/${MAX_EVAL_ROUNDS})…`);
            }
            break;

          case "error":
            if (spinnerActive) {
              spinner.stop();
              spinnerActive = false;
            }
            console.error(`\n${formatError(event.error)}`);
            break;
        }
      }

      console.log(); // newline after assistant response

      // Show status bar after each turn
      const turnDuration = performance.now() - turnStart;
      // Include system prompt length for consistency with /status, /tokens,
      // /compact, and the auto-compaction threshold check below (line ~1960).
      // Without this, the status bar after each turn shows a lower token count
      // than /status does — confusing when the user runs /status immediately
      // after a turn and sees a different number. The auto-compaction check
      // below recomputes with systemPromptLength anyway, so this also avoids
      // a misleading gap where the status bar says "145K tokens" but auto-
      // compaction fires because the real count (with system prompt) is 161K.
      const turnSystemPrompt = getSystemPrompt(context.cwd);
      tokens = estimateTokens(messages, turnSystemPrompt.length);
      console.log(
        renderStatusBar(tokens, messages.length, config.model, turnDuration, {
          inputTokens: session.totalInputTokens,
          outputTokens: session.totalOutputTokens,
        }, config.compactionThreshold, computeSessionCost(session, config.model))
      );
    } catch (err: unknown) {
      spinner.stop();
      console.error(`\n${formatError(err)}`);
      // Ensure token count is computed even on error — the loop may have
      // added messages before failing, and skipping auto-compaction here
      // could let the context grow unboundedly across subsequent turns.
      // Include system prompt length for consistency with the try block above
      // (line ~1918) and the post-microCompact recomputation below (line ~1968).
      // Without it, the error-path tokens value is lower than the threshold
      // check expects, potentially skipping a needed auto-compaction after
      // an error in a large conversation.
      tokens = estimateTokens(messages, getSystemPrompt(context.cwd).length);
    }

    // Repair orphaned tool_use blocks. When the user aborts mid-turn
    // (Ctrl+C), the assistant message with tool_use blocks may already be
    // in `messages` but the matching tool_result user message was never
    // added. Without this repair, the next API call would fail because
    // the Anthropic API requires every tool_use to have a tool_result.
    repairOrphanedToolUse(messages);

    // Auto-save BEFORE micro-compaction. microCompact mutates tool_result
    // blocks in-place, replacing large results with "[Result truncated]"
    // placeholders. If we save after micro-compaction, the session file
    // contains the truncated content — when the user later does `/resume`,
    // the original tool results are permanently lost. By saving first,
    // the session file preserves the full tool outputs.
    // Pass the already-computed `tokens` to avoid a redundant full scan of
    // the message array (estimateTokens iterates every message and block).
    if (shouldAutoSave(replState)) {
      autoSaveSession(replState, tokens);
    }

    // Micro-compact after each turn (mutates messages in-place, truncating
    // large tool results beyond the 3 most recent).
    microCompact(messages);

    // Recompute tokens after micro-compaction — the in-place truncation may
    // have reduced the token count below the compaction threshold.  Using
    // the stale pre-microCompact `tokens` value would trigger an unnecessary
    // API call to the summarization model.
    //
    // Include the system prompt length to match what the API actually sees.
    // The system prompt (~400–2000 chars ≈ 100–500 tokens) is sent with every
    // API call but is NOT part of the messages array, so omitting it here
    // would systematically undercount by that amount — potentially delaying
    // auto-compaction past the point where the API rejects the request with
    // "context too long". The same systemPromptLength parameter is used inside
    // autoCompact() for the same reason.
    const systemPromptText = getSystemPrompt(context.cwd);
    tokens = estimateTokens(messages, systemPromptText.length);

    // Auto-compact if the (now-accurate) token count still exceeds threshold.
    // Skip if auto-compaction was recently suppressed (savings < 10%) and the
    // conversation hasn't grown enough to justify another attempt. Without this,
    // a failed compaction triggers re-compaction on every subsequent turn —
    // wasting an API call each time and printing the same warning repeatedly.
    const MIN_NEW_MESSAGES_AFTER_SUPPRESS = 4; // ~2 user/assistant exchanges
    const suppressionActive = replState.autoCompactSuppressedAt !== null &&
      (messages.length - replState.autoCompactSuppressedAt) < MIN_NEW_MESSAGES_AFTER_SUPPRESS;

    if (tokens > config.compactionThreshold && !suppressionActive) {
      printInfo(
        `Context is large (~${tokens.toLocaleString()} tokens). Auto-compacting…`
      );
      const autoCompactSpinner = new Spinner("Auto-compacting…");
      autoCompactSpinner.start();
      let compacted: Message[];
      try {
        compacted = await autoCompact(messages, systemPromptText, context.abortController.signal);
      } finally {
        autoCompactSpinner.stop();
      }
      if (compacted !== messages) {
        messages.length = 0;
        messages.push(...compacted);
        // Compaction can leave orphaned tool_use blocks: the compacted messages
        // may end with an assistant message containing tool_use blocks whose
        // corresponding user tool_result messages were in the summarized
        // (discarded) portion.  sanitizeMessageSlice strips orphaned
        // tool_result blocks but does NOT strip orphaned tool_use blocks,
        // so the next API call would fail with "every tool_use must have a
        // corresponding tool_result".  repairOrphanedToolUse adds synthetic
        // "Aborted by user" tool_result entries for any unmatched tool_use.
        repairOrphanedToolUse(messages);
        // Include systemPromptText.length to match the estimateTokens call
        // above (line ~1923) and the one inside autoCompact(). Without it,
        // the post-compaction token estimate is systematically low by
        // ~100–500 tokens (the system prompt's contribution), which:
        //   (a) displays an inaccurate "Auto-compacted: ~N tokens" count
        //       that doesn't match what the API actually sees, and
        //   (b) makes the threshold comparison below (tokensAfter >
        //       compactionThreshold) too lenient — it may decide tokens are
        //       below threshold when the real count (with system prompt)
        //       still exceeds it, clearing the suppression flag and allowing
        //       a wasteful re-compaction on the next turn.
        const tokensAfter = estimateTokens(messages, systemPromptText.length);
        printSuccess(
          "Auto-compacted",
          `~${tokensAfter.toLocaleString()} tokens`
        );
        // If the compacted token count STILL exceeds the threshold (the summary
        // is inherently large for a complex conversation), set the suppression
        // flag despite the compaction being "successful". Without this, the next
        // turn's auto-compaction check immediately re-triggers — calling the
        // summarization API again on the already-compacted result. The second
        // compaction will compress the summary further (often losing important
        // details), and if its savings are < 10%, the autoCompact() guard kicks
        // in and returns the original — but only after making a wasted API call.
        // By suppressing here, we wait for MIN_NEW_MESSAGES_AFTER_SUPPRESS new
        // messages before retrying, giving the conversation enough new content
        // to justify re-compaction.
        if (tokensAfter > config.compactionThreshold) {
          replState.autoCompactSuppressedAt = messages.length;
        } else {
          // Successful compaction that brought tokens below threshold: clear the
          // suppression flag so future auto-compaction attempts are not blocked.
          replState.autoCompactSuppressedAt = null;
        }
      } else {
        // autoCompact returned the same reference — compaction was skipped
        // (either savings < 10% or too few messages). Set the suppression
        // flag to prevent re-triggering on the next turn.
        replState.autoCompactSuppressedAt = messages.length;
      }
    }

    rl.prompt();
  }

  // REPL ended (stdin closed) — auto-save and print resume hint
  try { autoSaveSession(replState); } catch { /* best-effort */ }
  if (replState.messages.length > 0) {
    console.log(`\n${dim("Session saved.")}`);
    printResumeHint(replState.sessionId);
  }
}

async function runOnce(
  prompt: string,
  messages: Message[],
  tools: ReturnType<typeof getAllTools>,
  context: ToolContext,
  enableEval?: boolean
) {
  messages.push({ role: "user", content: prompt });

  // Handle Ctrl+C in non-interactive mode. Without this, pressing Ctrl+C
  // kills the process immediately via the default SIGINT handler, which can
  // leave orphaned child processes (bash commands, sub-agents) running.
  // By wiring SIGINT to the context's abort controller, we gracefully cancel
  // in-flight API calls and tool executions, matching the REPL's behavior.
  const sigintHandler = () => {
    context.abortController.abort();
    // Restore default SIGINT handling so a second Ctrl+C force-kills
    process.removeListener("SIGINT", sigintHandler);
  };
  process.on("SIGINT", sigintHandler);

  // Handle SIGTERM in non-interactive mode. In CI/container environments,
  // SIGTERM is the standard graceful shutdown signal (e.g., `docker stop`,
  // Kubernetes pod eviction, systemd `TimeoutStopSec`). Without this handler,
  // SIGTERM uses Node.js's default behavior (immediate exit with code 143),
  // which skips all cleanup — in-flight API calls continue consuming credits,
  // orphaned bash/sub-agent child processes keep running, and the final status
  // bar summary is never printed. By wiring SIGTERM to the abort controller
  // (same as SIGINT), we gracefully cancel all in-flight work and let the
  // finally block and post-loop cleanup run.
  const sigtermHandler = () => {
    context.abortController.abort();
    // Remove the handler so a second SIGTERM uses the default behavior
    // (immediate exit). This matches the SIGINT pattern above.
    process.removeListener("SIGTERM", sigtermHandler);
  };
  process.on("SIGTERM", sigtermHandler);

  const spinner = new Spinner("Thinking…");
  let spinnerActive = false;
  /** Track whether any errors occurred so we can set a non-zero exit code. */
  let hadError = false;
  /** Track cumulative API token usage so non-interactive users can see costs. */
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalApiDurationMs = 0;

  // ── Markdown streaming state (same as REPL path) ──
  const mdEnabled = isMarkdownEnabled();
  let assistantTextBuffer = "";
  let streamedCharCount = 0;

  function flushMarkdown(): void {
    if (!mdEnabled || !assistantTextBuffer) return;
    if (streamedCharCount > 0) {
      const cols = process.stdout.columns || 80;
      const rawLines = assistantTextBuffer.split("\n");
      let totalRows = 0;
      for (const line of rawLines) {
        totalRows += Math.max(1, Math.ceil((line.length || 1) / cols));
      }
      if (totalRows > 0) {
        const upCount = totalRows - 1;
        let eraseSeq = "\r";
        if (upCount > 0) {
          eraseSeq += `\x1b[${upCount}A`;
        }
        eraseSeq += "\x1b[0J";
        process.stdout.write(eraseSeq);
      }
    }
    const rendered = renderMarkdown(assistantTextBuffer);
    process.stdout.write(rendered);
    assistantTextBuffer = "";
    streamedCharCount = 0;
  }

  try {
    for await (const event of agenticLoop(
      messages,
      getSystemPrompt(context.cwd),
      tools,
      context,
      undefined, // model — use default
      undefined, // maxTurns — use default
      enableEval
    )) {
      switch (event.type) {
        case "api_call_start":
          spinner.start();
          spinnerActive = true;
          break;

        case "api_call_end":
          if (spinnerActive) {
            spinner.stop();
            spinnerActive = false;
          }
          totalApiDurationMs += event.durationMs;
          if (event.usage) {
            totalInputTokens += event.usage.inputTokens;
            totalOutputTokens += event.usage.outputTokens;
          }
          break;

        case "assistant_text":
          if (spinnerActive) {
            spinner.stop();
            spinnerActive = false;
          }
          process.stdout.write(event.text);
          if (mdEnabled) {
            assistantTextBuffer += event.text;
            streamedCharCount += event.text.length;
          }
          break;

        case "tool_use":
          if (spinnerActive) {
            spinner.stop();
            spinnerActive = false;
          }
          flushMarkdown();
          console.log(`\n${formatToolUse(event.toolName, event.input)}`);
          // Show a spinner while the tool runs so the user sees activity
          // during long-running commands (e.g., a 30-second bash build).
          // Previously non-interactive mode showed no visual feedback between
          // tool_use and tool_result, making it appear as if the process
          // had hung — matching the interactive REPL's spinner behavior.
          spinner.update(`Running ${event.toolName}…`);
          spinner.start();
          spinnerActive = true;
          break;

        case "tool_result":
          if (spinnerActive) {
            spinner.stop();
            spinnerActive = false;
          }
          // Show tool results (both successes and errors) so non-interactive
          // users (`-p` flag) can see what tools did during the run.
          // Use formatToolResult for both cases to preserve the tool name
          // and duration context — previously errors used formatError which
          // discarded this information.
          console.log(
            formatToolResult(
              event.toolName,
              event.result.content,
              event.durationMs,
              event.result.is_error
            )
          );
          break;

        case "error":
          if (spinnerActive) {
            spinner.stop();
            spinnerActive = false;
          }
          console.error(formatError(event.error));
          hadError = true;
          break;

        case "turn_complete":
          if (spinnerActive) {
            spinner.stop();
            spinnerActive = false;
          }
          flushMarkdown();
          // Note: max_tokens and content_filter warnings are already emitted
          // by loop.ts via printWarning() when it detects the stop_reason.
          // Previously, this handler had an additional max_tokens warning that
          // duplicated loop.ts's — non-interactive users saw the same message
          // twice with slightly different wording. The interactive REPL's
          // turn_complete handler already avoids this (see its note on the same
          // topic). Warnings about stop_reason are now exclusively in loop.ts,
          // which fires closer to the event and covers both REPL and runOnce.
          break;

        case "eval_start":
          if (spinnerActive) {
            spinner.stop();
            spinnerActive = false;
          }
          console.log(`\n${bold(`🔍 Eval round ${event.round}/${MAX_EVAL_ROUNDS}`)} — ${event.judgeCount} judges evaluating…`);
          spinner.update("Evaluating…");
          spinner.start();
          spinnerActive = true;
          break;

        case "eval_judge_verdict":
          if (spinnerActive) {
            spinner.stop();
            spinnerActive = false;
          }
          {
            const icon = event.verdict.isComplete ? green("✓") : yellow("✗");
            console.log(`  ${icon} ${bold(event.verdict.judgeName)}: ${event.verdict.reasoning}`);
          }
          break;

        case "eval_complete":
          if (spinnerActive) {
            spinner.stop();
            spinnerActive = false;
          }
          if (event.passed) {
            console.log(`\n${green("✅")} ${bold("Eval passed")} — majority of judges approved (round ${event.round})`);
          } else {
            console.log(`\n${yellow("🔄")} ${bold("Eval failed")} — refining (round ${event.round}/${MAX_EVAL_ROUNDS})…`);
          }
          break;

        default:
          break;
      }
    }
  } finally {
    // Clean up signal handlers so they don't leak if runOnce is called
    // multiple times (e.g., in tests) or interfere with other process logic.
    process.removeListener("SIGINT", sigintHandler);
    process.removeListener("SIGTERM", sigtermHandler);
    if (spinnerActive) {
      spinner.stop();
    }
  }
  console.log();

  // Show a status bar summary after the run so non-interactive users (CI,
  // pipelines) can see how many API tokens were consumed — critical for cost
  // tracking. The interactive REPL shows this after every turn, but runOnce
  // previously had no token usage feedback at all. Only show if there was
  // actual API usage (totalInputTokens or totalOutputTokens > 0) to avoid
  // noise on runs that errored before any API call was made.
  if (totalInputTokens > 0 || totalOutputTokens > 0) {
    const config = getConfig();
    const tokens = estimateTokens(messages, getSystemPrompt(context.cwd).length);
    const cost = estimateApiCost(totalInputTokens, totalOutputTokens, config.model);
    console.log(
      renderStatusBar(tokens, messages.length, config.model, totalApiDurationMs, {
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      }, config.compactionThreshold, cost)
    );
  }

  // Post-loop cleanup — mirror the interactive REPL's behavior.
  // Without this, a long-running `-p` prompt with many tool calls could
  // leave orphaned tool_use blocks (if aborted) and never compact the
  // context, which matters if callers chain multiple runOnce invocations
  // or resume the session later.
  repairOrphanedToolUse(messages);
  microCompact(messages);

  // Auto-compact if context grew too large during the agentic loop.
  // The interactive REPL does this after each turn, but `runOnce` previously
  // skipped it entirely.  Without this, a long-running `-p` prompt with many
  // tool calls (up to 100 turns) can accumulate enough context to exceed the
  // API's context limit, causing the request to fail with a "context too long"
  // error.  This is especially important for CI/pipeline usage where the prompt
  // may trigger extensive multi-file exploration.  Only compact if not aborted
  // (the compaction API call requires a live signal).
  if (!context.abortController.signal.aborted) {
    const config = getConfig();
    // Include the system prompt length in the token estimate to match what the
    // API actually sees — the system prompt is sent with every API call but is
    // not part of the messages array, so omitting it would systematically
    // undercount by ~100–500 tokens. Same fix applied to the interactive REPL
    // auto-compaction path above.
    const sysPrompt = getSystemPrompt(context.cwd);
    const tokens = estimateTokens(messages, sysPrompt.length);
    if (tokens > config.compactionThreshold) {
      const compactSpinner = new Spinner("Auto-compacting…");
      compactSpinner.start();
      try {
        const compacted = await autoCompact(
          messages,
          sysPrompt,
          context.abortController.signal
        );
        if (compacted !== messages) {
          messages.length = 0;
          messages.push(...compacted);
          // Repair orphaned tool_use blocks left by compaction, matching the
          // interactive REPL's auto-compact behavior (see line ~1279).
          repairOrphanedToolUse(messages);
          // Include sysPrompt.length for consistency with the pre-compaction
          // estimate (line ~2206) and the interactive REPL's post-compaction
          // estimate. Without it, the displayed token count is systematically
          // ~100–500 tokens lower than reality.
          const tokensAfter = estimateTokens(messages, sysPrompt.length);
          printSuccess(
            "Auto-compacted",
            `~${tokensAfter.toLocaleString()} tokens`
          );
        }
      } catch {
        // Best-effort — compaction failure in non-interactive mode is not
        // critical since the process is about to exit anyway.
      } finally {
        compactSpinner.stop();
      }
    }
  }

  // Set non-zero exit code so non-interactive callers (CI scripts,
  // pipelines) can detect that something went wrong. Without this,
  // `echo "fix bugs" | codingagent -p "..."` always exits 0 even
  // when the API returns an error or the model hits max turns.
  if (hadError) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(formatError(err));
  process.exit(1);
});
