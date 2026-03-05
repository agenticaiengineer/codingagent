# CodingAgent — Internal Architecture

> Comprehensive architecture documentation for the CodingAgent codebase.
> For contributors and developers working on or extending the project.

---

## Table of Contents

1. [Package Structure](#1-package-structure)
2. [High-Level Architecture](#2-high-level-architecture)
3. [The Agentic Loop](#3-the-agentic-loop)
4. [Tool System](#4-tool-system)
5. [Parallel Tool Execution](#5-parallel-tool-execution-streamingtoolexecutor)
6. [Agent / Sub-Agent System](#6-agent--sub-agent-system)
7. [Context Management](#7-context-management)
8. [Exploration Cache](#8-exploration-cache)
9. [Session Persistence](#9-session-persistence)
10. [Configuration](#10-configuration)
11. [Skills & Project Memory](#11-skills--project-memory)
12. [MCP Integration](#12-mcp-model-context-protocol-integration)
13. [Multi-Judge Eval Gate](#13-multi-judge-eval-gate)
14. [Multi-Transport Gateway](#14-multi-transport-gateway)
15. [Debug System](#15-debug-system)
16. [Terminal UI](#16-terminal-ui)

---

## 1. Package Structure

```
codingagent/
├── package.json                       # ESM TypeScript, @anthropic-ai/sdk + glob + diff deps
├── tsconfig.json                      # ES2022, NodeNext module, strict mode
│
├── src/
│   ├── index.ts                       # Entry point: CLI args, REPL, command handlers, system prompt
│   │
│   ├── core/                          # Core agent engine
│   │   ├── types.ts                   # Foundational types (Message, Tool, ToolContext, LoopYield, etc.)
│   │   ├── client.ts                  # Anthropic SDK client singleton
│   │   ├── context.ts                 # ToolContext creation (createContext) + sub-agent cloning (cloneContext)
│   │   ├── loop.ts                    # Core agentic loop (agenticLoop async generator)
│   │   ├── agent.ts                   # Sub-agent spawning, built-in agent definitions, background agent registry
│   │   ├── compaction.ts              # Token estimation, micro-compaction, auto-compaction, orphan repair
│   │   ├── streaming-executor.ts      # StreamingToolExecutor: parallel tool execution with barrier semantics
│   │   ├── mcp-client.ts             # MCP server connections (stdio/HTTP), tool discovery, JSON-RPC 2.0
│   │   └── debug.ts                   # Debug logging (JSONL to ~/.codingagent/sessions/<id>/debug/)
│   │
│   ├── config/                        # Configuration & skill loading
│   │   ├── config.ts                  # Config loading from env + ~/.claude/settings.json
│   │   ├── env.ts                     # .env file loading and environment bootstrapping
│   │   └── skills.ts                  # Skill/memory file loading (Claude, Copilot, Codex, Gemini)
│   │
│   ├── tools/                         # Built-in tool implementations
│   │   ├── index.ts                   # Tool registry: 12 built-in tools + MCP tool registration
│   │   ├── read.ts                    # File read with line numbers, offset/limit, image support
│   │   ├── write.ts                   # Atomic file writes with directory creation
│   │   ├── edit.ts                    # Exact string replacement with diff preview
│   │   ├── glob.ts                    # File pattern matching (sorted by mtime)
│   │   ├── grep.ts                    # ripgrep-based search (regex, file types, context lines)
│   │   ├── bash.ts                    # Shell command execution with timeout + env sanitization
│   │   ├── task.ts                    # Sub-agent spawning tool
│   │   ├── web.ts                     # WebFetch + WebSearch (DuckDuckGo)
│   │   ├── open.ts                    # Open files/URLs in native apps
│   │   ├── transcribe.ts             # Audio transcription
│   │   ├── browser.ts                # Playwright-based browser automation
│   │   ├── validate.ts                # Input validation helpers (safeTruncate, hasErrnoCode, etc.)
│   │   └── fs-utils.ts               # Atomic file replacement utility
│   │
│   ├── ports/                         # Transport I/O abstractions
│   │   ├── io-port.ts                 # IOPort interface (InputPort + OutputPort), LoopYield routing
│   │   ├── terminal-port.ts           # Terminal stdin/stdout IOPort adapter
│   │   ├── telegram-port.ts           # Telegram Bot API IOPort adapter
│   │   └── teams-port.ts             # Microsoft Teams IOPort adapter
│   │
│   ├── session/                       # Session persistence & runner
│   │   ├── session.ts                 # Save/load sessions to ~/.codingagent/sessions/
│   │   └── session-runner.ts          # Transport-agnostic session loop driver
│   │
│   ├── eval/                          # Work quality evaluation
│   │   └── eval.ts                    # Multi-judge eval gate (correctness, completeness, goal alignment)
│   │
│   ├── ui/                            # Terminal UI & REPL
│   │   ├── ui.ts                      # Colors, spinners, OutputManager, formatters
│   │   ├── markdown.ts                # Markdown rendering for terminal output
│   │   ├── commands.ts                # REPL slash-command registry & metadata
│   │   └── frecency.ts               # Command usage frequency × recency tracker
│   │
│   ├── utils/                         # Shared utilities
│   │   ├── retry.ts                   # Retry/backoff, abort-aware sleep, signal combiners
│   │   └── explore-cache.ts           # LRU exploration cache with mtime/TTL invalidation
│   │
│   ├── gateway/                       # Multi-transport gateway
│   │   ├── gateway.ts                 # Gateway host process (manages transports + worker)
│   │   ├── ipc-protocol.ts            # IPC message types (host ↔ worker)
│   │   └── agent-worker.ts            # Forked child process running the agent
│   │
│   └── scripts/                       # Standalone entry points
│       ├── telegram.ts                # Telegram bot entry point
│       └── teams.ts                   # Teams bot entry point
│
├── self-improve.ts                    # Meta-agent self-improvement loop
└── dist/                              # Compiled output (mirrors src/ structure)
```

**Key design decisions:**
- ESM module system (`"type": "module"` in package.json)
- TypeScript with strict mode, compiled via `tsc` and run via `tsx` in development
- Requires Node.js >= 18
- `@anthropic-ai/sdk` as the primary API client dependency
- `diff`, `glob`, `marked`, `ansi-diff` for file operations and terminal rendering
- I/O port abstraction enables multiple transports (terminal, Telegram, Teams) with the same core

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Entry Points                                 │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────────────┐      │
│  │ src/index.ts │  │ gateway.ts   │  │ session-runner.ts │      │
│  │ (CLI + REPL) │  │ (multi-port) │  │ (transport-agnostic)│    │
│  └──────┬───────┘  └──────┬───────┘  └───────┬───────────┘      │
│         │                 │                   │                  │
│  ┌──────▼─────────────────▼───────────────────▼──────────────┐  │
│  │                    Agentic Loop (loop.ts)                  │  │
│  │  ┌─────────────────────────────────────────────────────┐  │  │
│  │  │  Compaction → API Stream → Tool Execution → Results │  │  │
│  │  │       ↑                              │              │  │  │
│  │  │       └──────── Tool Results ────────┘              │  │  │
│  │  └─────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────┘   │
│         │                                                       │
│  ┌──────▼───────────────────────────────────────────────────┐   │
│  │                      Tool System                          │   │
│  │  ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────────────┐   │   │
│  │  │ Read │ │ Write│ │ Bash │ │ Grep │ │ Task (Agent) │   │   │
│  │  │ Edit │ │ Glob │ │ Web* │ │ Open │ │ Browser/MCP  │   │   │
│  │  └──────┘ └──────┘ └──────┘ └──────┘ └──────┬───────┘   │   │
│  └───────────────────────────────────────────┬──────────┘       │
│                                              │                  │
│  ┌───────────────────────────────────────────▼──────────┐       │
│  │                 Sub-Agent System (agent.ts)            │       │
│  │  Each sub-agent receives:                             │       │
│  │  - Cloned context (readFileState, exploreCache)       │       │
│  │  - Child AbortController (linked to parent)           │       │
│  │  - Independent message history                        │       │
│  │  - Filtered tool set per agent type                   │       │
│  └──────────────────────────────────────────────────────┘       │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  Infrastructure                           │   │
│  │  API Client │ Config │ Explore Cache │ Session Store      │   │
│  │  Compaction │ Skills │ MCP Client    │ Debug Logger       │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

The system is built around a **recursive agentic loop** pattern. The entry point gathers user input, builds a system prompt enriched with project memory and skill descriptions, and delegates to `agenticLoop()` — an async generator that calls the Claude API, extracts `tool_use` blocks from the streamed response, executes them (potentially in parallel), feeds the results back, and loops until the model produces a final response with no tool calls.

---

## 3. The Agentic Loop

**File:** `src/core/loop.ts` — `agenticLoop()` async generator

The core loop is a single async generator function that drives all agent execution. Both the main REPL and sub-agents call it.

```
User prompt
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  while (turnCount < effectiveMaxTurns) {                    │
│    1. Repair orphaned tool_use/tool_result blocks           │
│       (repairOrphanedToolUse — handles Ctrl+C, compaction)  │
│                                                             │
│    2. Stream API call via callStreamingApi()                 │
│       ├─ callWithRetry() wraps with 3 retries + backoff     │
│       ├─ Streaming path: client.messages.stream()           │
│       │   └─ Falls back to non-streaming on stream errors   │
│       └─ Non-streaming path: client.messages.create()       │
│          (when ANTHROPIC_DISABLE_STREAMING=1)               │
│                                                             │
│    3. As each tool_use block arrives from the stream:       │
│       onToolUse → addTool() on StreamingToolExecutor        │
│       (tools begin executing DURING streaming — §5)         │
│                                                             │
│    4. As text deltas arrive from the stream:                │
│       onTextDelta → pendingDeltas → yield assistant_text    │
│                                                             │
│    5. After stream completes:                               │
│       ├─ Build assistant message, push to messages[]        │
│       ├─ If no tool calls:                                  │
│       │   ├─ Warn on various stop_reasons                   │
│       │   ├─ yield turn_complete                            │
│       │   ├─ If eval enabled → run eval gate (§13)          │
│       │   │   ├─ Majority pass → return                     │
│       │   │   └─ Fail → inject refinement, continue loop    │
│       │   └─ return                                         │
│       │                                                     │
│       └─ If tool calls present:                             │
│           ├─ Cap at MAX_TOOL_CALLS_PER_TURN (50)            │
│           ├─ yield tool_use events for UI                   │
│           ├─ Collect results from executor.getRemainingResults()
│           ├─ Yield tool_result events                       │
│           ├─ Add synthetic errors for excess tool calls     │
│           ├─ Push user message with all tool_results        │
│           └─ continue loop                                  │
│  }                                                          │
└─────────────────────────────────────────────────────────────┘
    │
    ▼
"Maximum turns reached" error (if loop exhausted)
```

### 3.1. Streaming API Call

The `callStreamingApi()` function manages the API communication:

1. **Streaming path (default):** Uses `client.messages.stream()` with real-time event handlers:
   - `stream.on("text", ...)` → pushes to `pendingDeltas`
   - `stream.on("contentBlock", ...)` → fires `onToolUse` callback for `tool_use` blocks
   - If streaming fails, falls back to non-streaming

2. **Non-streaming path** (`config.disableStreaming`): Calls `client.messages.create()` directly, then fires the same callbacks from the complete response.

### 3.2. Retry Logic

`callWithRetry()` wraps API calls with exponential backoff:
- **3 retries** max, with **1s base delay** and **30s cap** (±25% jitter)
- **Non-retryable:** 400, 401, 403, 404 → throw immediately
- **Retryable:** 429, 529, 5xx, network errors → retry with backoff
- **Abort-aware:** Checks `signal.aborted` before each attempt; uses `abortableSleep()`

The non-streaming fallback has its own inner retry loop (2 retries) to avoid bouncing back to a streaming attempt on transient errors.

### 3.3. LoopYield Events

The generator yields typed events consumed by the UI or transport layer:

| Event | Description |
|-------|-------------|
| `assistant_text` | Text delta from the model |
| `tool_use` | A tool call was made |
| `tool_result` | A tool execution completed |
| `turn_complete` | Model finished a turn (includes `stopReason`) |
| `error` | Fatal error |
| `api_call_start` / `api_call_end` | API timing and usage |
| `eval_start` / `eval_judge_verdict` / `eval_complete` | Eval gate events |

---

## 4. Tool System

**File:** `src/tools/index.ts` — Tool registry and resolution

### 4.1. Tool Interface

```typescript
// src/core/types.ts
interface Tool {
  name: string;
  description: string;
  inputSchema: Anthropic.Tool["input_schema"];
  isConcurrencySafe: boolean;  // true → can run in parallel with other safe tools
  execute(input: ToolInput, context: ToolContext): Promise<ToolResult>;
}
```

### 4.2. Built-in Tools

| Tool | File | Concurrency-Safe | Description |
|------|------|:-:|-------------|
| **Read** | `tools/read.ts` | ✅ | File read with line numbers, offset/limit, image support |
| **Write** | `tools/write.ts` | ❌ | Atomic file creation/overwrite with directory creation |
| **Edit** | `tools/edit.ts` | ❌ | Exact string replacement (`old_string` → `new_string`) with diff preview |
| **Glob** | `tools/glob.ts` | ✅ | File pattern matching (results sorted by modification time) |
| **Grep** | `tools/grep.ts` | ✅ | ripgrep-based content search with regex, file type filters, context lines |
| **Bash** | `tools/bash.ts` | ❌ | Shell command execution with timeout, env sanitization |
| **Task** | `tools/task.ts` | ✅ | Sub-agent spawning (foreground or background) |
| **WebFetch** | `tools/web.ts` | ✅ | Fetch content from URLs |
| **WebSearch** | `tools/web.ts` | ✅ | DuckDuckGo web search |
| **Open** | `tools/open.ts` | ✅ | Open files/URLs in native applications |
| **Transcribe** | `tools/transcribe.ts` | ✅ | Audio transcription |
| **Browser** | `tools/browser.ts` | ❌ | Playwright-based browser automation |

### 4.3. Tool Registry

```typescript
// src/tools/index.ts
const allTools: Tool[] = [readTool, writeTool, editTool, ...];
const mcpTools: Tool[] = [];  // MCP tools registered at runtime

const toolMap = new Map<string, Tool>();      // Exact-case lookup
const toolMapCI = new Map<string, Tool>();    // Case-insensitive fallback

function findTool(name: string): Tool | undefined;  // Exact → case-insensitive
function resolveTools(allowed?, disallowed?): Tool[];  // Filter for sub-agents
function registerMcpTools(tools: Tool[]): void;  // Runtime MCP tool registration
function toolsToAnthropicFormat(tools): Anthropic.Tool[];  // Convert to API format
```

`findTool()` tries exact-case match first, then case-insensitive fallback — so model-generated names like `"read"` or `"BASH"` still resolve correctly.

`resolveTools()` filters the tool list for sub-agents. Agent definitions specify `tools: ["Read", "Glob", "Grep"]` to restrict available tools.

### 4.4. Read-Before-Write Guard

Both `Write` and `Edit` enforce a read-before-write invariant via `ReadFileState` (LRU cache, 500 entries in `src/core/context.ts`):

1. **Has the file been read?** — `readFileState.get(path)` must return a `FileState` entry
2. **Is it stale?** — Current `mtime` is compared against the saved timestamp
3. If either check fails → error message, model must re-read the file

This prevents blind overwrites and catches external modifications (linters, git hooks, user edits).

### 4.5. Atomic File Operations

Both `Write` and `Edit` use atomic writes (via `src/tools/fs-utils.ts`):
- Write to a temp file (`openSync("wx")`, exclusive create)
- `renameSync(tmp, target)` — atomic on same filesystem
- Fallback: copy + unlink for cross-filesystem moves (EXDEV)
- Symlink-aware: resolves to real path before replacing

---

## 5. Parallel Tool Execution (StreamingToolExecutor)

**File:** `src/core/streaming-executor.ts`

### 5.1. Class: `StreamingToolExecutor`

This is the key performance mechanism. Tools begin executing *during* the API response stream, not after.

As each `tool_use` content block arrives from the stream, `onToolUse` fires `addTool()` immediately. The executor's `processQueue()` starts eligible tools right away — file reads can complete before the model finishes generating subsequent tool calls.

### 5.2. Concurrency Rules

```
┌──────────────────────────────────────────────────────────────┐
│  CONCURRENCY DECISION TREE                                    │
│                                                              │
│  Is anything currently executing?                            │
│  ├── NO → Execute immediately (any tool)                     │
│  └── YES                                                     │
│       ├── Is the new tool concurrency-safe?                  │
│       │    ├── NO → WAIT (barrier — nothing else until done) │
│       │    └── YES                                           │
│       │         ├── Are ALL executing tools concurrency-safe?│
│       │         │    ├── YES → Execute in parallel            │
│       │         │    │   (up to MAX_CONCURRENT_SAFE = 8)     │
│       │         │    └── NO → WAIT                           │
│       └─────────────────────────────────────────────────────┘
│                                                              │
│  A non-safe tool acts as a BARRIER — nothing queued after    │
│  it may start until the barrier tool completes.              │
└──────────────────────────────────────────────────────────────┘
```

### 5.3. Execution State Machine

Each `ToolExecution` in the queue transitions through:

```
queued ──► executing ──► completed ──► yielded
                │
                └──► (error) ──► completed (with error result)
```

Counters track state without scanning: `queuedCount`, `activeCount`, `unsafeActiveCount`, `nextQueuedIndex`. This keeps `processQueue()` O(n) cumulative instead of O(n²).

### 5.4. Error Propagation

When a tool errors during parallel execution:

1. The executor sets `hasErrored = true`
2. **Queued siblings** receive a synthetic error: `"<tool_use_error>Sibling tool call errored</tool_use_error>"`
3. **Exception:** If ALL tools in the batch are `Write` or `Edit`, errors do NOT cancel siblings (each file operation is independent)
4. **User abort** produces: `"User rejected tool use"`

### 5.5. Tool-Level Retry

Concurrency-safe tools (Read, Glob, Grep, WebFetch) get 1 automatic retry on transient OS errors (EMFILE, EAGAIN, EBUSY). Unsafe tools are never retried since they may have partially executed.

### 5.6. Explore Cache Integration

The executor integrates with the exploration cache:
- **Before execution:** Check `cache.get(toolName, input, cwd)` for cached results
- **After execution:** Store results via `cache.set()` (only for cacheable, non-error results)
- **After write/edit/bash:** Invalidate affected cache entries via `cache.invalidateFile()` / `cache.invalidateDirectory()`

### 5.7. Practical Example

```
Model response: [Read A, Read B, Read C, Edit D, Glob E]

Execution timeline:
───────────────────────────────────────────────────►  time

Read A  ████████████
Read B  ████████████        (parallel — all concurrency-safe)
Read C  ████████████
                     Edit D ██████████████  (barrier — waits, runs alone)
                                           Glob E ████████  (after barrier)
```

---

## 6. Agent / Sub-Agent System

**File:** `src/core/agent.ts`

### 6.1. Built-in Agent Definitions

Defined as `AGENT_DEFINITIONS: Record<SubagentType, AgentDefinition>`:

| Type | Model | Tools | Purpose |
|------|-------|-------|---------|
| **Explore** | `config.smallModel` (Haiku) | Read, Glob, Grep | Fast read-only codebase exploration |
| **Plan** | `config.model` | Read, Glob, Grep | Architecture & implementation planning |
| **Bash** | `config.model` | Bash | Focused command execution |
| **general-purpose** | `config.model` | All 9 core tools | Multi-step research, broad analysis |

### 6.2. Agent Definition Interface

```typescript
// src/core/types.ts
interface AgentDefinition {
  name: string;
  model?: string;           // Resolved at spawn time
  tools: string[];          // Tool names: ["Read", "Glob", "Grep"]
  systemPrompt: string;     // Agent-specific system prompt
  description: string;      // Used in Task tool output
}

type SubagentType = "Explore" | "Plan" | "Bash" | "general-purpose";
const MAX_AGENT_DEPTH = 5;  // Maximum nesting depth
```

### 6.3. Spawning Flow

```
spawnAgent(prompt, options, parentContext)
    │
    ├── Validate: depth < MAX_AGENT_DEPTH
    ├── Validate: prompt non-empty and < 500KB
    ├── Validate: agent type exists
    │
    ├── Resolve model:
    │   options.model ?? definition.model ?? (Explore ? smallModel : model)
    │
    ├── Clone context (cloneContext → child AbortController, cloned caches)
    │
    ├── Wire recursive spawnAgent on child context
    │
    ├── Resolve tools (resolveTools with definition.tools)
    │
    ├── If background:
    │   ├── Check MAX_BACKGROUND_AGENTS (10) cap
    │   ├── Create output file in tmp directory
    │   ├── Launch doRun() as fire-and-forget promise
    │   ├── Register in runningAgents Map
    │   ├── Return { result: "", agentId, outputFile }
    │   └── Auto-cleanup after 5 minutes
    │
    └── If foreground:
        ├── const result = await doRun()
        └── Return { result, agentId }
```

### 6.4. Context Isolation

Each sub-agent receives a cloned context via `cloneContext()` (`src/core/context.ts`):

```typescript
function cloneContext(parent: ToolContext): ToolContext {
  return {
    readFileState: parent.readFileState.clone(),      // Deep copy (LRU, 500 entries)
    exploreCache:  parent.exploreCache?.clone(),       // Shallow clone of cache entries
    abortController: childAbort,                       // Linked to parent via listener
    agentId: randomUUID(),                             // Unique identity
    depth: parent.depth + 1,                           // Nesting depth
    cwd: parent.cwd,                                   // Inherited working directory
    spawnAgent: parent.spawnAgent,                      // Recursive spawning
  };
}
```

**Key isolation properties:**
- **ReadFileState is deep-cloned** — sub-agent builds its own file read cache, independent of parent
- **ExploreCache is shallow-cloned** — inherits cached results, but child's invalidations don't propagate to parent
- **AbortController is a child** — aborting parent aborts child (via event listener), but not vice versa. Listener cleanup is handled on child abort to prevent memory leaks.
- **Depth increments** — enforces `MAX_AGENT_DEPTH = 5`, defense-in-depth at multiple levels (Task tool, spawnAgent, cloneContext)

### 6.5. Background Agent Registry

Background agents are tracked in a `Map<string, RunningAgent>`:

```typescript
interface RunningAgent {
  id: string;
  promise: Promise<string>;
  outputFile: string;
  done: boolean;
  result?: string;
  _abortController?: AbortController;  // For explicit cancellation
}
```

- Output files are written to `os.tmpdir()/codingagent-agents/<agentId>.txt` with `0o600` permissions
- Results are available via `getAgentResult(agentId)` or the `/agents` REPL command
- Agents auto-cleanup from the registry after 5 minutes
- `abortAllAgents()` is called on process exit to cancel in-flight API calls

### 6.6. Agent Result Handling

When a sub-agent produces no text output (common for tool-heavy agents), the system builds a tool execution summary:

```
(Agent produced no text output but executed 12 tool calls, 10 succeeded, 2 failed)

Tool execution summary:
  Read [OK]: Contents of src/core/loop.ts...
  Grep [OK]: 3 matches found...
  Edit [ERROR]: File not found...
```

This gives the parent model actionable information about what the sub-agent accomplished.

---

## 7. Context Management

**File:** `src/core/compaction.ts`

### 7.1. Token Estimation

`estimateTokens(messages, systemPromptLength?)` uses a heuristic: **~4 chars per token** plus per-message overhead (~16 chars). It accounts for:
- System prompt length (sent with every API call but not in `messages[]`)
- `tool_use` block inputs (JSON-serialized)
- `tool_result` content (string or array)
- `thinking` and `redacted_thinking` blocks
- Image blocks (fixed 1000-char estimate)
- Per-message structural overhead (role labels, delimiters)
- `tool_use_id` fields (~36 chars each)

### 7.2. Micro-Compaction (per-turn)

`microCompact(messages)` runs before each API call. It:

1. Scans for large (>10KB) `tool_result` and `tool_use.input` blocks
2. Keeps the **3 most recent** large blocks intact
3. Replaces older ones:
   - `tool_result` → `"[Result truncated — was X chars. Re-run the tool if needed.]"`
   - `tool_use.input` → compact object preserving small identifying parameters (file_path, url), replacing bulk content with `_truncated` note

Mutates messages in-place.

### 7.3. Auto-Compaction (threshold-based)

`autoCompact(messages, systemPrompt, signal?, force?)` triggers when `estimateTokens()` exceeds `config.compactionThreshold` (default 160K):

1. Uses `config.smallModel` (Haiku) to summarize the conversation
2. Summary prompt emphasizes preserving: exact file paths, function names, code changes, chronological order, line numbers, errors, decisions, current task
3. Long conversations are budget-trimmed: keeps first 20% and last 40% of input, drops middle with placeholder
4. Results in: `[summary user message]` + `[assistant acknowledgment]` + sanitized trailing messages (up to 6)
5. Finds clean split boundaries that don't break `tool_use`/`tool_result` pairs
6. Detects compaction loops (< 10% savings) and warns instead of repeating
7. Falls back to simple truncation (last 20 messages, progressively trimmed) if the API call fails

**Compaction timeout:** 60 seconds via `AbortSignal.timeout()`, combined with the user's Ctrl+C signal.

### 7.4. Orphaned Tool-Use Repair

`repairOrphanedToolUse(messages)` runs before every API call. Scans for `tool_use` IDs without matching `tool_result` entries (caused by aborts, compaction, or force-quit), then injects synthetic `tool_result` blocks with `"Aborted by user."` to satisfy the API's pairing constraint.

### 7.5. Message Sanitization

`sanitizeMessageSlice(messages)` ensures a valid conversation:
1. Must start with "user"
2. Roles must strictly alternate
3. `tool_result` blocks must reference valid `tool_use` IDs in preceding assistant messages
4. Empty or whitespace-only messages are dropped

---

## 8. Exploration Cache

**File:** `src/utils/explore-cache.ts`

### 8.1. Purpose

Caches results from read-only tools (Read, Glob, Grep) so repeated explorations reuse previous results instead of re-executing disk I/O or subprocesses.

### 8.2. Cache Key

Deterministic SHA-256 hash of `{ tool, input (sorted keys), cwd }`. Input properties are sorted by key name before hashing to ensure identical tool calls with different property ordering produce the same key.

### 8.3. Freshness Validation

| Tool | Strategy | Rationale |
|------|----------|-----------|
| **Read** | `statSync(path).mtimeMs` vs cached mtime | Single syscall (~0.1ms) catches external edits |
| **Glob** | TTL (default 30s) | Can't efficiently mtime-check all matched files |
| **Grep** | TTL (default 30s) | Searches span many files |

### 8.4. Invalidation Triggers

| Trigger | Action |
|---------|--------|
| **Write/Edit** (specific file) | Remove Read entries for modified path; remove Glob/Grep entries whose search scope includes the path |
| **Bash** (any command) | Invalidate ALL entries under cwd (conservative — can't know which files Bash touched) |
| **REPL commands** | `/clear`, `/undo`, `/resume` → `cache.clear()` |
| **Automatic** | Read: mtime mismatch → evict + re-execute; Glob/Grep: TTL expired → evict; LRU eviction at 200 entries |
| **Error results** | NEVER cached (transient errors should be retried) |

### 8.5. Session Persistence

The cache supports `serialize()` / `restore()` for session persistence:
- Only Read entries are serialized (Glob/Grep TTLs expire before sessions are resumed)
- On restore, entries are validated against current file mtimes — stale entries are discarded

### 8.6. Monitoring

```
/cache
Explore Cache
  Entries:      12
  Hits:         47
  Misses:       15
  Invalidations: 3
  Evictions:    0
  Hit rate:     75.8%
```

---

## 9. Session Persistence

**File:** `src/session/session.ts`

Sessions are saved to `~/.codingagent/sessions/<id>.json`:

```typescript
interface SavedSession {
  version: 1;
  metadata: SessionMetadata;  // id, timestamps, turnCount, cwd, model, preview, estimatedTokens
  messages: Message[];
  sessionState: {
    turnCount: number;
    totalApiDurationMs: number;
    totalInputTokens: number;
    totalOutputTokens: number;
    history: { timestamp: number; text: string }[];
  };
  exploreCache?: SerializedExploreCache;  // Read entries surviving session restore
}
```

**Key behaviors:**
- **Auto-save:** After every turn + on process exit (SIGINT, SIGTERM, beforeExit)
- **Atomic writes:** Write to temp file, then `renameSync` (with monotonic counter for uniqueness)
- **Fast metadata:** `extractMetadataFast()` reads only the first 4KB for session listing
- **Resume:** `/resume [id|#]` restores messages, session state, and explore cache (validated against current mtimes)
- **Pruning:** `MAX_SESSIONS = 50` on disk; oldest auto-pruned
- **Fallback:** If `homedir()` fails (containers/CI), falls back to `os.tmpdir()`

---

## 10. Configuration

**File:** `src/config/config.ts`

Sources in precedence order:
1. `~/.claude/settings.json` → `"env"` object → specific keys
2. `process.env`
3. Hardcoded defaults

```typescript
interface AppConfig {
  baseUrl: string;            // ANTHROPIC_BASE_URL → default: "https://api.anthropic.com"
  model: string;              // ANTHROPIC_MODEL → default: "claude-sonnet-4-20250514"
  smallModel: string;         // ANTHROPIC_SMALL_FAST_MODEL → default: "claude-haiku-3-5-20241022"
  compactionThreshold: number; // ANTHROPIC_COMPACTION_THRESHOLD → default: 160000
  maxOutputTokens: number;    // ANTHROPIC_MAX_OUTPUT_TOKENS → default: 16384
  apiKey: string | undefined; // ANTHROPIC_API_KEY (trimmed, validated)
  debug: boolean;             // CODINGAGENT_DEBUG → default: false
  disableStreaming: boolean;  // ANTHROPIC_DISABLE_STREAMING → default: false
  skillDirs: string[];        // settings.json "skillDirs" → default: []
}
```

**Validation highlights:**
- Base URL: checks for `http://` or `https://` prefix, warns on trailing `/v1`, query strings, fragments, redacts embedded credentials
- API key: validates format (`sk-ant-` prefix), length, control characters; warns on suspicious values
- Model names: warns on embedded whitespace and control characters
- Compaction threshold: must be integer ≥ 10,000; warns above 1M
- Max output tokens: must be integer between 1 and 128,000; warns below 1024

**Config lifecycle:**
- `loadConfig()` — reads + validates + caches
- `getConfig()` — returns cached or loads
- `resetConfig()` — clears cache, invokes registered callbacks (e.g., client singleton reset)
- `onConfigReset(callback)` — register dependent reset hooks (Set dedup)

---

## 11. Skills & Project Memory

**File:** `src/config/skills.ts`

### 11.1. Project Memory (CLAUDE.md)

Memory files are loaded hierarchically, with lower-priority entries appearing earlier in the system prompt:

```
Priority 10 — User-level (global, personal):
  ~/.claude/CLAUDE.md
  ~/.codex/AGENTS.md                (OpenAI Codex)

Priority 20 — Project-level (team-shared):
  ./CLAUDE.md  or  .claude/CLAUDE.md
  .github/copilot-instructions.md   (GitHub Copilot)
  ./AGENTS.md                       (OpenAI Codex)
  ./GEMINI.md                       (Google Gemini)

Priority 25 — Modular rules (with optional path scoping):
  .claude/rules/*.md
  .github/instructions/*.instructions.md

Priority 30 — Local overrides (personal, not committed):
  ./CLAUDE.local.md
```

**Features:**
- **Import support:** `@path/to/file` lines in CLAUDE.md are inlined (up to 5 levels deep)
- **Path-scoped rules:** YAML frontmatter `paths:` (Claude) or `applyTo:` (Copilot) restricts rules to specific file patterns
- **Truncation:** Individual entries capped at 10,000 chars
- **Caching:** Results cached per project directory; reset on `/clear`, `/reload`, `/resume`

### 11.2. Skills (SKILL.md)

Skills are loaded from built-in directories (always) plus configured extras:

```
1. ~/.claude/skills/          — User-level (always loaded)
2. .claude/skills/            — Project-level (always loaded)
3. config.skillDirs[0..n]     — Extra directories from settings.json
```

Each skill is a markdown file with optional YAML frontmatter:

```yaml
---
name: react-specialist
description: Senior React developer for modern React 19 patterns
disable-model-invocation: false
user-invocable: true
allowed-tools: [Read, Grep, Edit, Write]
context: inline             # or "fork" for isolated sub-agent
agent: general-purpose      # sub-agent type when context: fork
---

You are a senior React developer...
```

Skills reach the model via:
1. **System prompt** — `getSkillDescriptions(cwd)` lists non-hidden skills
2. **Slash-command invocation** — user types `/react-specialist fix the useEffect hook` → `$ARGUMENTS` substitution → user message

---

## 12. MCP (Model Context Protocol) Integration

**File:** `src/core/mcp-client.ts`

Connects to MCP servers via stdio or HTTP transport, discovers tools via `tools/list`, and bridges them into the codingagent tool system.

### 12.1. Configuration Sources

1. `.mcp.json` at project root (team-shared)
2. `~/.claude.json` under `mcpServers` (user scope)
3. `.vscode/mcp.json` (VS Code / Copilot)
4. Claude Desktop config (platform-specific)

### 12.2. Protocol

Implements JSON-RPC 2.0 directly without external MCP SDK:
- `initialize` → capability negotiation
- `tools/list` → tool discovery
- `tools/call` → tool invocation
- `resources/list` / `resources/read` → resource access

### 12.3. Tool Registration

MCP tools are registered via `registerMcpTools()` in `src/tools/index.ts`:
- Prefixed with `mcp__<server>__<tool>` naming convention
- Collision with built-in tools → skipped with warning
- Case-insensitive dedup against existing tools
- Supports `/reload` (replace previous MCP tools)

### 12.4. Environment Variable Expansion

Config supports `${VAR}` and `${VAR:-default}` syntax in server entries.

---

## 13. Multi-Judge Eval Gate

**File:** `src/eval/eval.ts`

### 13.1. Purpose

Optional verification step (enabled via `--eval`) that runs after the agent declares work complete. Multiple AI judges independently evaluate the work. The loop only terminates when a **majority** agrees it's complete.

### 13.2. Architecture

```
Agent declares "done" (end_turn, no tool calls)
    │
    ▼
┌─────────────────────────────────────────────────────────────┐
│  EVAL GATE (up to MAX_EVAL_ROUNDS = 3)                      │
│                                                             │
│  1. Build eval context from messages                         │
│                                                             │
│  2. Run 3 judges IN PARALLEL (Promise.allSettled):           │
│     ┌─────────────┐ ┌──────────────┐ ┌────────────────┐    │
│     │ Correctness  │ │ Completeness │ │ Goal Alignment │    │
│     └──────┬───────┘ └──────┬───────┘ └──────┬─────────┘    │
│            ▼                ▼                ▼              │
│     { isComplete, reasoning, refinementSuggestions }        │
│                                                             │
│  3. MAJORITY RULE: completeCount > judges.length / 2        │
│     ├─ YES → accept result, exit loop                       │
│     └─ NO  → synthesize refinement prompt                   │
│              → inject as user message → continue loop        │
└─────────────────────────────────────────────────────────────┘
```

### 13.3. Judge Perspectives

| Judge | Focus | Pass Criteria |
|-------|-------|---------------|
| **Correctness** | Bugs, logic errors, syntax, edge cases | Work correctly fulfills the request |
| **Completeness** | All aspects addressed, no TODOs, consistent | Every part covered |
| **Goal Alignment** | User's underlying intent, appropriate approach | Result serves actual need |

### 13.4. Cost & Performance

- Uses `config.smallModel` (Haiku) for all judges — fast & cheap
- All judges run simultaneously (`Promise.allSettled`)
- Max cost: 3 judges × 3 rounds × ~100 output tokens per eval cycle
- 2 retries per judge API call
- Graceful degradation: if eval API calls fail, result is accepted without verification

### 13.5. When Eval is Skipped

| Condition | Reason |
|-----------|--------|
| `--eval` not passed | Opt-in to avoid overhead |
| Sub-agents (`depth > 0`) | Only root agent needs verification |
| `stop_reason ≠ end_turn` | Abnormal stop, nothing to eval |
| Empty response | Nothing to evaluate |
| `evalRound ≥ 3` | Prevent infinite refinement |
| Eval API error | Graceful degradation |

---

## 14. Multi-Transport Gateway

**File:** `src/gateway/gateway.ts`

### 14.1. Architecture

```
┌───────────────────────────────────────────────────────────────┐
│                          Gateway (host)                        │
│                                                                │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐                     │
│  │ Telegram │  │  Teams   │  │ Terminal │  ← Transport Ports   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘                     │
│       │             │             │                            │
│       └─────────────┼─────────────┘                            │
│                     │ IPC (fork channel)                       │
│              ┌──────┴──────┐                                   │
│              │ Agent Worker │  (child_process.fork)             │
│              └─────────────┘                                   │
└───────────────────────────────────────────────────────────────┘
```

**Key behaviors:**
- **Stays running permanently** — transport connections survive worker restarts
- **Hot-reloading** — `/reload` restarts the worker without dropping bot connections
- **Lightweight** — imports only IPC types and transport ports; no agent code
- **Message queueing** — buffers inbound messages while worker is busy/restarting
- **Auto-respawn** — worker crashes trigger automatic restart after 1s delay

### 14.2. I/O Port Abstraction

**File:** `src/ports/io-port.ts`

```typescript
interface InputPort {
  messages(): AsyncIterableIterator<UserMessage>;
}

interface OutputPort {
  sendText(text: string): void | Promise<void>;
  sendToolUse(toolName: string, input: Record<string, unknown>): void | Promise<void>;
  sendToolResult(toolName: string, result: ToolResult): void | Promise<void>;
  sendError(error: string): void | Promise<void>;
  sendSessionComplete(stopReason: string): void | Promise<void>;
}

interface IOPort extends InputPort, OutputPort {}
```

Implementations: `TerminalIOPort`, `TelegramIOPort`, `TeamsIOPort`.

### 14.3. Session Runner

**File:** `src/session/session-runner.ts`

Transport-agnostic core that connects an `IOPort` to `agenticLoop()`:
- Reads `UserMessage`s from `port.input`
- Feeds them to the agentic loop
- Routes `LoopYield` events to `port.output`
- Handles micro-compaction, auto-compaction, and orphan repair between turns

---

## 15. Debug System

**File:** `src/core/debug.ts`

When enabled (`CODINGAGENT_DEBUG=1` or `/debug` REPL toggle), all LLM interactions are logged to individual timestamped JSON files:

```
~/.codingagent/sessions/<session-id>/debug/
  ├── 2026-02-25T02-21-28-100Z_api_request.json
  ├── 2026-02-25T02-21-29-500Z_api_response.json
  ├── 2026-02-25T02-21-30-200Z_tool_execution.json
  ├── 2026-02-25T02-21-31-000Z_compaction_request.json
  └── ...
```

Each log file contains pretty-printed JSON. Files are named with ISO timestamps and event types for natural chronological ordering. Logging is fire-and-forget — write failures are silently ignored so debug logging never breaks the main application.

Logged events: `debugLogApiRequest`, `debugLogApiResponse`, `debugLogToolExecution`, `debugLogCompaction`, `debugLogEval`.

---

## 16. Terminal UI

**File:** `src/ui/ui.ts`

### 16.1. OutputManager

All terminal output routes through a centralized `OutputManager` singleton. In interactive mode (REPL), it coordinates with readline to prevent async output from being wiped by prompt redraws:

1. Clear inline hints
2. `\r\x1b[K` (carriage return + clear line)
3. `console.log(text)`
4. Reset readline's `prevRows`
5. Re-display prompt

In non-interactive mode (`-p`, piped stdin), output goes directly to `console.log`.

### 16.2. Output Channels

| Channel | Target | Used by |
|---------|--------|---------|
| `output.log/info/warn/success` | stdout (readline-safe) | All modules via `printInfo`, `printWarning`, etc. |
| `output.write` | stdout (raw, no re-prompt) | Streaming assistant text |
| `Spinner` | stderr | Thinking indicator, compaction progress |
| `console.error` | stderr | Fatal errors |

The Spinner uses stderr to avoid interfering with readline's stdout management and to keep piped stdout clean.

### 16.3. REPL Commands

| Command | Description |
|---------|-------------|
| `/help` | Show all commands |
| `/clear` | Start new conversation (clears caches) |
| `/compact [--force]` | Compress conversation context |
| `/status` | Show session info & statistics |
| `/cache` | Show explore cache statistics |
| `/model <name>` | Switch model mid-session |
| `/smallmodel <name>` | Switch small model |
| `/tokens` | Show current token count |
| `/history` | Show conversation history |
| `/retry` | Re-send last prompt |
| `/agents [id]` | Show background agent status |
| `/save` | Save current session |
| `/sessions` | List saved sessions |
| `/resume [id\|#]` | Resume a saved session |
| `/delete-session <id>` | Delete a saved session |
| `/undo` | Stash uncommitted changes via git |
| `/mcp` | Show MCP server status & tools |
| `/memory` | Show loaded project memory |
| `/skills` | List available skills |
| `/reload` | Hot restart (reload code + tools) |
| `/debug` | Toggle debug mode |
| `/quit` | Exit (also Ctrl+C ×2) |

Commands are registered at module load time via `registerCommand()` with validation that every `case` in the command handler has a corresponding registration.

---

## Appendix A: Caching & Invalidation Summary

| Cache | Location | Strategy | Invalidation |
|-------|----------|----------|--------------|
| **Config** | `config.ts` | Singleton, lazy init | `resetConfig()` on `/reload` |
| **API client** | `client.ts` | Singleton | `onConfigReset` callback |
| **ReadFileState** | `context.ts` | LRU Map (500 entries) | Per-file on write; `clear()` on /undo, /clear, /resume |
| **ExploreCache** | `explore-cache.ts` | LRU Map (200 entries) | File-level (Write/Edit), directory-level (Bash), mtime (Read), TTL (Glob/Grep), manual (REPL commands) |
| **System prompt** | `index.ts` | Session-stable timestamp | New session resets `sessionStartDate` |
| **Tool registry** | `tools/index.ts` | Static Map + dynamic MCP | MCP re-registered on `/reload` |
| **Session metadata** | `session.ts` | First-4KB fast path | Re-read on `listSessions()` |
| **Memory/Skills** | `skills.ts` | Per-project-dir cache | Reset on `/clear`, `/reload`, `/resume`, CWD change |

---

## Appendix B: Key Constants

| Constant | Value | Location | Purpose |
|----------|-------|----------|---------|
| `MAX_RETRIES` | 3 | `loop.ts` | API call retries |
| `MAX_TOOL_CALLS_PER_TURN` | 50 | `loop.ts` | Prevents runaway tool execution |
| `MAX_CONCURRENT_SAFE` | 8 | `streaming-executor.ts` | Parallel safe tool cap |
| `MAX_AGENT_DEPTH` | 5 | `types.ts` | Sub-agent nesting limit |
| `MAX_BACKGROUND_AGENTS` | 10 | `agent.ts` | Concurrent background agent cap |
| `MAX_AGENT_RESULT_CHARS` | 1,000,000 | `agent.ts` | Per-agent output size cap |
| `MAX_SESSIONS` | 50 | `session.ts` | Sessions stored on disk |
| `MAX_EVAL_ROUNDS` | 3 | `eval.ts` | Eval refinement loop cap |
| `COMPACTION_MAX_RETRIES` | 2 | `compaction.ts` | Compaction API retries |
| `LARGE_BLOCK_THRESHOLD` | 10,000 | `compaction.ts` | Micro-compaction trigger |
| `MAX_SUMMARY_INPUT_CHARS` | 120,000 | `compaction.ts` | Auto-compaction input budget |
| `ReadFileState.maxEntries` | 500 | `context.ts` | File state LRU cap |
| `ExploreCache.maxEntries` | 200 | `explore-cache.ts` | Cache LRU cap |
| `ExploreCache.TTL` | 30s | `explore-cache.ts` | Glob/Grep entry TTL |

---

## Appendix C: Environment Variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `ANTHROPIC_API_KEY` | (required) | API authentication |
| `ANTHROPIC_MODEL` | `claude-sonnet-4-20250514` | Primary model |
| `ANTHROPIC_SMALL_FAST_MODEL` | `claude-haiku-3-5-20241022` | Model for compaction, exploration, eval |
| `ANTHROPIC_BASE_URL` | `https://api.anthropic.com` | API endpoint (supports proxies) |
| `ANTHROPIC_MAX_OUTPUT_TOKENS` | `16384` | Max tokens per response |
| `ANTHROPIC_COMPACTION_THRESHOLD` | `160000` | Token count triggering auto-compaction |
| `ANTHROPIC_DISABLE_STREAMING` | `false` | Use non-streaming API (for proxies) |
| `CODINGAGENT_DEBUG` | `false` | Enable debug JSONL logging |

---

## Appendix D: Data Flow Diagram

```
                    ┌──────────────────────────────────┐
                    │  User prompt / tool execution     │
                    └──────────────┬───────────────────┘
                                   │
               ┌───────────────────┼───────────────────┐
               │                   │                   │
               ▼                   ▼                   ▼
     ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
     │  ExploreCache    │ │ ReadFileState    │ │  Session Store  │
     │  (tool results)  │ │ (file mtimes)    │ │ (messages)      │
     │                  │ │                  │ │                  │
     │  Read hit? ──────┤ │ Read-before-     │ │ Auto-save after │
     │    → return       │ │ write guard      │ │ each turn       │
     │  Read miss? ─────┤ │                  │ │                  │
     │    → execute      │ │ Edit/Write       │ │ /resume restores│
     │    → store result │ │ updates mtime    │ │ + clears stale  │
     │                  │ │                  │ │   caches         │
     │  Write/Edit?     │ │                  │ │                  │
     │    → invalidate  ◄─┤                  │ │                  │
     │  Bash?           │ │                  │ │                  │
     │    → invalidate  │ │                  │ │                  │
     │      directory   │ │                  │ │                  │
     └─────────────────┘ └─────────────────┘ └─────────────────┘
```

---

*This document describes the architecture of the CodingAgent project — a terminal-based agentic coding assistant. When modifying core systems (loop, tools, caching, agents, eval, skills, compaction), update the relevant section.*
