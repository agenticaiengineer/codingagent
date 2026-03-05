# Claude Code Internal Architecture

> This document describes the reference architecture for a production-grade AI coding agent.
> It covers the core patterns, tool system, context management, and permission model used in modern agentic coding assistants.

---

## Table of Contents

1. [Package Structure](#1-package-structure)
2. [High-Level Architecture](#2-high-level-architecture)
3. [The Agentic Loop](#3-the-agentic-loop)
4. [Tool System](#4-tool-system)
5. [Parallel Tool Execution](#5-parallel-tool-execution-streamingtoolexecutor)
6. [Agent / Subagent System](#6-agent--subagent-system)
7. [Built-in Agent Types](#7-built-in-agent-types)
8. [Agent Lifecycle: Sync vs Async](#8-agent-lifecycle-sync-vs-async)
9. [Context Management](#9-context-management)
10. [Permission System](#10-permission-system)
11. [Hooks System](#11-hooks-system)
12. [Session and Transcript Persistence](#12-session-and-transcript-persistence)
13. [Key Symbols Reference](#13-key-symbols-reference)

---

## 1. Package Structure

```
codingagent/
├── cli.js                    # Single bundled entry point
├── package.json              # Package metadata, bin entry
├── sdk-tools.d.ts            # TypeScript type definitions for SDK tool I/O
├── resvg.wasm                # SVG rendering (for image generation)
├── tree-sitter.wasm          # Tree-sitter parser core
├── tree-sitter-bash.wasm     # Bash grammar for tree-sitter
├── LICENSE.md
├── README.md
└── vendor/
    └── ripgrep/              # Vendored ripgrep binary for fast code search
```

**Key design decisions:**
- Zero runtime npm dependencies (everything is bundled)
- Optional dependencies are only `@img/sharp-*` platform-specific binaries for image processing
- ESM module system (`"type": "module"` in package.json)
- Requires Node.js >= 18.0.0

---

## 2. High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLI Entry Point                          │
│  (cli.js - shebang: #!/usr/bin/env node)                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐   ┌──────────────┐   ┌───────────────────┐   │
│  │   REPL UI    │   │  Session     │   │  Settings &       │   │
│  │  (Ink/React) │   │  Manager     │   │  Configuration    │   │
│  └──────┬───────┘   └──────┬───────┘   └───────┬───────────┘   │
│         │                  │                    │               │
│  ┌──────▼──────────────────▼────────────────────▼───────────┐   │
│  │              Main Message Loop (vy)                       │   │
│  │  ┌─────────────────────────────────────────────────────┐ │   │
│  │  │  Context Compaction → API Stream → Tool Execution   │ │   │
│  │  │          ↑                              │           │ │   │
│  │  │          └──────── Tool Results ────────┘           │ │   │
│  │  └─────────────────────────────────────────────────────┘ │   │
│  └──────────────────────────────────────────────────────────┘   │
│         │                                                       │
│  ┌──────▼───────────────────────────────────────────────────┐   │
│  │                    Tool System                            │   │
│  │  ┌────────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────────────┐ │   │
│  │  │ Bash   │ │ Read │ │ Glob │ │ Grep │ │ Task (Agent) │ │   │
│  │  │ Write  │ │ Edit │ │ Web* │ │ MCP  │ │ TodoWrite    │ │   │
│  │  └────────┘ └──────┘ └──────┘ └──────┘ └──────┬───────┘ │   │
│  └───────────────────────────────────────────────┬──────────┘   │
│                                                  │              │
│  ┌───────────────────────────────────────────────▼──────────┐   │
│  │                   Subagent System                         │   │
│  │  Each subagent gets its own:                              │   │
│  │  - Message loop (uR) → inner vy loop                     │   │
│  │  - System prompt & tool set                               │   │
│  │  - Context window & file cache                            │   │
│  │  - Abort controller (linked to parent)                    │   │
│  │  - Session via AsyncLocalStorage                          │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │                  Infrastructure                           │   │
│  │  API Client │ Permission System │ Hooks │ File Index     │   │
│  │  Compaction │ Transcript Store  │ MCP   │ Telemetry      │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

The system is built around a **recursive agentic loop** pattern. The main process runs a message loop that calls the Claude API, extracts tool-use blocks from the streamed response, executes them (potentially in parallel), feeds the results back, and loops until the model produces a final response with no tool calls.

---

## 3. The Agentic Loop

There are two key generator functions that form the agentic loop:

### 3.1. Outer Agent Loop: `uR` (async generator)

**Location:** Line ~507196 (beautified)

This is the entry point for any agent execution (both main thread and subagents). It:

1. **Resolves the model** for the agent (inherits from parent or overrides).
2. **Builds the system prompt** from the agent definition, appending standard agent instructions.
3. **Resolves the tool set** via `v66()` — filters the global tool list based on the agent's `tools` and `disallowedTools` configuration.
4. **Clones the tool-use context** via `Tm6()` — creates an isolated execution context for the sub-agent.
5. **Runs lifecycle hooks** — fires `SubagentStart` hooks.
6. **Preloads skills** — any skills specified in the agent's frontmatter are loaded and injected as user messages.
7. **Connects MCP servers** — sets up any agent-specific MCP client connections.
8. **Delegates to `vy`** — the inner message loop that does the actual API call cycling.
9. **Cleans up** — disconnects MCP, clears file caches, fires `SubagentStop` hooks.

```
uR(agentDefinition, promptMessages, toolUseContext, ...)
  │
  ├── Resolve model (Xz1)
  ├── Clone context (Tm6)
  ├── Build system prompt (N7z → Pc6)
  ├── Resolve tools (v66)
  ├── Fire SubagentStart hooks (BB8)
  ├── Preload skills
  ├── Connect MCP servers (f7z)
  │
  ├── for await (message of vy(...))  ◄── Inner loop
  │       yield message
  │
  └── Cleanup (MCP disconnect, hooks cleanup, cache clear)
```

### 3.2. Inner Message Loop: `vy` (async generator)

**Location:** Line ~505866 (beautified)

This is the core turn-based loop that handles API communication and tool execution:

```
while (true) {
  ┌───────────────────────────────────────────────────────┐
  │ 1. CONTEXT MANAGEMENT                                 │
  │    ├── Micro-compaction (Jg): trim tool results       │
  │    └── Auto-compaction (CC4): summarize if near limit │
  ├───────────────────────────────────────────────────────┤
  │ 2. API STREAMING (wZ6 → p2q)                          │
  │    ├── Stream response from Claude API                 │
  │    ├── Yield assistant messages as they arrive         │
  │    └── Queue tool_use blocks to StreamingToolExecutor  │
  │         (tools begin executing DURING streaming)       │
  ├───────────────────────────────────────────────────────┤
  │ 3. TOOL RESULT COLLECTION                              │
  │    ├── Gather completed tool results                   │
  │    ├── Handle errors (sibling cancellation)            │
  │    └── Apply context modifiers from tool results       │
  ├───────────────────────────────────────────────────────┤
  │ 4. STOP HOOKS (o2q)                                    │
  │    ├── Run pre-stop hooks                              │
  │    ├── Check for blocking errors                       │
  │    └── Handle hook-stopped-continuation                │
  ├───────────────────────────────────────────────────────┤
  │ 5. CONTINUE OR EXIT                                    │
  │    ├── If tool calls were made → loop back to step 1   │
  │    ├── If max_output_tokens hit → inject recovery msg  │
  │    └── If no tool calls → exit loop                    │
  └───────────────────────────────────────────────────────┘
}
```

**Key detail:** The `StreamingToolExecutor` (`kc6`) is instantiated at the start of each turn. As the API response streams in and `tool_use` blocks are fully received, they are immediately added to the executor and begin running — *before* the full API response finishes streaming. This overlaps network I/O with tool execution for reduced latency.

---

## 4. Tool System

Each tool is an object conforming to this interface (reconstructed from decompiled code):

```typescript
interface Tool {
  name: string;
  description(): Promise<string>;
  inputSchema: ZodSchema;
  outputSchema?: ZodSchema;
  prompt(context): Promise<string>;          // System prompt contribution
  call(input, context, ...): Promise<Result>; // Execution
  isConcurrencySafe(input?): boolean;        // Can run in parallel?
  isReadOnly(input?): boolean;               // Does it modify state?
  isEnabled(): boolean;                      // Is tool available?
  checkPermissions(input, context): Promise<PermissionResult>;
  maxResultSizeChars?: number;               // Output truncation limit
  renderToolUseMessage?(input): JSX;         // UI rendering
  renderToolResultMessage?(result): JSX;     // UI rendering
  interruptBehavior?(): "block" | "cancel";  // Behavior on Ctrl+C
}
```

### Tool Categories

| Category | Tools | Concurrency-Safe | Read-Only |
|----------|-------|:-----------------:|:---------:|
| **File Read** | Read, Glob, Grep | Yes | Yes |
| **File Write** | Write, Edit, NotebookEdit | No | No |
| **Execution** | Bash | No | No |
| **Web** | WebFetch, WebSearch | Yes | Yes |
| **Agent** | Task (spawn), TaskOutput, TaskStop | Conditional* | Conditional* |
| **UI** | AskUserQuestion, EnterPlanMode, ExitPlanMode | Yes | Yes |
| **State** | TodoWrite, Config | Varies | No |
| **MCP** | mcp__* (dynamic) | Based on `readOnlyHint` annotation | Based on annotation |

\* Task's `isConcurrencySafe` delegates to `isReadOnly`, which depends on the input parameters. TaskOutput is always safe; TaskStop is never safe.

---

## 5. Parallel Tool Execution (StreamingToolExecutor)

### 5.1. Class: `kc6` (StreamingToolExecutor)

**Location:** Line ~505405 (beautified)

This class manages the parallel execution of tool calls within a single API turn. It is the key mechanism that enables Claude Code to run multiple tools simultaneously.

### 5.2. Data Flow

```
API Stream ──────────────────────────────────────────────────►
              │            │            │
              ▼            ▼            ▼
         tool_use #1   tool_use #2  tool_use #3
              │            │            │
              ▼            ▼            ▼
         ┌─────────────────────────────────────┐
         │       StreamingToolExecutor          │
         │                                      │
         │  Queue: [#1: queued] [#2: queued]    │
         │         [#3: queued]                  │
         │                                      │
         │  processQueue() called after each    │
         │  addTool()                            │
         └──────────────────────────────────────┘
```

### 5.3. Concurrency Rules

The `canExecuteTool(isConcurrencySafe)` method implements these rules:

```
┌──────────────────────────────────────────────────────────────┐
│                  CONCURRENCY DECISION TREE                    │
│                                                              │
│  Is anything currently executing?                            │
│  ├── NO → Execute immediately (any tool)                     │
│  └── YES                                                     │
│       ├── Is the new tool concurrency-safe?                  │
│       │    ├── NO → WAIT (block until queue is empty)        │
│       │    └── YES                                           │
│       │         ├── Are ALL executing tools concurrency-safe?│
│       │         │    ├── YES → Execute in parallel           │
│       │         │    └── NO → WAIT                           │
│       └─────────────────────────────────────────────────────┘
│                                                              │
│  Additional: If a non-safe tool is queued, it acts as a      │
│  barrier — no subsequent tools execute until it completes.   │
└──────────────────────────────────────────────────────────────┘
```

### 5.4. Execution State Machine

Each tool in the queue goes through these states:

```
queued ──► executing ──► completed ──► yielded
                │
                └──► (error) ──► completed (with error result)
```

### 5.5. Error Propagation

When a tool errors during parallel execution:

1. The executor sets `hasErrored = true`
2. **Sibling tools that haven't started** receive a synthetic error:
   `"<tool_use_error>Sibling tool call errored</tool_use_error>"`
3. **Exception:** If ALL tools in the batch are Write or Edit operations, errors do NOT cancel siblings (checked via `allToolsAreWriteOrEdit()`)
4. **User interruption** (abort signal) produces: `"User rejected tool use"`
5. **Streaming fallback** (model fallback) produces: `"Streaming fallback - tool execution discarded"`

### 5.6. Progress Reporting

The executor supports real-time progress from executing tools:
- Tools can push progress events to `pendingProgress[]`
- A `Promise`-based signaling mechanism (`progressAvailableResolve`) wakes the consumer when progress is available
- The consumer uses `Promise.race` between tool completion promises and the progress signal

### 5.7. Practical Example: Parallel vs Sequential

```
Model response contains: [Read file A, Read file B, Read file C, Edit file D, Glob pattern E]

Execution timeline:
─────────────────────────────────────────────────►  time

Read A  ████████████
Read B  ████████████          (parallel - all concurrency-safe)
Read C  ████████████
                     Edit D  ██████████████  (sequential - not safe, waits)
                                            Glob E ████████  (safe, but waited for Edit)
```

---

## 6. Agent / Subagent System

### 6.1. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Main Thread                              │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  uR(mainAgent) → vy() loop                            │  │
│  │       │                                                │  │
│  │       ├── Tool: Read (direct execution)                │  │
│  │       ├── Tool: Bash (direct execution)                │  │
│  │       │                                                │  │
│  │       ├── Tool: Task {                                 │  │
│  │       │     subagent_type: "Explore",                  │  │
│  │       │     run_in_background: true                    │  │
│  │       │   }                                            │  │
│  │       │     ├──► Spawns Agent A (async)  ──────────┐   │  │
│  │       │     └──► Returns {agentId, outputFile}     │   │  │
│  │       │                                            │   │  │
│  │       ├── Tool: Task {                             │   │  │
│  │       │     subagent_type: "Explore",              │   │  │
│  │       │     run_in_background: true                │   │  │
│  │       │   }                                        │   │  │
│  │       │     ├──► Spawns Agent B (async) ───────┐   │   │  │
│  │       │     └──► Returns {agentId, outputFile} │   │   │  │
│  │       │                                        │   │   │  │
│  │       ├── Tool: TaskOutput (check Agent A)     │   │   │  │
│  │       │                                   ▼   ▼   │   │  │
│  │       └── ...                         ┌───────────┐│  │  │
│  └───────────────────────────────────────┤  Agents   ├┘  │  │
│                                          │  Running  │   │  │
│                                          │  in Background│  │
│                                          └───────────┘   │  │
└─────────────────────────────────────────────────────────────┘
```

### 6.2. Agent Definition Interface

Each agent (built-in or user-defined) is registered with this structure:

```typescript
interface AgentDefinition {
  agentType: string;              // Unique identifier (e.g., "Explore")
  whenToUse: string;              // Description for the model to decide when to use
  tools?: string[];               // ["Read", "Glob", ...] or ["*"] for all
  disallowedTools?: string[];     // Tools to exclude
  source: "built-in" | string;    // Origin
  baseDir: string;                // Working directory context
  model?: "inherit" | "haiku" | "sonnet" | "opus"; // Model override
  color?: string;                 // UI color for the agent
  permissionMode?: string;        // Permission handling mode
  background?: boolean;           // Default to background execution
  maxTurns?: number;              // Limit on agentic turns
  forkContext?: boolean;          // Whether to include parent conversation
  memory?: string;                // Memory scope
  hooks?: object;                 // Agent-specific hooks
  skills?: string[];              // Skills to preload
  requiredMcpServers?: string[];  // Required MCP server connections
  getSystemPrompt(ctx): string;   // System prompt generator
  callback?(): void;              // Post-completion callback
  effort?: string;                // Effort level override
  criticalSystemReminder_EXPERIMENTAL?: string; // Injected reminder
}
```

### 6.3. Task Tool Schema

The `Task` tool (internal name `hK`) accepts this input:

```typescript
interface TaskInput {
  description: string;      // Short (3-5 word) description
  prompt: string;           // The task for the agent to perform
  subagent_type: string;    // Agent type to use (e.g., "Explore")
  model?: "sonnet" | "opus" | "haiku";  // Optional model override
  resume?: string;          // Agent ID to resume from
  run_in_background?: boolean;  // Run asynchronously
  max_turns?: number;       // Turn limit
  // Team features (when available):
  name?: string;            // Named agent for teams
  team_name?: string;       // Team context
  mode?: string;            // Permission mode for teammate
}
```

### 6.4. Agent Selection Flow

```
Task tool called with subagent_type
        │
        ▼
  ┌─── Filter active agents by allowedAgentTypes ───┐
  │                                                   │
  ▼                                                   │
  Find matching agent definition                      │
  ├── Not found? Check if denied by permission rule   │
  ├── Not found? Error with available agent list      │
  └── Found                                           │
        │                                             │
        ▼                                             │
  Check requiredMcpServers                            │
  ├── Missing servers? Error                          │
  └── All present                                     │
        │                                             │
        ▼                                             │
  Resolve model (Xz1)                                 │
  ├── Agent definition model                          │
  ├── User override (from tool input)                 │
  ├── Permission mode constraints                     │
  └── Fallback to main loop model                     │
        │                                             │
        ▼                                             │
  Determine execution mode (sync or async)            │
  └── Spawn agent via appropriate path                │
```

---

## 7. Built-in Agent Types

### 7.1. Bash Agent

| Property | Value |
|----------|-------|
| **Type** | `Bash` |
| **Model** | `inherit` (uses parent's model) |
| **Tools** | `Bash` only |
| **Purpose** | Focused command execution |
| **System Prompt** | "You are a command execution specialist for Claude Code..." |

### 7.2. General-Purpose Agent

| Property | Value |
|----------|-------|
| **Type** | `general-purpose` |
| **Model** | `inherit` |
| **Tools** | `*` (all available tools) |
| **Purpose** | Multi-step research, broad code analysis |
| **System Prompt** | "You are an agent for Claude Code... use the tools available to complete the task..." |

Key instructions in prompt:
- Start broad searching, narrow down
- Check multiple locations and naming conventions
- Never create files unless absolutely necessary
- Return absolute file paths in responses

### 7.3. Explore Agent

| Property | Value |
|----------|-------|
| **Type** | `Explore` |
| **Model** | **`haiku`** (fast, cheap model for speed) |
| **Tools** | Read-only: Glob, Grep, Read, Bash (read-only ops only) |
| **Disallowed** | Task, Write, Edit, NotebookEdit, EnterPlanMode |
| **Purpose** | Fast codebase exploration and file search |

Key characteristics:
- **READ-ONLY mode** — strictly prohibited from creating, modifying, or deleting files
- Uses Haiku for fast, low-cost execution
- Instructed to spawn **multiple parallel tool calls** for grepping and reading files
- Has two variants controlled by `explore_agent_variant` feature flag:
  - **Default:** Used for quick file finding, keyword searches, or codebase questions (any thoroughness)
  - **Restrictive:** Only used for tasks that clearly require reading 8+ files across multiple directories
- Includes a `criticalSystemReminder_EXPERIMENTAL` that is injected: "CRITICAL: This is a READ-ONLY task..."

### 7.4. Plan Agent

| Property | Value |
|----------|-------|
| **Type** | `Plan` |
| **Model** | `inherit` |
| **Tools** | Same as Explore (read-only) |
| **Disallowed** | Same as Explore |
| **Purpose** | Software architecture and implementation planning |

Key requirements in prompt:
1. Understand requirements
2. Explore thoroughly (read files, find patterns, trace code paths)
3. Design solution with trade-offs
4. Detail the plan step-by-step
5. Output a "Critical Files for Implementation" section listing 3-5 key files

### 7.5. Claude Code Guide Agent

| Property | Value |
|----------|-------|
| **Type** | `claude-code-guide` |
| **Model** | **`haiku`** |
| **Tools** | Glob, Grep, Read, WebFetch, WebSearch |
| **Permission Mode** | `dontAsk` (auto-approve) |
| **Purpose** | Help users understand Claude Code, Agent SDK, and Claude API |

Fetches documentation from:
- Claude Code docs: `https://code.claude.com/docs/en/claude_code_docs_map.md`
- Claude API/SDK docs: `https://platform.claude.com/llms.txt`

### 7.6. Statusline Setup Agent

| Property | Value |
|----------|-------|
| **Type** | `statusline-setup` |
| **Model** | **`sonnet`** |
| **Tools** | Read, Edit |
| **Color** | `orange` |
| **Purpose** | Configure the user's statusLine in `~/.claude/settings.json` |

### 7.7. User-Defined Agents

Users can define custom agents in `.claude/agents/` or via plugins. These follow the same `AgentDefinition` interface and are registered alongside built-in agents. Custom agents:
- Can specify their own system prompts, tool sets, and model preferences
- Can require specific MCP servers
- Can specify custom colors, hooks, and skills
- Are tracked with `source` set to the plugin or project name

---

## 8. Agent Lifecycle: Sync vs Async

### 8.1. Synchronous Execution

When `run_in_background` is `false` (default for most agents):

```
Main Loop                          Subagent
    │                                  │
    ├── Task tool called               │
    │                                  │
    ├── Y$4() creates task entry ──────┤
    │   with foreground state           │
    │                                  │
    ├── Start uR() generator ──────────►
    │                                  │
    │   ┌─ Race between: ─┐           │
    │   │  - next message  │           ├── API call
    │   │  - background    │           ├── Tool execution
    │   │    signal        │           ├── API call
    │   └──────────────────┘           ├── ...
    │                                  │
    │   If auto-background timer       │
    │   fires (120s by default):       │
    │   ├── Promote to background      │
    │   ├── Return async_launched      │
    │   └── Agent continues ───────────►
    │                                  │
    │   Otherwise:                     │
    │   ├── Agent completes ◄──────────┤
    │   ├── Return full result         │
    │   └── Main loop continues        │
    │                                  │
```

**Auto-promotion to background:** If `CLAUDE_AUTO_BACKGROUND_TASKS` is enabled, a sync agent can be automatically promoted to a background agent after a timeout (default 120 seconds). This uses `Promise.race` between the next agent message and a background timer signal.

### 8.2. Asynchronous (Background) Execution

When `run_in_background` is `true`:

```
Main Loop                          Background Agent
    │                                     │
    ├── Task tool called                  │
    │                                     │
    ├── K$4() creates task entry ─────────┤
    │   with background state              │
    │                                     │
    ├── DG6() launches async context ─────►
    │   (AsyncLocalStorage.run)            │
    │                                     │
    ├── Returns immediately:              ├── Starts uR() loop
    │   {                                 │
    │     status: "async_launched",       ├── API call #1
    │     agentId: "s...",                ├── Tool execution
    │     outputFile: "~/.claude/..."     ├── API call #2
    │   }                                 ├── ...
    │                                     │
    ├── Main loop continues               │
    │                                     │
    │   (Agent writes results to          │
    │    output file via yq1 class)       │
    │                                     │
    ├── TaskOutput tool can check ────────┤
    │   progress at any time               │
    │                                     │
    │                                     ├── Complete
    │                                     ├── updates state
    │                                     └── records final status
```

### 8.3. Output File Mechanism

Background agents write their output to a file at:
```
~/.claude/sessions/<session-id>/<agent-id>.output
```

The `yq1` class manages writing to this file:
- Uses an append-based buffer
- Serializes writes to avoid corruption
- The parent agent can read this file via `TaskOutput` tool or the `Read` tool

### 8.4. Task State Registry

All agent tasks are tracked in a global state object (`appState.tasks`):

```typescript
interface AgentTaskState {
  type: "local_agent";
  status: "running" | "completed" | "failed";
  agentId: string;
  prompt: string;
  selectedAgent: AgentDefinition;
  agentType: string;
  model?: string;
  abortController: AbortController;
  isBackgrounded: boolean;
  progress?: {
    toolUseCount: number;
    tokenCount: number;
    summary?: string;
  };
  result?: AgentResult;
  error?: string;
  startTime: number;
  endTime?: number;
  unregisterCleanup?: () => void;
  retrieved: boolean;
  lastReportedToolCount: number;
  lastReportedTokenCount: number;
}
```

### 8.5. Session Context Isolation

Each agent runs in its own `AsyncLocalStorage` context (Node.js `async_hooks`):

```typescript
// The DG6 function wraps agent execution in an AsyncLocalStorage context
function DG6(sessionInfo, asyncFn) {
  return asyncLocalStorage.run(sessionInfo, asyncFn);
}
```

The session info includes:
- `agentId`: Unique session identifier
- `parentSessionId`: Link to parent session
- `agentType`: "subagent"
- `subagentName`: The agent type name (e.g., "Explore")
- `isBuiltIn`: Whether it's a built-in agent

This allows any code within the agent's async context to look up its identity without explicit parameter passing.

---

## 9. Context Management

### 9.1. Context Cloning via `Tm6`

When a subagent is spawned, the tool-use context is cloned via `Tm6()`:

```typescript
function Tm6(parentContext, overrides) {
  return {
    // Fresh independent state:
    readFileState: clone(overrides?.readFileState ?? parentContext.readFileState),
    nestedMemoryAttachmentTriggers: new Set(),
    dynamicSkillDirTriggers: new Set(),
    toolDecisions: undefined,

    // Linked to parent (conditionally):
    abortController: overrides?.abortController
      ?? (overrides?.shareAbortController
        ? parentContext.abortController
        : childAbortController(parentContext.abortController)),
    getAppState: overrides?.getAppState ?? ...,
    setAppState: overrides?.shareSetAppState
      ? parentContext.setAppState
      : noOp,   // subagents cannot modify parent state by default

    // Independent:
    agentId: overrides?.agentId ?? generateId(),
    agentType: overrides?.agentType,
    queryTracking: { chainId: newId(), depth: parentDepth + 1 },
    fileReadingLimits: parentContext.fileReadingLimits,

    // Disabled for subagents:
    setInProgressToolUseIDs: noOp,
    updateFileHistoryState: noOp,
    updateAttributionState: noOp,
    addNotification: undefined,
    setToolJSX: undefined,
  };
}
```

Key isolation properties:
- **File cache is cloned** — subagent builds its own file read cache
- **Abort controller is a child** — aborting the parent aborts the child, but not vice versa
- **State mutation is isolated** — subagents cannot modify parent's app state by default
- **Query tracking increments depth** — enables hierarchical telemetry

### 9.2. Micro-Compaction (`Jg`)

Before each API call, the message list is trimmed:
- Large tool results may be truncated
- Old messages may have their content reduced
- This keeps the context within the model's window without losing recent context

### 9.3. Auto-Compaction (`CC4`)

When the conversation approaches the context window limit:
1. Checks if compaction is needed via `HXY()` (token count analysis)
2. First attempts to use a cached compaction (`GW1`)
3. If no cache hit, generates a summary of the conversation (`zZ6`)
4. Fires `PreCompact` hooks to allow user-defined behavior
5. Replaces old messages with the summary
6. Tracks compaction metrics (pre/post token counts)

The auto-compaction threshold constants:
```typescript
const COMPACTION_THRESHOLD = 20000;  // tokens before start of compaction zone
const COMPACT_BUFFER = 13000;        // buffer below threshold
```

### 9.4. Fork Context

When an agent has `forkContext: true`, it receives the parent's conversation history as read-only context. The subagent can reference prior conversation but operates in its own context window. A special system message is injected:

```
### FORKING CONVERSATION CONTEXT ###
### ENTERING SUB-AGENT ROUTINE ###
Entered sub-agent context

PLEASE NOTE:
- The messages above this point are from the main thread prior to sub-agent execution.
  They are provided as context only.
- Context messages may include tool_use blocks for tools that are not available in the
  sub-agent context. You should only use the tools specifically provided to you.
- Only complete the specific sub-agent task you have been assigned below.
```

---

## 10. Permission System

### 10.1. Permission Modes

The system supports several permission modes:

| Mode | Behavior |
|------|----------|
| `acceptEdits` | Auto-approve read operations, prompt for writes |
| `plan` | Require plan approval before execution |
| `bypassPermissions` | Auto-approve everything |
| `dontAsk` | Auto-approve (used by guide agent) |
| `bubble` | Bubble permission requests to parent |

### 10.2. Subagent Permissions

When a subagent is spawned:
- If the subagent has a `permissionMode` set in its definition, that overrides the parent's mode
- Background agents automatically get `shouldAvoidPermissionPrompts: true`
- The `alwaysAllowRules` from the parent's session and CLI args are inherited
- Tool-level permission checks run via `checkPermissions()` on each tool

### 10.3. Agent Permission Rules

Tools can be restricted per-agent using the tool list syntax. The `v66()` function resolves:
- `["*"]` → all tools available
- `["Read", "Glob", "Grep"]` → only these tools
- `disallowedTools: ["Task", "Write", "Edit"]` → all except these

The Task tool itself supports `allowedAgentTypes` which restricts which subagent types can be spawned further.

---

## 11. Hooks System

### 11.1. Hook Events

The system fires hooks at various lifecycle points:

| Hook | When | Has Match Query |
|------|------|:---------------:|
| `SessionStart` | Session begins | No |
| `Stop` | After each model turn (no tool calls) | No |
| `SubagentStart` | Before a subagent starts | Yes (agent type) |
| `SubagentStop` | After a subagent completes | Yes (agent type) |
| `PreCompact` | Before context compaction | Yes (trigger type) |
| `Setup` | During initial setup | No |

### 11.2. Hook Execution

Hooks are shell commands that execute in response to events. They receive the hook context as JSON on stdin and can:
- **Exit 0**: Success, stdout shown to agent/user
- **Exit 2** (SubagentStop only): Show stderr to subagent, continue running
- **Non-zero exit**: Error, may block continuation

Hook results can include:
- `additionalContexts`: Extra messages injected into the conversation
- `blockingError`: Prevents the model from continuing
- `preventContinuation`: Stops the current turn

### 11.3. Agent-Specific Hooks

Agents can define their own hooks in their definition. These are registered when the agent starts and cleaned up when it ends, scoped to that agent's session.

---

## 12. Session and Transcript Persistence

### 12.1. Transcript Storage

Every agent's message history is persisted to disk:
```
~/.claude/sessions/<session-id>/<agent-id>.transcript
```

- Messages are recorded via `UK6()` after each turn
- Transcripts enable the `resume` feature — an agent can be resumed from its last state

### 12.2. Resume Flow

When a Task tool call includes `resume: "<agentId>"`:

1. Load the transcript from disk: `lf6(zf(agentId))`
2. Deserialize messages: `ng6(rg6(GX1(transcript)))`
3. Verify the agent isn't still running
4. Prepend the old messages to the new prompt
5. The agent continues with full history + new instructions

### 12.3. Output Files

Background agents write streaming output to:
```
~/.claude/sessions/<session-id>/<agent-id>.output
```

This file is append-only and can be read by:
- The `TaskOutput` tool (blocking or non-blocking)
- The `Read` tool (for direct file access)
- Bash `tail -f` for real-time following

---

## 13. Key Symbols Reference

Due to minification, all internal names are mangled. Here is a mapping of key symbols discovered during analysis:

| Minified Symbol | Meaning | Location |
|-----------------|---------|----------|
| `vy` | Inner message loop (main agentic loop) | Line ~505866 |
| `uR` | Outer agent loop (agent entry point) | Line ~507196 |
| `kc6` | StreamingToolExecutor class | Line ~505405 |
| `wZ6` | API streaming function | Line ~504126 |
| `p2q` | Low-level API call with retries | Line ~504220+ |
| `Fg6` | Individual tool execution generator | Line ~296737 |
| `Tm6` | Context cloning for subagents | Line ~246125 |
| `DG6` | AsyncLocalStorage.run wrapper | Line ~410700 |
| `CC4` | Auto-compaction function | Line ~359897 |
| `Jg` | Micro-compaction function | Referenced in vy |
| `v66` | Tool resolution for agents | Line ~483785 |
| `Pc6` | System prompt assembly | Line ~499884 |
| `N7z` | Agent system prompt builder | Line ~507420 |
| `mD6` | Task tool definition object | Line ~511186+ |
| `hK` | Task tool name constant | Referenced throughout |
| `Yk` | Explore agent definition | Line ~273569 |
| `yJ1` | Plan agent definition | Line ~273639 |
| `EB6` | general-purpose agent definition | Line ~273304 |
| `k34` | Bash agent definition | Line ~273291 |
| `K$4` | Create background agent task | Line ~298920+ |
| `Y$4` | Create foreground agent task | Line ~298949+ |
| `wT8` | Mark agent task as completed | Line ~298880+ |
| `$T8` | Mark agent task as failed | Line ~298900+ |
| `bw` | Output file path generator | Line ~130662 |
| `yq1` | Output file writer class | Line ~130665 |
| `s1` | Create user message helper | Referenced throughout |

---

## Appendix A: How Parallel Explore Works End-to-End

A typical scenario where Claude Code runs multiple Explore agents in parallel:

```
1. User asks: "How does the authentication system work?"

2. Main thread Claude (Opus) decides to spawn parallel searches:
   Response contains TWO tool_use blocks:
   - Task { subagent_type:"Explore", prompt:"Find auth middleware...", run_in_background:true }
   - Task { subagent_type:"Explore", prompt:"Find login routes...", run_in_background:true }

3. StreamingToolExecutor receives both Task calls.
   Task.isConcurrencySafe → delegates to isReadOnly → true for background spawning.
   Both execute in parallel.

4. Each Task call:
   a. Resolves the Explore agent definition (model: haiku)
   b. Generates the read-only system prompt
   c. Creates a background task entry (K$4)
   d. Launches DG6(sessionInfo, async () => { ... uR loop ... })
   e. Returns immediately: { status:"async_launched", agentId, outputFile }

5. Two independent Explore agents now run concurrently:
   Agent A (haiku):                    Agent B (haiku):
   ├── Grep for "auth"                ├── Grep for "login"
   ├── Read middleware files           ├── Read route files
   ├── Glob for *.auth.*              ├── Read controller files
   └── Return summary                 └── Return summary

6. Main thread receives both async_launched results.

7. Claude (Opus) processes results, may:
   - Use TaskOutput to wait for completion
   - Check the output files directly
   - Synthesize findings from both agents

8. Each agent writes findings to its output file.
   When done,  marks the task as completed in the global state.

9. Main thread reads results and produces final answer to user.
```

## Appendix B: Model Selection Logic

The model for an agent is resolved through a priority chain:

```
1. Explicit user override via tool input (model: "haiku")
2. Agent definition's model field (e.g., Explore defaults to "haiku")
3. Permission mode constraints (plan mode may force a specific model)
4. Main loop model (parent's model)
5. Global default model

Mapping: { opus: "claude-opus-4-6", sonnet: "claude-sonnet-4-6", haiku: "claude-haiku-4-5-20251001" }
```

## Appendix C: Feature Flags and Environment Variables

| Variable | Effect |
|----------|--------|
| `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | Disables all background/async agent execution |
| `CLAUDE_AUTO_BACKGROUND_TASKS` | Enables auto-promotion of sync agents to background after 120s |
| `DISABLE_COMPACT` | Disables auto-compaction |
| `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` | Controls prompt suggestion feature |
| `explore_agent_variant` | Feature flag: "restrictive" uses limited Explore agent |

---

## 14. Unique Implementation Details & Deep Insights

### 14.1. Streaming Tool Execution (Tools Start Before Response Finishes)

One of the most impactful design choices: tools begin executing **during** the API response stream, not after. When the model's response is still streaming and a complete `tool_use` JSON block has been received, it is immediately deserialized, validated, and queued for execution. This means:

- A `Read` tool call at the beginning of a response can finish before the model finishes generating subsequent tool calls
- File I/O, grep operations, and web fetches overlap with token generation
- For a response with 5 Read calls, all 5 may be complete before the model emits its final text

This is possible because the `StreamingToolExecutor` (`kc6`) is event-driven — `addTool()` triggers `processQueue()` immediately, and the queue can begin executing while the stream parser continues to receive tokens.

### 14.2. Smart Curly-Quote Normalization in Edit Tool

The Edit tool has a subtle but important feature: **smart quote normalization**. When the model generates `old_string` values, it sometimes uses Unicode curly quotes (`""''`) instead of ASCII straight quotes (`"'`). The code at line ~285960 handles this:

```
c36(fileContents, oldString):
  1. Try exact match first
  2. If no match, convert both to curly-quote-normalized form
  3. Find the position in the normalized version
  4. Return the original substring at that position
```

The `AP6` function then applies the reverse transformation to `new_string` to match the file's actual quoting style. This prevents "string not found" errors caused by the model's tendency to use typographic quotes.

### 14.3. Read-Before-Write Guard

Both the `Write` and `Edit` tools enforce a **read-before-write** invariant. Before any file modification, the system checks:

1. **Has the file been read?** — `readFileState.get(filePath)` must return a record. If not: `"File has not been read yet. Read it first before writing to it."` (error code 2)
2. **Is the file stale?** — Compares the file's current mtime (`Tk(filePath)`) against the timestamp in `readFileState`. If the file was modified externally (by user, linter, pre-commit hook): `"File has been modified since read... Read it again before attempting to write it."` (error code 3)
3. **Is the path allowed?** — Checks permission rules for the path (error code 1)

This prevents the model from blindly overwriting files it hasn't seen, and catches race conditions where external tools modify files between reads and writes.

### 14.4. File State Cache (LRU with Size Limit)

`readFileState` is an **LRU cache** (`mo7` class) with both count and byte-size limits:

```typescript
const MAX_ENTRIES = 100;      // BK6
const MAX_BYTES = 26_214_400; // 25MB (ok9)
```

Each entry stores:
- `timestamp`: when the file was last read (mtime at read time)
- File content metadata for cache validation

When a subagent is spawned, the cache is **deep-cloned** (`sU()`), giving the subagent its own independent file view. When merging caches (e.g., after parallel agents complete), the entry with the **latest timestamp wins** (`NM6()`).

### 14.5. File Index: Native Rust Module with Fuse.js Fallback

The file suggestion system has a two-tier architecture:

1. **Primary: Rust-based `FileIndex`** — A native Node.js addon (`file-index.node`) loaded via `require()`. It:
   - Loads the full file list into a Rust data structure
   - Performs fast fuzzy matching for file path suggestions
   - Is used in the autocomplete/suggestion UI

2. **Fallback: Fuse.js** — When the native module fails to load (wrong platform, missing binary), the system falls back to JavaScript-based Fuse.js fuzzy search

File lists are populated via:
- `git ls-files --recurse-submodules` (tracked files, with 5s timeout)
- Background `git ls-files --others --exclude-standard` (untracked files, with 10s timeout)
- Ripgrep `--files` fallback when not in a git repo
- `.ignore` and `.rgignore` patterns are respected

### 14.6. Bash Command Sandboxing

Claude Code sandboxes Bash commands on a per-platform basis:

#### macOS: `sandbox-exec` Profiles
Commands are wrapped with Apple's `sandbox-exec -p <profile>` mechanism. The generated Seatbelt profile controls:
- **Network**: HTTP/SOCKS proxy ports, unix socket access, local binding
- **File read**: `allowAllExcept` (deny specific paths) or `denyAllExcept` (allow specific paths)
- **File write**: Same as read, separately configurable
- **PTY access**: Controlled per-command
- **Git config**: Separately allowed/denied

A log monitor process watches macOS sandboxing logs in real-time to detect and report denied operations.

#### Linux: Seccomp BPF Filters
Uses pre-compiled BPF (Berkeley Packet Filter) programs to block `socket(AF_UNIX, ...)` syscalls:
- Architecture-specific filters: `x64` and `arm64`
- Located at `vendor/seccomp/<arch>/unix-block.bpf`
- Applied via `apply-seccomp` helper binary from a sandbox-runtime package
- HTTP/SOCKS bridge proxies for controlled network access

#### Configuration
```typescript
settings.sandbox = {
  additionalWritePaths: string[];  // Extra write-allowed paths
  additionalDenyWritePaths: string[];  // Extra write-denied paths
  additionalDenyReadPaths: string[];   // Extra read-denied paths
  allowUnsandboxedCommands: boolean;   // Allow dangerouslyDisableSandbox param
};
```

### 14.7. Two-Tier Context Compaction

The system has **two distinct compaction mechanisms** that work together:

#### Micro-Compaction (`Jg`) — Per-Turn Trimming
Runs before every API call. It:
1. Identifies tool results that are candidates for compaction (tracked in `aDY` set — specific tool types)
2. Keeps the **3 most recent** tool results untouched (`rDY = 3`)
3. For older tool results exceeding the budget:
   - Saves the full content to disk (`ou6()`)
   - Replaces inline content with: `"Tool result saved to: <filepath>\n\nUse Read to view"`
   - This is the source of the "persisted output" messages you see in tool results
4. Also strips old images/documents from user messages, replacing with `"[image]"` / `"[document]"` placeholders (saves ~2000 tokens each)
5. Only activates when above warning threshold AND savings exceed 20,000 tokens (`iDY`)
6. Cleans corresponding entries from `readFileState` to force re-reads of now-compacted files

Constants:
```typescript
const MICRO_COMPACT_MIN_SAVINGS = 20000;  // iDY - minimum token savings to trigger
const MICRO_COMPACT_BUDGET = 40000;       // nDY - target budget for auto mode
const KEEP_RECENT_N = 3;                   // rDY - recent results to keep
const IMAGE_TOKEN_ESTIMATE = 2000;         // bL8 - estimated tokens per image
```

#### Auto-Compaction (`CC4`) — Full Conversation Summary
Triggers when total tokens exceed the model's context window threshold. It:
1. Fires `PreCompact` hooks (can inject custom instructions)
2. Makes a separate API call to summarize the entire conversation
3. Clears the `readFileState` cache entirely
4. Re-runs session initialization (file attachments, memory files)
5. Replaces all old messages with the summary + fresh state

Thresholds:
```typescript
const WARNING_THRESHOLD = contextWindow - 20000;
const ERROR_THRESHOLD = contextWindow - 20000;     // same, different UI treatment
const BLOCKING_LIMIT = maxOutputTokens - 3000;      // hard stop
```

### 14.8. Auto-Memory / Session Notes System

Claude Code has a background "note-taking" agent that automatically maintains session notes:

1. **Trigger conditions**: Runs after minimum 10,000 tokens of conversation, then every 5,000 tokens or 3 tool calls
2. **Mechanism**: Spawns a hidden agent with `Edit` tool that updates `~/.claude/sessions/.../session-memory/notes.md`
3. **Template**: A structured markdown file with sections like "Task specification", "Current State", "Key results"
4. **Constraints on the note-taker**:
   - Must NOT reference the note-taking process itself
   - Must preserve all section headers and italic description lines
   - Makes all edits in parallel (single message, multiple Edit calls)
   - Limited to ~N tokens per section to prevent unbounded growth
   - Must update "Current State" section on every pass (critical for compaction continuity)
5. **These notes survive compaction** — they're re-injected after auto-compaction, providing continuity even when conversation history is summarized

### 14.9. API Retry and Model Fallback

The retry system (`$O1`) implements a sophisticated cascade:

```
API Call
  │
  ├── 401 Unauthorized → Re-authenticate (refresh token), retry
  ├── 429 Rate Limit (fast mode) → Check overage header
  │     ├── overage-disabled → Disable fast mode, retry immediately
  │     ├── retry-after < threshold → Wait and retry in fast mode
  │     └── retry-after >= threshold → Disable fast mode, continue
  ├── 529 Overloaded (fast mode) → Disable fast mode, retry
  ├── 529 Overloaded (normal) → Increment overload counter
  │     ├── counter >= threshold → Trigger fallback model (if configured)
  │     └── counter < threshold → Retry with backoff
  ├── 5xx Server Error → Retry with exponential backoff
  ├── Network Error → Retry with backoff
  └── Other Error → Throw (no retry)
```

Key behaviors:
- **Fast mode** (same model, faster output) can be automatically disabled on overload/rate-limit
- **Fallback model**: If configured via `--fallback-model`, switches to it after repeated 529s
- Retry count is configurable per-call, defaults vary by context

### 14.10.  UI Architecture: React + Ink

The terminal UI is built with:
- **React** (bundled, not imported from node_modules) — the full React 18+ runtime
- **Ink** — React renderer for CLI applications
- **Zustand**-pattern state management via `G1()` selector hook

The UI renders:
- Tool use progress with spinners and live updates
- File diffs with syntax highlighting (via tree-sitter grammars)
- Permission prompts
- Agent task status with token/tool counts
- Markdown rendering in terminal

### 14.11. Telemetry System ("Tengu")

Internally codenamed "Tengu", the telemetry system tracks events via OpenTelemetry:

```typescript
r("tengu_<event_name>", { ...properties })
```

Key tracked events include:
- `tengu_tool_use_error` — tool execution failures
- `tengu_compact` — compaction events (pre/post token counts)
- `tengu_microcompact` — micro-compaction statistics
- `tengu_model_fallback_triggered` — model fallback events
- `tengu_stop_hook_error` — hook failures
- `tengu_api_opus_fallback_triggered` — API-level model fallback
- `tengu_session_quality_classification` — session quality assessment
- `tengu_file_suggestions_git_ls_files` — file index performance

Token usage is tracked via OpenTelemetry counters (`i1.tokenCounter`) with metrics for:
- Input tokens, output tokens
- Cache read tokens, cache creation tokens
- Service tier (standard/priority/batch)

### 14.12. MCP (Model Context Protocol) Integration

MCP servers are first-class citizens with:
- Dynamic tool registration — MCP tools are discovered and registered alongside built-in tools
- Tool name prefixing: `mcp__<server>__<tool>` naming convention
- `readOnlyHint` annotation determines concurrency safety
- Per-agent MCP server requirements (`requiredMcpServers`)
- Agents can specify their own MCP server connections that are connected on start and disconnected on cleanup

### 14.13. Skill System

Skills are markdown files with frontmatter that define reusable behaviors:
- Stored in `.claude/skills/` directories
- Can be user-invocable (like `/commit`, `/review-pr`) or auto-invocable
- Preloaded into agents via the `skills` field in agent definitions
- Skills are injected as user messages at the start of the agent loop
- Dynamic skill directories are tracked and trigger auto-loading when files are written to them

---

## 15. Building a Claude Code Clone from Ground Up

Based on the architecture analysis, here is a comprehensive blueprint for building a similar system.

### 15.1. Technology Stack Recommendations

| Component | Claude Code Uses | Recommendation for a Clone |
|-----------|-----------------|---------------------------|
| Runtime | Node.js >= 18 | Node.js or Bun (native ESM) |
| Bundler | Bun | esbuild or Bun (single-file output) |
| Terminal UI | Ink (React for CLI) | Ink, or blessed/blessed-contrib, or raw ANSI |
| State Management | Zustand-like pattern | Zustand or simple event emitter |
| Schema Validation | Zod | Zod |
| Code Search | Vendored ripgrep | ripgrep (shell out) or @vscode/ripgrep |
| File Fuzzy Find | Rust native addon + Fuse.js | fzf or Fuse.js |
| Diff | `diff` npm package | `diff` or `jsdiff` |
| API Client | `@anthropic-ai/sdk` | `@anthropic-ai/sdk` |
| Process Isolation | AsyncLocalStorage | AsyncLocalStorage |
| Sandbox | sandbox-exec (macOS), seccomp (Linux) | Start without, add later |

### 15.2. Core Architecture: Step-by-Step Build Order

#### Phase 1: Minimal Agentic Loop

Build the fundamental loop first — everything else is layered on top.

```typescript
// 1. Basic message loop
async function* agenticLoop(systemPrompt, userMessage, tools) {
  const messages = [{ role: "user", content: userMessage }];

  while (true) {
    // Call API
    const response = await anthropic.messages.create({
      model: "claude-sonnet-4-6",
      system: systemPrompt,
      messages,
      tools: tools.map(t => t.definition),
      max_tokens: 16384,
    });

    // Yield assistant message
    yield { type: "assistant", content: response.content };
    messages.push({ role: "assistant", content: response.content });

    // Extract tool calls
    const toolCalls = response.content.filter(b => b.type === "tool_use");
    if (toolCalls.length === 0) break; // No tools = done

    // Execute tools and collect results
    const results = await executeTools(toolCalls, tools);
    messages.push({ role: "user", content: results });

    yield { type: "tool_results", results };
  }
}
```

#### Phase 2: Tool System

Define the tool interface and implement core tools:

```typescript
interface Tool {
  name: string;
  definition: { name: string; description: string; input_schema: object };
  isConcurrencySafe: (input: any) => boolean;
  execute: (input: any, context: ToolContext) => AsyncGenerator<ToolEvent>;
  checkPermissions: (input: any) => Promise<"allow" | "deny" | "ask">;
}

// Implement in this order:
// 1. Read (file reading with line numbers)
// 2. Write (file creation/overwrite)
// 3. Edit (old_string → new_string replacement)
// 4. Glob (file pattern matching)
// 5. Grep (content search via ripgrep)
// 6. Bash (command execution)
// 7. Task (agent spawning) — Phase 4
```

#### Phase 3: Streaming + Parallel Tool Execution

This is the performance-critical piece. Build the `StreamingToolExecutor`:

```typescript
class StreamingToolExecutor {
  private queue: ToolExecution[] = [];

  addTool(toolUse: ToolUseBlock, tools: Tool[]) {
    const tool = tools.find(t => t.name === toolUse.name);
    const isSafe = tool.isConcurrencySafe(toolUse.input);
    this.queue.push({ id: toolUse.id, tool, input: toolUse.input,
                      status: "queued", isSafe });
    this.processQueue();
  }

  private canExecute(isSafe: boolean): boolean {
    const executing = this.queue.filter(t => t.status === "executing");
    return executing.length === 0 ||
           (isSafe && executing.every(t => t.isSafe));
  }

  private async processQueue() {
    for (const item of this.queue) {
      if (item.status !== "queued") continue;
      if (this.canExecute(item.isSafe)) {
        item.status = "executing";
        item.promise = this.executeTool(item)
          .finally(() => this.processQueue()); // Chain next
      } else if (!item.isSafe) {
        break; // Non-safe tool blocks the queue
      }
    }
  }
}
```

Key insight: Connect this to the **streaming API response**. As tool_use blocks are parsed from the stream, call `addTool()` immediately — don't wait for the full response.

#### Phase 4: Sub-Agent System

The Task tool spawns child agents with isolated contexts:

```typescript
async function spawnAgent(definition: AgentDef, prompt: string,
                          parentContext: Context, background: boolean) {
  // 1. Clone context with isolation
  const childContext = {
    readFileState: new Map(parentContext.readFileState), // Clone
    abortController: createChildAbort(parentContext.abortController),
    agentId: crypto.randomUUID(),
    depth: parentContext.depth + 1,
  };

  // 2. Resolve tools for this agent type
  const tools = resolveTools(definition.tools, definition.disallowedTools);

  // 3. Build system prompt
  const systemPrompt = definition.getSystemPrompt(childContext);

  if (background) {
    // Fire-and-forget: return immediately, write to output file
    const outputFile = `~/.myagent/sessions/${sessionId}/${childContext.agentId}.output`;
    launchBackground(childContext, systemPrompt, prompt, tools, outputFile);
    return { status: "async_launched", agentId: childContext.agentId, outputFile };
  } else {
    // Synchronous: block until complete
    return await runAgent(childContext, systemPrompt, prompt, tools);
  }
}
```

#### Phase 5: Context Management

Implement compaction to handle long sessions:

```typescript
// Micro-compaction: Save large tool results to disk
function microCompact(messages: Message[]): Message[] {
  const KEEP_RECENT = 3;
  const toolResults = findToolResults(messages);
  const toCompact = toolResults.slice(0, -KEEP_RECENT);

  return messages.map(msg => {
    if (isCompactable(msg, toCompact)) {
      const file = saveToDisk(msg.content);
      return { ...msg, content: `Result saved to: ${file}` };
    }
    return msg;
  });
}

// Auto-compaction: Summarize when near context limit
async function autoCompact(messages: Message[], model: string): Message[] {
  const tokenCount = estimateTokens(messages);
  const threshold = getContextWindow(model) - 20000;

  if (tokenCount < threshold) return messages;

  const summary = await anthropic.messages.create({
    model,
    system: "Summarize this conversation concisely...",
    messages: [{ role: "user", content: formatForSummary(messages) }],
    max_tokens: 8192,
  });

  return [{ role: "user", content: `Previous conversation summary:\n${summary}` }];
}
```

#### Phase 6: Permission System

```typescript
type Permission = "allow" | "deny" | "ask";

async function checkToolPermission(tool: Tool, input: any,
                                    rules: PermissionRule[]): Promise<Permission> {
  // 1. Check explicit allow/deny rules
  for (const rule of rules) {
    if (rule.matches(tool.name, input)) return rule.permission;
  }

  // 2. Read-only tools auto-allowed in most modes
  if (tool.isConcurrencySafe(input)) return "allow";

  // 3. Ask user for write/execute tools
  return "ask";
}
```

#### Phase 7: Read-Before-Write Guard

```typescript
const readFileState = new LRUCache<string, { timestamp: number }>({
  max: 100,
  maxSize: 25 * 1024 * 1024,
});

function validateWrite(filePath: string): { ok: boolean; error?: string } {
  const record = readFileState.get(filePath);
  if (!record) {
    return { ok: false, error: "File has not been read yet." };
  }
  if (fs.statSync(filePath).mtimeMs > record.timestamp) {
    return { ok: false, error: "File modified since last read." };
  }
  return { ok: true };
}
```

#### Phase 8: Session Persistence and Resume

```typescript
// Save after each turn
async function saveTranscript(agentId: string, messages: Message[]) {
  const path = `~/.myagent/sessions/${sessionId}/${agentId}.transcript`;
  await fs.writeFile(path, JSON.stringify(messages));
}

// Resume from saved state
async function resumeAgent(agentId: string, newPrompt: string) {
  const transcript = JSON.parse(
    await fs.readFile(`~/.myagent/sessions/${sessionId}/${agentId}.transcript`)
  );
  return runAgent(context, systemPrompt, newPrompt, tools, transcript);
}
```

### 15.3. Critical Design Decisions Summary

| Decision | Claude Code's Choice | Why |
|----------|---------------------|-----|
| **When to parallelize tools** | Only read-only + concurrency-safe | Prevents race conditions on file writes |
| **When to start tool execution** | During streaming, before response completes | Saves latency — I/O overlaps with generation |
| **Agent isolation model** | Cloned context + child AbortController | Parent can cancel children, not vice versa |
| **File state tracking** | LRU cache with mtime validation | Prevents stale writes, bounded memory |
| **Compaction strategy** | Two-tier (micro + auto) | Micro is incremental/fast; auto is a full reset |
| **Explore agent model** | Haiku (cheapest) | Speed + cost for read-only exploration tasks |
| **Background agent output** | Append-only file | Simple, no coordination needed, readable by any tool |
| **Error in parallel batch** | Cancel pending siblings | Prevents cascading failures from bad inputs |
| **Session context** | AsyncLocalStorage | Implicit context propagation across async boundaries |
| **Note-taking** | Hidden agent that auto-edits markdown | Survives compaction; provides continuity |

### 15.4. Minimum Viable Agent (Under 500 Lines)

A stripped-down version with just the core loop, basic tools, and no UI would need:

1. **Agentic loop** (~80 lines): Stream API, parse tool calls, loop
2. **Tool executor** (~60 lines): Queue + concurrency check + execute
3. **Read tool** (~30 lines): Read file with line numbers
4. **Edit tool** (~50 lines): old_string/new_string replacement + mtime check
5. **Write tool** (~20 lines): Create/overwrite file
6. **Bash tool** (~40 lines): Spawn process, capture output, timeout
7. **Glob tool** (~20 lines): Fast file path matching
8. **Grep tool** (~30 lines): Shell out to ripgrep
9. **Task tool** (~80 lines): Spawn subagent with context clone
10. **Context management** (~50 lines): Token estimate + truncation
11. **CLI entry** (~40 lines): Arg parsing, session init, REPL

Total: ~500 lines of TypeScript for a functional prototype. Add ~300 more for permission prompts, file state tracking, and session persistence.

---

*This reference architecture describes the patterns and design decisions for building a production-grade AI coding agent.
