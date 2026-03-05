# How Skills Are Invoked in Coding Agents & Token Management Best Practices

> **Author:** AI Engineer Skills Research  
> **Date:** 2026-02-25  
> **Scope:** Claude Code, GitHub Copilot, open-source agents — skill systems, token consumption, context engineering

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [What Are Agent Skills?](#what-are-agent-skills)
3. [The SKILL.md Open Standard](#the-skillmd-open-standard)
4. [How Skills Are Discovered and Invoked](#how-skills-are-discovered-and-invoked)
   - [Claude Code](#claude-code)
   - [GitHub Copilot](#github-copilot)
   - [Our Codingagent](#our-codingagent)
5. [Token Consumption Breakdown](#token-consumption-breakdown)
   - [Where Tokens Go](#where-tokens-go)
   - [Skills vs MCP Token Patterns](#skills-vs-mcp-token-patterns)
   - [Real-World Token Budget](#real-world-token-budget)
6. [Progressive Disclosure: The Key Architecture](#progressive-disclosure-the-key-architecture)
7. [Context Engineering: The Four Core Techniques](#context-engineering-the-four-core-techniques)
8. [Compaction: When Context Gets Too Large](#compaction-when-context-gets-too-large)
   - [Server-Side Compaction (Anthropic API)](#server-side-compaction-anthropic-api)
   - [Client-Side Compaction (Our Codingagent)](#client-side-compaction-our-codingagent)
   - [Claude Code's Auto-Compaction](#claude-codes-auto-compaction)
9. [Best Practices for Token Optimization](#best-practices-for-token-optimization)
10. [Anti-Patterns to Avoid](#anti-patterns-to-avoid)
11. [Skills vs MCP: When to Use Which](#skills-vs-mcp-when-to-use-which)
12. [Our Codingagent's Implementation](#our-codingagents-implementation)
13. [Sources](#sources)

---

## Executive Summary

Agent skills are **modular instruction packages** that extend a coding agent's capabilities. They are not code that runs — they are **prompt expansions** loaded on-demand into the model's context window.

The critical insight: **every skill adds tokens to every API call it's active in**. Skills, tool definitions, system prompts, conversation history, and tool results all compete for the same finite context window (typically 200K tokens). Managing this budget is the single most important factor in agent performance.

This report covers:
- How skills are structured, discovered, and invoked across platforms
- Exactly where tokens go in a coding agent session
- The four core techniques for managing context efficiently
- How compaction works when context gets too large
- Concrete best practices for minimizing token waste

---

## What Are Agent Skills?

Skills are **self-contained folders** that package expertise into discoverable, on-demand capabilities for AI coding agents. Each skill contains:

- A **`SKILL.md`** file with YAML frontmatter (metadata) and Markdown instructions
- Optional **scripts** the agent can execute
- Optional **reference files** loaded only when needed
- Optional **templates** and **assets**

```
pdf-processor/
├── SKILL.md           # Core instructions (~2-4K tokens)
├── REFERENCE.md       # Additional docs (loaded if needed)
├── extract_text.py    # Executable script
└── templates/
    └── output.json    # Output template
```

Skills are **not separate processes, sub-agents, or external tools**. They are **injected instructions** that guide the agent's behavior within the main conversation. When invoked, the skill's `SKILL.md` body is loaded into the context window as additional prompt text.

### Skills vs Custom Instructions vs MCP

| Feature | Skills | Custom Instructions | MCP (Model Context Protocol) |
|---------|--------|-------------------|------------------------------|
| **Purpose** | Teach specialized capabilities and workflows | Define coding standards and guidelines | Standardized tool interfaces for external APIs |
| **Loading** | On-demand (progressive disclosure) | Always loaded | Tool definitions always loaded |
| **Content** | Instructions, scripts, examples, resources | Instructions only | Tool schemas + API calls |
| **Portability** | Open standard ([agentskills.io](https://agentskills.io)) | Platform-specific | Anthropic ecosystem (expanding) |
| **Token pattern** | Progressive (pay for what you use) | Fixed cost every request | Fixed definitions + variable call/response |

---

## The SKILL.md Open Standard

Agent Skills is an **open standard** defined at [agentskills.io](https://agentskills.io/specification), supported by:
- **Claude Code** (Anthropic)
- **GitHub Copilot** (VS Code, CLI, coding agent)
- **Codex CLI** (OpenAI)
- **Gemini CLI** (Google)

### File Format

```markdown
---
name: webapp-testing
description: Guide for testing web applications using Playwright. Use when asked to create or run browser-based tests.
license: Apache-2.0
metadata:
  author: example-org
  version: "1.0"
---

# Web Application Testing with Playwright

## When to use this skill
Use this skill when you need to:
- Create new Playwright tests for web applications
- Debug failing browser tests

## Creating tests
1. Review the [test template](./test-template.js)
2. Identify the user flow to test
3. Use Playwright's locators to find elements
...
```

### Frontmatter Fields

| Field | Required | Constraints |
|-------|----------|-------------|
| `name` | Yes | Max 64 chars. Lowercase letters, numbers, hyphens only. Must match parent directory name. |
| `description` | Yes | Max 1024 chars. Describes what the skill does AND when to use it. |
| `license` | No | License name or reference to bundled file. |
| `compatibility` | No | Max 500 chars. Environment requirements. |
| `metadata` | No | Arbitrary key-value mapping. |
| `allowed-tools` | No | Space-delimited list of pre-approved tools. (Experimental) |
| `user-invokable` | No | Whether it appears as a slash command. Default: `true`. |
| `disable-model-invocation` | No | Whether the agent can auto-load it. Default: `false`. |

### Skill Locations

| Location | Scope | Platform |
|----------|-------|----------|
| `~/.claude/skills/` | Personal (all projects) | Claude Code |
| `.claude/skills/` | Project (team) | Claude Code |
| `~/.copilot/skills/` | Personal | GitHub Copilot |
| `.github/skills/` | Project | GitHub Copilot |
| `~/.agents/skills/` | Personal | Cross-platform |
| `.agents/skills/` | Project | Cross-platform |

---

## How Skills Are Discovered and Invoked

### Claude Code

Claude Code implements skills through a **tool-based invocation mechanism**. This was documented from observing actual Claude Code sessions:

#### Step 1: Discovery (at session start)

Claude Code registers a `Skill` tool with a description that embeds an `<available_skills>` list built from the YAML frontmatter of all discovered skills:

```xml
<available_skills>
  <skill>
    <name>pdf</name>
    <description>
      Extract and analyze text from PDF documents. Use when users
      ask to process or read PDFs.
    </description>
    <location>user</location>
  </skill>
  <skill>
    <name>csv</name>
    <description>
      Analyze and visualize CSV data.
    </description>
    <location>project</location>
  </skill>
</available_skills>
```

**Token cost: ~100 tokens per skill** (just name + description).

#### Step 2: Model decides to invoke

When the user's request matches a skill's description, Claude sends a tool_use call:

```json
{
  "type": "tool_use",
  "name": "Skill",
  "input": { "command": "pdf" }
}
```

#### Step 3: Instructions are loaded

The system responds with a tool_result containing the full `SKILL.md` body (without frontmatter) plus the base path:

```json
{
  "type": "tool_result",
  "content": "Base Path: /Users/username/.claude/skills/pdf/\n\n# PDF Processing Skill\n\nUse the extract_text.py script in this folder to extract text from PDFs:\n\n    python3 extract_text.py <input_file>\n\nAfter extraction, summarize the key points..."
}
```

**Token cost: 2,000–5,000 tokens** (the full SKILL.md body).

#### Step 4: Agent follows instructions

From this point, Claude follows the expanded instructions — running scripts, reading reference files, etc. — all within the main conversation. Skills are not sub-agents; they're prompt expansions.

### GitHub Copilot

Copilot uses the same SKILL.md format and progressive disclosure model:

1. **Level 1 (Discovery)**: Copilot reads `name` and `description` from frontmatter — lightweight metadata only
2. **Level 2 (Instructions)**: When the request matches, Copilot loads the full `SKILL.md` body
3. **Level 3 (Resources)**: Additional files in the skill directory are accessed only as needed

Copilot supports both **automatic loading** (model decides) and **slash command invocation** (`/skill-name`).

Configuration options:

| Configuration | Slash Command | Auto-loaded by Copilot | Use Case |
|---------------|--------------|----------------------|----------|
| Default | Yes | Yes | General-purpose skills |
| `user-invokable: false` | No | Yes | Background knowledge |
| `disable-model-invocation: true` | Yes | No | On-demand only |
| Both set | No | No | Disabled |

### Our Codingagent

Our codingagent (`skills.ts`) implements a unified skill + memory system that reads from **all** major agent platforms:

#### Memory Hierarchy (loaded at startup, in priority order)

| Priority | Source | Platform |
|----------|--------|----------|
| 10 | `~/.claude/CLAUDE.md` | Claude Code (user) |
| 10 | `~/.codex/AGENTS.md` | OpenAI Codex (user) |
| 20 | `./CLAUDE.md` or `.claude/CLAUDE.md` | Claude Code (project) |
| 20 | `.github/copilot-instructions.md` | GitHub Copilot |
| 20 | `./AGENTS.md` | OpenAI Codex (project) |
| 20 | `./GEMINI.md` | Google Gemini |
| 25 | `.claude/rules/*.md` | Claude Code (modular rules) |
| 25 | `.github/instructions/*.instructions.md` | GitHub Copilot (path-scoped) |
| 30 | `./CLAUDE.local.md` | Claude Code (personal, highest priority) |

#### Skill Discovery

Skills are loaded from directories configured in `skillDirs` (defaults: `~/.claude/skills/`, `.claude/skills/`). Each SKILL.md is parsed for:
- `name` and `description` from frontmatter
- Full instructions from the markdown body
- Optional settings: `disable-model-invocation`, `user-invocable`, `allowed-tools`, `context` (fork/inline)

#### Skill Invocation in System Prompt

Model-invocable skills are listed in the system prompt:

```
Available skills (can be invoked via slash commands):
- /angular-architect: Senior Angular developer...
- /python-pro: Senior Python developer...
- /typescript-pro: Senior TypeScript developer...
```

When invoked (via `/skill-name` or model decision), `$ARGUMENTS` substitution is applied and the instruction body is injected.

**Key difference from Claude Code**: Our codingagent lists skill descriptions in the **system prompt** rather than in a tool definition. This means the skill descriptions are sent on **every API call**, not loaded via a tool_use/tool_result cycle.

---

## Token Consumption Breakdown

### Where Tokens Go

Every API call to the LLM includes these components, all competing for the same context window:

```
┌──────────────────────────────────────────────────────────────────┐
│                    Context Window (200K tokens)                  │
│                                                                  │
│  ┌────────────────────────────────┐                              │
│  │ System Prompt                  │  ~500–2,000 tokens           │
│  │ (base instructions)            │                              │
│  ├────────────────────────────────┤                              │
│  │ Memory / CLAUDE.md             │  ~200–2,000 tokens           │
│  │ (project instructions)         │                              │
│  ├────────────────────────────────┤                              │
│  │ Skill Descriptions             │  ~100 tokens × N skills      │
│  │ (metadata only, at startup)    │                              │
│  ├────────────────────────────────┤                              │
│  │ Tool Definitions               │  ~100–300 tokens × N tools   │
│  │ (Read, Write, Bash, etc.)      │  (sent EVERY request)        │
│  ├────────────────────────────────┤                              │
│  │ Hidden Tool Use Prompt         │  ~346 tokens (Anthropic)     │
│  │ (injected by API layer)        │                              │
│  ├────────────────────────────────┤                              │
│  │ MCP Tool Definitions           │  ~100–300 tokens × N tools   │
│  │ (from connected MCP servers)   │  (sent EVERY request)        │
│  ├────────────────────────────────┤                              │
│  │ Active Skill Instructions      │  ~2,000–5,000 tokens         │
│  │ (loaded when skill invoked)    │  (only when active)          │
│  ├────────────────────────────────┤                              │
│  │ Conversation History           │  Variable — DOMINANT         │
│  │ (all messages + tool results)  │  Grows with every turn       │
│  ├────────────────────────────────┤                              │
│  │ Reserved Buffer                │  ~33K tokens (Claude Code)   │
│  │ (for compaction + response)    │  Can't be used               │
│  └────────────────────────────────┘                              │
└──────────────────────────────────────────────────────────────────┘
```

### Typical Token Budget for a Coding Session

| Component | Tokens | % of 200K | Sent Every Request? |
|-----------|--------|-----------|---------------------|
| System prompt | ~1,000 | 0.5% | ✅ Yes |
| CLAUDE.md / memory | ~1,000 | 0.5% | ✅ Yes |
| Skill descriptions (10 skills) | ~1,000 | 0.5% | ✅ Yes |
| Tool definitions (15 built-in tools) | ~3,000 | 1.5% | ✅ Yes |
| Hidden tool use prompt (Anthropic) | ~346 | 0.2% | ✅ Yes |
| MCP tool definitions (10 MCP tools) | ~2,000 | 1.0% | ✅ Yes |
| Active skill instructions | ~3,000 | 1.5% | Only when active |
| **Conversation history** | **~120,000+** | **60%+** | ✅ Yes (grows) |
| Compaction buffer | ~33,000 | 16.5% | Reserved |
| **Usable for new content** | **~35,000** | **17.5%** | — |

**Key insight**: The **conversation history** (messages + tool results) dominates token usage. A single file read can add 5,000–50,000+ tokens. Ten tool calls in a session can easily consume 100K+ tokens.

### Skills vs MCP Token Patterns

| Scenario | Skills | MCP |
|----------|--------|-----|
| 10 capabilities installed, none used | ~1,000 tokens (metadata only) | ~2,000 tokens (full definitions) |
| 1 capability activated | +2,000–5,000 tokens | ~200 tokens (call + response) |
| Complex operation with scripts | Script output only (~100 tokens) | N/A |
| Simple API call | ~3,000 tokens total | ~400 tokens |
| Heavy reference docs needed | +5,000–20,000 tokens | N/A |

**Skills are more efficient** when capabilities are installed but rarely used (progressive disclosure).  
**MCP is more efficient** for frequent, simple API calls (fixed schema overhead).

---

## Progressive Disclosure: The Key Architecture

Progressive disclosure is the core architectural pattern that makes skills token-efficient:

```
Tier 1: Metadata Scanning     (~100 tokens per skill)
  ↓ Always loaded — just name + description
  ↓
Tier 2: Full Instructions      (~2,000–5,000 tokens)
  ↓ Loaded ONLY when skill is activated
  ↓
Tier 3: Reference Files        (Variable)
  ↓ Loaded ONLY when specifically needed
  ↓
Tier 4: Script Execution       (Output only)
    Script code never enters context — only the output does
```

### Why This Matters

Without progressive disclosure, 10 skills × 3,000 tokens each = **30,000 tokens loaded on every request** — even if none are used. With progressive disclosure, that's **only 1,000 tokens** (10 × 100 for metadata).

### Script Execution: The Ultimate Token Saver

When a skill runs a script, the script's source code **never enters the context window**. Only the output does:

```python
# This script code = 0 tokens in context
def validate_pdf(path):
    # 50 lines of Python...
    return "Validation passed: 3 pages, 2 tables detected"

# Only this output consumes tokens: ~15 tokens
```

This is **extremely efficient** for complex operations. A 500-line Python script that would be ~5,000 tokens as inline instructions costs only ~50 tokens as script output.

---

## Context Engineering: The Four Core Techniques

Context engineering is the discipline of managing what information reaches the model. It encompasses four core techniques:

### 1. Offloading (Summarization + Reference Management)

Replace large tool results with concise summaries, storing full data externally:

```
❌ Load entire 50KB file into context
✅ Summarize key points, store full file as reference
```

**Our codingagent's implementation**: `microCompact()` in `compaction.ts` replaces large tool results (>10KB) with truncation notices, keeping only the 3 most recent results intact:

```
[Result truncated — was 52,341 chars. Re-run the tool if needed.]
```

### 2. Reduction (Compacting Context Over Time)

Periodically summarize conversation history into a condensed form:

```
100 messages (~150K tokens)  →  Summary + last 6 messages (~10K tokens)
```

**Our codingagent's implementation**: `autoCompact()` triggers when estimated tokens exceed the compaction threshold, using a smaller/faster model to generate a summary.

### 3. Retrieval (RAG — Dynamic Context Loading)

Load information on-demand rather than pre-loading everything:

```
❌ Load entire codebase into context at startup
✅ Use Grep/Glob to find relevant files when needed
```

This is what skills do — progressive disclosure is a form of retrieval. The agent discovers what it needs and loads it just-in-time.

### 4. Isolation (Sub-agents and Task Separation)

Run complex investigations in separate context windows:

```
Main Context:  "Use a subagent to investigate how auth works"
  └─ Sub-agent:  Reads 20 files, explores codebase, reports summary (~500 tokens)
     (consumed 50K tokens internally, but main context only sees the summary)
```

**Our codingagent's skill support**: Skills with `context: "fork"` run in an isolated sub-agent context, preventing their exploration from consuming the main conversation's token budget.

---

## Compaction: When Context Gets Too Large

### Server-Side Compaction (Anthropic API)

Anthropic now offers **server-side compaction** (beta, `compact-2026-01-12`):

```json
{
  "model": "claude-sonnet-4-6",
  "messages": [...],
  "context_management": {
    "edits": [{
      "type": "compact_20260112",
      "trigger": { "type": "token_count", "tokens": 150000 },
      "pause_after_compaction": false,
      "instructions": null
    }]
  }
}
```

How it works:
1. API detects when input tokens exceed the trigger threshold
2. Generates a summary of the conversation in a `compaction` block
3. On subsequent requests, all messages before the compaction block are dropped
4. Conversation continues from the summary

### Client-Side Compaction (Our Codingagent)

Our codingagent implements its own compaction in `compaction.ts`:

#### Token Estimation

```typescript
// ~4 chars per token, with structural overhead
export function estimateTokens(messages: Message[], systemPromptLength?: number): number {
  let chars = systemPromptLength ?? 0;
  for (const msg of messages) {
    chars += 16; // per-message overhead (role label, delimiters)
    // ... count all content block types
  }
  return Math.ceil(chars / 4);
}
```

#### Micro-Compaction (After Every Turn)

Runs after every tool execution. Replaces large tool results/inputs (>10KB) with truncation notices, keeping only the 3 most recent:

```
Before: [assistant] Write file (23,456 chars of content)
After:  [assistant] Write file {file_path: "foo.ts", _truncated: "[Input truncated — was 23,456 chars]"}
```

#### Full Compaction (When Threshold Exceeded)

Triggers when estimated tokens exceed the configurable threshold:

1. **Builds a conversation summary** using the `smallModel` (e.g., `claude-haiku`)
2. **Keeps the last 6 messages** (recent context), finding a clean split boundary that doesn't break tool_use/tool_result pairs
3. **Replaces everything else** with: `[Previous conversation summary] + summary text`
4. **Falls back to truncation** if the summarization API call fails

The summary prompt preserves:
- Exact file paths
- Exact function/variable/class names (verbatim, not paraphrased)
- Code changes made (what was added/modified/deleted, in which files)
- Chronological order of operations
- Line numbers from edits
- Errors encountered and resolutions
- Key decisions and rationale
- Current task and next steps

### Claude Code's Auto-Compaction

| Parameter | Current (2026) | Previous |
|-----------|---------------|----------|
| Compaction buffer | ~33K tokens (16.5%) | ~45K tokens (22.5%) |
| Compaction trigger | ~83.5% usage (~167K tokens) | ~77-78% usage (~155K) |
| Usable context | ~167K tokens | ~155K tokens |

What happens when it triggers:
1. Claude summarizes conversation history
2. Older messages get replaced with a condensed summary
3. Granular details from early in the session are lost
4. Session continues with reduced context

**Environment variables**:
- `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` (1-100): Control when compaction fires
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS` (default 32K): Max tokens per response (does NOT affect compaction buffer)

---

## Best Practices for Token Optimization

### 1. Keep CLAUDE.md / Memory Files Lean

CLAUDE.md is loaded on **every session** and persists in the system prompt for **every API call**.

```markdown
✅ INCLUDE                           ❌ EXCLUDE
─────────────────────────────        ──────────────────────────────
Bash commands Claude can't guess     Anything Claude can figure out
Code style rules that differ         Standard language conventions
Testing instructions                 Detailed API docs (link instead)
Repo etiquette (branch naming)       Long explanations or tutorials
Architectural decisions              File-by-file codebase descriptions
Common gotchas                       Self-evident practices
```

**Rule of thumb**: For each line in CLAUDE.md, ask: *"Would removing this cause Claude to make mistakes?"* If not, cut it.

Our codingagent enforces a **10,000 character limit** per memory entry (`MAX_ENTRY_CHARS` in `skills.ts`).

### 2. Structure Skills for Progressive Loading

Keep `SKILL.md` under **500 lines** (~5,000 tokens). Move detailed reference material to separate files:

```markdown
# Main SKILL.md (~2K tokens)
Core instructions that apply to most requests.

For complex forms, refer to [FORMS_REFERENCE.md](references/FORMS_REFERENCE.md)
For API reference, see [API_REFERENCE.md](references/API_REFERENCE.md)
```

### 3. Use Scripts for Heavy Lifting

**Don't** put 100 lines of data transformation logic in SKILL.md.  
**Do** create a script and reference it:

```markdown
For data transformation, run:
$ python transform.py --input data.json

The script handles all edge cases and validation.
```

Script code = **0 tokens** in context. Only output enters the context.

### 4. Keep Tool Descriptions Concise

Every token in tool definitions is loaded on **every request**:

```json
// ❌ Verbose (~300 tokens)
{
  "description": "This tool allows you to create a new task in the project management system. You can specify the task title, description, due date, priority level, assignee, project, tags, and custom fields. The task will be created and a confirmation with the task ID will be returned."
}

// ✅ Concise (~80 tokens)
{
  "description": "Create a task. Returns task ID on success."
}
```

### 5. Use `/clear` Between Unrelated Tasks

Long sessions with irrelevant context degrade performance. Clear between tasks:

```
Task 1: Fix auth bug → /clear → Task 2: Add API endpoint
```

### 6. Use Sub-agents for Investigation

Exploring a codebase reads many files, all consuming context. Sub-agents run in separate context windows:

```
"Use a subagent to investigate how authentication works"
→ Sub-agent reads 20 files internally, reports back a 500-token summary
→ Main context gains 500 tokens instead of 50,000
```

### 7. Batch MCP Tool Calls

```javascript
// ❌ 3 calls × ~200 tokens = 600 tokens
await mcp.call("get_user", { id: 1 });
await mcp.call("get_user", { id: 2 });
await mcp.call("get_user", { id: 3 });

// ✅ 1 call × ~250 tokens = 250 tokens
await mcp.call("get_users", { ids: [1, 2, 3] });
```

### 8. Limit Number of Active Tools

Each tool definition costs ~100-300 tokens, loaded on every request. OpenAI recommends **fewer than 20 functions** for best accuracy. More tools = more tokens AND worse selection accuracy.

### 9. Use Prompt Caching

Anthropic and OpenAI both offer prompt caching. When the system prompt + tool definitions haven't changed, they're read from cache:

```
First request:  Write 5,000 tokens to cache
Second request: Read 5,000 tokens from cache (cheaper, faster)
```

Add `cache_control` breakpoints on your system prompt so it stays cached even when compaction creates new content.

### 10. Manual Compaction at Strategic Points

Instead of relying on auto-compaction (which summarizes lossy-ly), compact at strategic moments:

```
After completing a major feature → /compact
Before starting a new component → /compact
When debugging context feels stale → /compact "Focus on the API changes"
```

---

## Anti-Patterns to Avoid

### 1. The Kitchen Sink CLAUDE.md

A 5,000-token CLAUDE.md means 5,000 tokens consumed on **every API call** regardless of whether the instructions are relevant.

> **Fix**: Keep CLAUDE.md short. Move domain-specific knowledge into skills (loaded on-demand). Move rarely-used instructions into reference files.

### 2. Loading All Skills Eagerly

Loading all skill instructions upfront defeats progressive disclosure:

```
❌ System prompt: "Here are all 10 skills with full instructions..." (30,000 tokens)
✅ System prompt: "Available skills: /pdf, /csv, /test..." (1,000 tokens)
```

### 3. Ignoring Tool Result Size

A single `cat large-file.ts` can dump 50,000 tokens into the conversation:

```
❌ Read entire 10,000-line file
✅ Read specific line range: Read(file, offset=100, limit=50)
✅ Use Grep to find relevant sections first
```

### 4. The Infinite Investigation

Asking Claude to "investigate" without scoping it causes it to read hundreds of files:

```
❌ "investigate the auth system"
✅ "look at src/auth/token-refresh.ts and explain the refresh flow"
```

### 5. Correcting Over and Over

Each failed attempt pollutes the context with incorrect approaches:

```
❌ "Fix it" → "Still wrong" → "Try again" → "That's not right either"
    (4 failed attempts = 4× the token waste)
✅ After 2 failed corrections: /clear + write a better initial prompt
```

### 6. Verbose Tool Definitions

Every tool definition token is multiplied by every API call in the session:

```
10 tools × 200 extra tokens × 50 API calls = 100,000 wasted tokens
```

### 7. Never Compacting

Without compaction, context grows linearly until the API rejects it:

```
Turn 1:  5K tokens
Turn 10: 50K tokens
Turn 30: 150K tokens
Turn 35: 💥 "context too long" error
```

---

## Skills vs MCP: When to Use Which

| Use Case | Recommendation | Why |
|----------|---------------|-----|
| Complex business logic | **Skill** | Natural language instructions with nuance |
| Multi-step workflows | **Skill** | Step-by-step procedures with decision points |
| Heavy computation | **Skill + Script** | Code never enters context |
| Simple API calls | **MCP** | Lower overhead, deterministic |
| Real-time external data | **MCP** | Direct external access |
| Structured CRUD operations | **MCP** | Consistent execution |
| Rapid prototyping | **Skill** | Just edit a Markdown file |
| Business rules + API calls | **Skill + MCP hybrid** | Skill provides "when/how", MCP provides "execute" |

### Hybrid Pattern: Skill + MCP

The most powerful pattern — skills provide the business logic, MCP provides the execution:

```markdown
---
name: sales-pipeline
description: Manage sales opportunities with CRM integration
---

# Sales Pipeline Manager

## Business Rules
- "Qualified" → "Proposal" requires: Budget confirmed + Decision maker identified
- "Negotiation" → "Closed Won" requires: Contract signed

## Workflow
1. Search for deal: `salesforce_search({ object: "Opportunity", name: "Acme" })`
2. Verify stage requirements (see Business Rules above)
3. If requirements met: `salesforce_update({ id: "...", stage: "Negotiation" })`
4. Log activity: `salesforce_log_activity({ type: "Stage Change" })`
```

Token flow:
```
Session Start: ~500 tokens (skill metadata + MCP tool defs)
First query:   +3,000 tokens (skill loaded) + ~550 tokens (3 MCP calls)
Subsequent:    ~200 tokens per MCP call (skill already loaded)
```

---

## Our Codingagent's Implementation

### Architecture

```
skills.ts                          → Skill discovery, memory loading, $ARGUMENTS substitution
  ├── loadProjectMemory()          → Reads CLAUDE.md, AGENTS.md, copilot-instructions.md, GEMINI.md
  ├── loadSkills()                 → Reads SKILL.md files from configured directories
  ├── getSkillDescriptions()       → Builds system prompt section with skill metadata
  ├── getInvocableSkills()         → Returns user-invocable skills for slash-command registration
  └── substituteArguments()        → Replaces $ARGUMENTS, $ARGUMENTS[N], $N in templates

compaction.ts                      → Token management
  ├── estimateTokens()             → Rough token count (~4 chars/token + overhead)
  ├── microCompact()               → Post-turn cleanup of large tool results (>10KB)
  ├── autoCompact()                → Full conversation summarization when threshold exceeded
  ├── repairOrphanedToolUse()      → Fix tool_use/tool_result pairing after compaction
  └── sanitizeMessageSlice()       → Ensure valid role alternation in compacted messages

loop.ts                            → Agentic loop (sends API calls with all context)
  └── Assembles: system prompt + memory + skill descriptions + tools + messages
```

### Token Budget Configuration

| Config Key | Default | Purpose |
|------------|---------|---------|
| `compactionThreshold` | ~120K tokens | When to trigger auto-compaction |
| `maxOutputTokens` | 16,384 | Max tokens per API response |
| `smallModel` | (configurable) | Model used for summarization |
| `skillDirs` | `["~/.claude/skills", ".claude/skills"]` | Where to find skills |

### Key Design Decisions

1. **Skills listed in system prompt**: Our agent lists skill descriptions in the system prompt (not via tool_use). This means descriptions are sent every request, but invocation doesn't require a tool call round-trip.

2. **Micro-compaction after every turn**: Large tool results are automatically truncated, keeping only the 3 most recent. This prevents a single large file read from permanently consuming context.

3. **Compaction uses the small model**: Summarization is done by a faster/cheaper model, not the main model. This reduces cost and latency.

4. **Summary preserves exact identifiers**: The compaction prompt explicitly instructs the model to preserve exact file paths, function names, and variable names — not paraphrase them.

5. **Clean split boundaries**: When splitting messages for compaction, the code avoids breaking tool_use/tool_result pairs, which would cause API errors.

6. **Truncation fallback**: If the summarization API call fails, the system falls back to keeping the last ~20 messages with progressive trimming, rather than crashing.

---

## Sources

1. **Agent Skills Specification** — https://agentskills.io/specification  
   *The official open standard defining the SKILL.md format.*

2. **VS Code Agent Skills Documentation** — https://code.visualstudio.com/docs/copilot/customization/agent-skills  
   *GitHub Copilot's implementation of agent skills with progressive disclosure.*

3. **Inside Claude Code Skills** (Mikhail Shilkov) — https://mikhail.io/2025/10/claude-code-skills/  
   *Detailed analysis of how Claude Code discovers, surfaces, and invokes skills internally.*

4. **Claude Skills vs MCP: Token-Efficient Agent Architecture** — https://dev.to/jimquote/claude-skills-vs-mcp-complete-guide-to-token-efficient-ai-agent-architecture-4mkf  
   *Comprehensive comparison of skills and MCP token patterns with progressive disclosure analysis.*

5. **Anthropic Compaction Documentation** — https://platform.claude.com/docs/en/build-with-claude/compaction  
   *Server-side context compaction API specification (beta).*

6. **Claude Code Context Buffer** — https://claudefa.st/blog/guide/mechanics/context-buffer-management  
   *Analysis of Claude Code's 33K compaction buffer and auto-compaction mechanics.*

7. **Best Practices for Claude Code** — https://code.claude.com/docs/en/best-practices  
   *Official patterns for effective Claude Code usage, context management, and session optimization.*

8. **Context Engineering for AI Agents** — https://www.flowhunt.io/blog/context-engineering-ai-agents-token-optimization/  
   *Deep dive into the four core context engineering techniques: offloading, reduction, retrieval, isolation.*

9. **Anthropic Claude API Tool Use System Prompt (January 2025 leak)** — https://agentic-design.ai/prompt-hub/anthropic/claude-api-tool-use-20250119  
   *Leaked internal format for how Claude processes tool definitions.*

10. **Our codingagent source** — `src/config/skills.ts`, `src/core/compaction.ts`  
    *Internal implementation of skill loading, memory hierarchy, and token management.*

---

*This report was compiled from official documentation, agent architecture analysis, community research, and our codingagent's source code.*
