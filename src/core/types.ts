import Anthropic from "@anthropic-ai/sdk";

// ── Message types ──

export type Role = "user" | "assistant";

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content: string | Array<{ type: "text"; text: string }>;
  is_error?: boolean;
}

/**
 * Extended thinking block from Anthropic's extended thinking API.
 * Contains the model's chain-of-thought reasoning.
 *
 * The `signature` field is an opaque string used by the API to verify
 * the integrity of thinking blocks. It MUST be preserved and echoed
 * back in subsequent API calls — omitting it causes a 400 error.
 */
export interface ThinkingBlock {
  type: "thinking";
  thinking: string;
  signature: string;
}

/**
 * Redacted thinking block — the model's thinking was present but was
 * redacted by the API (e.g., for safety or policy reasons). These have
 * no user-visible text content but occupy tokens in the context.
 */
export interface RedactedThinkingBlock {
  type: "redacted_thinking";
  data: string;
}

export interface ImageBlock {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | RedactedThinkingBlock | ImageBlock;

export interface Message {
  role: Role;
  content: string | ContentBlock[];
}

// ── Tool system ──

export interface ToolInput {
  [key: string]: unknown;
}

export interface ToolResult {
  content: string;
  is_error?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  inputSchema: Anthropic.Tool["input_schema"];
  isConcurrencySafe: boolean;
  execute(input: ToolInput, context: ToolContext): Promise<ToolResult>;
}

// ── Context ──

export interface FileState {
  timestamp: number;
}

export interface ReadFileState {
  get(path: string): FileState | undefined;
  set(path: string, state: FileState): void;
  has(path: string): boolean;
  delete(path: string): boolean;
  clone(): ReadFileState;
  /** Remove all entries from the cache. */
  clear(): void;
}

/**
 * Exploration cache interface for caching read-only tool results.
 * See explore-cache.ts for the full implementation.
 */
export interface ExploreCache {
  get(toolName: string, input: Record<string, unknown>, cwd: string): ToolResult | undefined;
  set(toolName: string, input: Record<string, unknown>, cwd: string, result: ToolResult, metadata?: { filePath?: string; fileMtimeMs?: number; searchScope?: string }): void;
  invalidateFile(modifiedPath: string): void;
  invalidateDirectory(directory: string): void;
  clear(): void;
  clone(): ExploreCache;
  getStats(): { hits: number; misses: number; invalidations: number; evictions: number; size: number };
  resetStats(): void;
  /**
   * Serialize the cache contents to a plain object for session persistence.
   * Only includes Read entries (mtime-validated) — Glob/Grep entries use
   * short TTLs that would expire before the session is resumed.
   */
  serialize(): SerializedExploreCache;
  /**
   * Restore cache entries from a previously serialized snapshot.
   * Entries are validated against current file mtimes on restore — stale
   * entries (where the file was modified since the session was saved) are
   * silently discarded.
   */
  restore(data: SerializedExploreCache): void;
}

/**
 * Serialized form of the explore cache, suitable for JSON persistence.
 * Only Read entries are persisted — Glob/Grep results have short TTLs
 * (30s default) that would be expired by the time a session is resumed.
 */
export interface SerializedExploreCacheEntry {
  key: string;
  result: ToolResult;
  createdAt: number;
  toolName: string;
  filePath?: string;
  fileMtimeMs?: number;
}

export interface SerializedExploreCache {
  version: 1;
  entries: SerializedExploreCacheEntry[];
}

export interface ToolContext {
  readFileState: ReadFileState;
  abortController: AbortController;
  agentId: string;
  depth: number;
  cwd: string;
  /** Exploration cache for reusing previous read-only tool results. */
  exploreCache?: ExploreCache;
  spawnAgent?: (
    prompt: string,
    options: SpawnAgentOptions
  ) => Promise<AgentResult>;
}

export type SubagentType = "Explore" | "Plan" | "Bash" | "general-purpose";

/** All valid SubagentType values as a tuple for runtime validation. */
export const SUBAGENT_TYPES: readonly SubagentType[] = ["Explore", "Plan", "Bash", "general-purpose"];

/**
 * Type guard: narrows an unknown string to SubagentType.
 *
 * Replaces the previous pattern of `VALID_TYPES.includes(x) + as SubagentType`
 * which doesn't narrow the type because `Array.prototype.includes` on
 * `readonly string[]` doesn't establish a type relationship. With this guard,
 * `if (isSubagentType(x)) { x }` gives `x: SubagentType` without an unsafe cast.
 */
export function isSubagentType(value: string): value is SubagentType {
  return (SUBAGENT_TYPES as readonly string[]).includes(value);
}

/** Maximum nesting depth for sub-agent spawning. */
export const MAX_AGENT_DEPTH = 5;

export interface SpawnAgentOptions {
  subagentType?: SubagentType;
  model?: string;
  runInBackground?: boolean;
  maxTurns?: number;
  description?: string;
}

export interface AgentResult {
  result: string;
  agentId: string;
  outputFile?: string;
}

// ── Streaming tool executor ──

export type ToolExecutionState =
  | "queued"
  | "executing"
  | "completed"
  | "yielded";

export interface ToolExecution {
  id: string;
  toolName: string;
  input: Record<string, unknown>;
  state: ToolExecutionState;
  result?: ToolResult;
  error?: Error;
  isConcurrencySafe: boolean;
  /** Resolved tool reference, cached at queue time to avoid a second lookup. */
  tool: Tool | undefined;
  durationMs?: number;
}

// ── Agent system ──

export interface AgentDefinition {
  name: string;
  model?: string;
  tools: string[];
  systemPrompt: string;
  description: string;
}

// ── Config ──

export interface AppConfig {
  baseUrl: string;
  model: string;
  smallModel: string;
  compactionThreshold: number;
  maxOutputTokens: number;
  /**
   * API key sourced from settings.json `env.ANTHROPIC_API_KEY` or
   * `process.env.ANTHROPIC_API_KEY`, with the settings.json value taking
   * priority (matching the precedence used for all other config values).
   * `undefined` when neither source provides a key.
   */
  apiKey: string | undefined;
  /**
   * When true, all LLM interactions (prompts, responses, tool calls) are
   * logged to a JSONL file under `~/.claude/debug/`. Enable via:
   *   - `CODINGAGENT_DEBUG=1` environment variable or settings.json
   *   - `/debug` REPL command (toggles at runtime)
   */
  debug: boolean;
  /**
   * When true, skip the streaming API (`client.messages.stream()`) and call
   * the non-streaming API (`client.messages.create()`) directly.
   *
   * Useful when:
   *   - Behind a reverse proxy that doesn't support SSE / chunked transfer
   *   - The Anthropic streaming endpoint is unreliable in the user's network
   *   - Integration testing with a mock server that only serves JSON
   *
   * Enable via `ANTHROPIC_DISABLE_STREAMING=1` environment variable or
   * settings.json `env.ANTHROPIC_DISABLE_STREAMING`.
   *
   * When disabled, `callStreamingApi()` in `loop.ts` calls
   * `client.messages.create()` directly and synthesizes the same
   * `StreamResult` shape, firing `onTextDelta` and `onToolUse` callbacks
   * from the non-streaming response. Real-time text streaming is lost,
   * but tool execution still benefits from the `onToolUse` callback
   * (each tool starts as soon as the response is parsed).
   */
  disableStreaming: boolean;
  /**
   * Additional directories to load SKILL.md files from, beyond the built-in
   * defaults (`~/.claude/skills` and `.claude/skills` which are always loaded).
   *
   * Supports absolute paths, paths with `~` (expanded to the user's home
   * directory), and relative paths (resolved against the current working
   * directory).
   *
   * Empty array (`[]`) when not configured — only the built-in defaults are
   * used.
   *
   * Configure via `"skillDirs"` in `~/.claude/settings.json`:
   * ```json
   * {
   *   "skillDirs": ["/shared/team-skills", "C:\\company\\prompts"]
   * }
   * ```
   *
   * These directories are searched after the built-in defaults, so they
   * take precedence when skill names collide.
   */
  skillDirs: string[];
}

// ── Loop yields ──

/**
 * Stop reason returned by the Anthropic API when the model finishes
 * generating a response. Typed as a specific union rather than `string`
 * so consumers can discriminate on the reason without unsafe casts.
 *
 * - `"end_turn"`: Normal completion — the model decided to stop.
 * - `"max_tokens"`: Response was truncated due to output token limit.
 * - `"stop_sequence"`: A stop sequence was hit (rarely used with tool APIs).
 * - `"tool_use"`: The model emitted tool_use blocks (loop continues).
 * - `"content_filter"`: The safety system intervened mid-response.
 *   The Anthropic SDK's type union may not include this value yet, but
 *   the API can return it at runtime. Including it here removes the need
 *   for `as string` casts at comparison sites (previously required in
 *   loop.ts line ~655).
 *
 * The SDK may introduce additional stop reasons in the future, so we
 * include a `string` fallback to avoid breaking at runtime. Consumers
 * should handle the known values and treat unknown strings as informational.
 */
export type StopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use" | "content_filter" | (string & {});

/**
 * Verdict from a single eval judge. Mirrors `JudgeVerdict` from eval.ts
 * but defined here to avoid circular imports (types.ts is the leaf of
 * the import graph).
 */
export interface EvalJudgeVerdictInfo {
  judgeName: string;
  isComplete: boolean;
  reasoning: string;
}

export type LoopYield =
  | { type: "assistant_text"; text: string }
  | { type: "tool_use"; toolName: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolName: string; result: ToolResult; durationMs?: number }
  | { type: "turn_complete"; stopReason: StopReason }
  | { type: "error"; error: string }
  | { type: "api_call_start" }
  | { type: "api_call_end"; durationMs: number; usage?: { inputTokens: number; outputTokens: number } }
  | { type: "eval_start"; round: number; judgeCount: number }
  | { type: "eval_judge_verdict"; verdict: EvalJudgeVerdictInfo; round: number }
  | { type: "eval_complete"; passed: boolean; round: number; refinementPrompt?: string };
