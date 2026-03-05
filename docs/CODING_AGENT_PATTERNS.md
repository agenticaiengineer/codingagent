# 🔬 Open-Source Coding Agents: Core Patterns & Architecture

## Agents Analyzed

| Agent | Stars | Language | Primary Pattern |
|-------|-------|----------|-----------------|
| **SWE-Agent** (Princeton) | ~13K+ | Python | ReAct loop + shell-based ACI |
| **OpenHands** (All-Hands-AI) | ~38K+ | Python/TS | Event-sourced agent loop |
| **Aider** | ~25K+ | Python | Chat loop + edit formats + repo-map |
| **AutoCodeRover** (NUS) | ~2.5K+ | Python | Two-phase: AST search → patch gen |
| **GPT-Engineer** | ~52K+ | Python | Linear prompt pipeline |
| **Goose** (Block) | ~3K+ | Rust | MCP-native ReAct loop |
| **Sidecar/Aide** (CodeStory) | ~4K+ | Rust | LSP-aware symbol-anchored editing |

---

## The Universal Pattern: OBSERVE → THINK → ACT → FEEDBACK

Despite their differences, **every coding agent** follows this fundamental cycle:

```
┌──────────────────────────────────────────────────────────┐
│                                                          │
│   ┌──────────┐    ┌──────────┐    ┌──────────┐          │
│   │ OBSERVE  │───▶│  THINK   │───▶│   ACT    │──┐      │
│   │ (context)│    │  (LLM)   │    │  (tool)  │  │      │
│   └──────────┘    └──────────┘    └──────────┘  │      │
│        ▲                                         │      │
│        │          ┌──────────┐                   │      │
│        └──────────│ FEEDBACK │◀──────────────────┘      │
│                   │ (result) │                          │
│                   └──────────┘                          │
│                                                          │
│   Repeat until: task complete | max steps | stuck        │
└──────────────────────────────────────────────────────────┘
```

The agents differ in **HOW** they implement each step:

---

## Pattern 1: ReAct Agent Loop (SWE-Agent, OpenHands, Goose)

The most common pattern. The LLM interleaves reasoning and tool calls in a single loop.

```python
# === THE CANONICAL REACT AGENT LOOP ===
# Used by: SWE-Agent, OpenHands, Goose, Devon

def agent_loop(task: str, tools: list[Tool], llm: LLM, sandbox: Runtime):
    # 1. SETUP: Build system prompt with tool descriptions
    system_prompt = build_system_prompt(tools)
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user",   "content": task}
    ]
    
    # 2. LOOP
    for step in range(MAX_STEPS):
        # a. THINK: Query LLM
        response = llm.chat(messages)
        
        # b. PARSE: Extract thought + action from response
        thought, action = parse_response(response)
        
        # c. CHECK: Is the agent done?
        if action.type == "finish":
            return action.result
        
        # d. ACT: Execute action in sandbox
        observation = sandbox.execute(action)
        
        # e. TRUNCATE: Keep observation within token budget
        observation = truncate_if_needed(observation)
        
        # f. FEEDBACK: Append to conversation history
        messages.append({"role": "assistant", "content": response})
        messages.append({"role": "user",     "content": observation})
        
        # g. SAFETY: Check for stuck loops
        if is_stuck(messages):
            break
    
    return "Max steps reached"
```

### Variations:

| Agent | Tool Interface | Sandbox | Parse Format |
|-------|---------------|---------|-------------|
| **SWE-Agent** | Bash functions in Docker | Docker container | `DISCUSSION...COMMAND\n```cmd``` ` |
| **OpenHands** | Typed Action/Observation events | Docker + ActionServer | OpenAI function calling |
| **Goose** | MCP servers (dynamic) | Local machine | Native tool calling |

---

## Pattern 2: Context-Engineering Chat Loop (Aider)

Aider doesn't use traditional tool-calling. Instead, it's a **context engineering** system where the quality comes from *what the LLM sees*.

```python
# === THE AIDER PATTERN ===
# Chat loop with intelligent context construction + edit format parsing

def aider_loop(user_message: str, repo: GitRepo, model: LLM):
    while True:
        # 1. BUILD CONTEXT (the secret sauce)
        messages = []
        messages += system_prompt_for_edit_format()     # edit format rules
        messages += build_repo_map(repo, added_files)   # tree-sitter + PageRank
        messages += get_file_contents(added_files)      # full content of relevant files
        messages += get_git_diff(repo)                  # uncommitted changes
        messages += chat_history                        # prior conversation
        messages += [{"role": "user", "content": user_message}]
        
        # 2. LLM CALL
        response = model.chat(messages)
        
        # 3. PARSE EDITS (polymorphic — depends on edit format)
        edits = parse_edit_format(response)  # search/replace | whole-file | diff
        
        # 4. APPLY EDITS with fuzzy matching
        for edit in edits:
            if exact_match(edit.search, file_content):
                apply(edit)
            elif fuzzy_match(edit.search, file_content, threshold=0.6):
                apply(edit)  # tolerate LLM imprecision
            else:
                report_error(edit)
        
        # 5. GIT AUTO-COMMIT
        commit_message = model.generate_commit_message(diff)
        repo.commit(commit_message)
        
        # 6. NEXT USER INPUT
        user_message = input("> ")
```

### The Repo Map — Aider's Key Innovation:

```
All project files
    ↓  tree-sitter parse
Symbol graph (definitions + references)
    ↓  PageRank (seeded from active files)
Ranked symbols
    ↓  render top-K within token budget
Condensed map:

  src/server.py:
  │ class Server:
  │     def __init__(self, host, port)
  │     def start(self)
  │     def handle_request(self, req)
  │
  src/database.py:
  │ class Database:
  │     def connect(self)
  │     def query(self, sql)
```

### Edit Formats Comparison:

| Format | Token Cost | Reliability | Best For |
|--------|-----------|-------------|----------|
| **Search/Replace** | Low | High (fuzzy match) | Default, most files |
| **Whole File** | High | Very High | Small files, new files |
| **Unified Diff** | Very Low | Medium | Large files |
| **Architect+Editor** | Medium | High | Complex changes (split reasoning/editing) |

---

## Pattern 3: Two-Phase Pipeline (AutoCodeRover)

Separates **understanding** from **code generation** into distinct phases with specialized tools.

```python
# === THE AUTO-CODE-ROVER PATTERN ===
# Phase 1: Iterative AST search | Phase 2: Patch generation

def auto_code_rover(issue: str, repo: Repo):
    
    # ═══ PHASE 1: Context Retrieval (Iterative Search) ═══
    accumulated_context = []
    search_tools = [
        search_class,         # Find class definition by name
        search_method,        # Find method definition by name
        search_method_in_class,  # Find method within a class
        search_code,          # Grep for code pattern
        search_code_in_file,  # Grep within specific file
    ]
    
    for round in range(MAX_SEARCH_ROUNDS):
        # LLM picks which search API to call
        api_call = llm.decide_search(issue, accumulated_context, search_tools)
        
        # Execute AST-level search (returns structured code, not raw text)
        result = execute_search(api_call, repo.ast_index)
        accumulated_context.append(result)
        
        # LLM self-evaluates: do I have enough context?
        if llm.has_sufficient_context(issue, accumulated_context):
            break
    
    # ═══ PHASE 2: Patch Generation ═══
    patch = llm.generate_patch(issue, accumulated_context)
    
    # ═══ PHASE 3: Validation ═══
    apply_result = git_apply(patch)
    if not apply_result.success:
        patch = llm.retry_patch(issue, accumulated_context, apply_result.error)
    
    test_result = run_tests()
    return patch, test_result
```

### Key Insight: AST-Level Search APIs

Instead of generic "read file" / "grep" tools, AutoCodeRover gives the LLM **program-structure-aware** search:

```
Generic tools:              AST tools:
  read_file("utils.py")       search_class("UserManager")
  grep("def validate")        search_method_in_class("validate", "UserManager")
  ↓                           ↓
  Raw text (noisy)            Exact method body (precise)
```

---

## Pattern 4: Linear Prompt Pipeline (GPT-Engineer)

No agent loop at all — a deterministic sequence of specialized prompts.

```python
# === THE GPT-ENGINEER PATTERN ===
# Sequential prompt chain — each step builds on prior outputs

def gpt_engineer(spec: str):
    messages = []
    
    # Step 1: CLARIFY — LLM asks questions, user answers
    messages += clarify_loop(spec)        # Q&A until "nothing to clarify"
    
    # Step 2: GENERATE — LLM outputs entire codebase
    messages.append({"role": "system", "content": GENERATE_PROMPT})
    messages.append({"role": "user",   "content": spec})
    response = llm.chat(messages)
    
    files = parse_files_from_response(response)  # Extract filename→content pairs
    #   ```path/to/file.py
    #   <code>
    #   ```
    #   → {"path/to/file.py": "<code>"}
    
    write_all_files(files)
    
    # Step 3: ENTRYPOINT — Generate run.sh
    messages.append({"role": "system", "content": ENTRYPOINT_PROMPT})
    entrypoint = llm.chat(messages)
    write_file("run.sh", entrypoint)
    
    # Step 4: EXECUTE
    run("bash run.sh")
```

---

## Pattern 5: LSP-Integrated Agent (Sidecar/Aide)

Uses compiler-grade code understanding via Language Server Protocol.

```python
# === THE IDE-NATIVE PATTERN ===
# Deep LSP + tree-sitter integration for precise edits

def ide_agent(task: str, workspace: LSPWorkspace):
    tools = [
        CodeEditing,          # Range-anchored edit (not string search)
        LSPDiagnostics,       # Read compiler errors
        CodeSymbolFollow,     # Go to definition/references via LSP
        OpenFile,
        SearchFileContentWithRegex,
        TerminalCommand,
        TestRunner,
    ]
    
    for step in range(MAX_STEPS):
        response = llm.chat(messages, tools)
        action = parse_xml_tool_call(response)
        
        match action:
            case CodeEditing(file, range, new_code):
                # PRECISE: edit by line range + symbol span, not string match
                result = workspace.apply_range_edit(file, range, new_code)
                
            case LSPDiagnostics():
                # COMPILER-AWARE: read real compiler/linter errors
                result = workspace.get_diagnostics()
                
            case CodeSymbolFollow(symbol):
                # TYPE-AWARE: navigate to definitions/references
                result = workspace.lsp.goto_definition(symbol)
                result += workspace.lsp.find_references(symbol)
        
        # Stream results back to IDE in real-time (SSE)
        stream_to_editor(result)
```

---

## The 7 Core Building Blocks

Every coding agent is composed of these building blocks, combined differently:

```
┌─────────────────────────────────────────────────────────────┐
│                    CODING AGENT ANATOMY                      │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  1. LLM INTERFACE          Model abstraction + retry logic   │
│     └─ OpenAI, Anthropic, local models, function calling     │
│                                                              │
│  2. PROMPT CONSTRUCTION     Context window management        │
│     └─ System prompt, repo map, file contents, history       │
│                                                              │
│  3. RESPONSE PARSING        Extract structured actions       │
│     └─ Regex, XML, JSON, function calls, edit formats        │
│                                                              │
│  4. TOOL / ACTION SYSTEM    Define what the agent can do     │
│     └─ Shell commands, file ops, search, browser, LSP, MCP   │
│                                                              │
│  5. SANDBOX / RUNTIME       Safe execution environment       │
│     └─ Docker, local, cloud (E2B/Modal), IDE                 │
│                                                              │
│  6. CONTEXT MANAGEMENT      Help LLM understand the codebase │
│     └─ Repo map, AST indexing, vector search, LSP            │
│                                                              │
│  7. FEEDBACK & SAFETY       Keep the agent on track          │
│     └─ Lint-gating, stuck detection, token budgets, git      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Comparative Matrix

| Feature | SWE-Agent | OpenHands | Aider | AutoCodeRover | GPT-Eng | Goose | Sidecar |
|---------|-----------|-----------|-------|---------------|---------|-------|---------|
| **Loop Type** | ReAct | ReAct (event) | Chat | 2-Phase | Pipeline | ReAct | ReAct |
| **Tool Interface** | Bash cmds | Typed events | None (edit fmt) | AST APIs | None | MCP | LSP+typed |
| **Code Understanding** | grep/cat | grep/cat | Tree-sitter map | AST index | Full file | grep/cat | LSP+tree-sitter |
| **Edit Mechanism** | Lint-gated bash | str_replace | Search/Replace | Unified diff | Whole file | str_replace | Range-anchored |
| **Sandbox** | Docker | Docker | Local (Git) | Local | Local | Local | IDE |
| **Git Integration** | Patch export | Patch export | Auto-commit | git apply | File write | None | IDE native |
| **Stuck Detection** | Max steps | Pattern match | None | Phase gate | None | Pattern match | Max steps |
| **Multi-model** | Yes | Yes | Yes (architect) | Limited | No | Yes | Yes |
| **Streaming** | No | No | Yes (tokens) | No | No | Yes | Yes (SSE) |
| **Human-in-loop** | No | Optional | Yes (chat) | No | Yes (clarify) | Yes | Yes (IDE) |

---

## Key Insights & Takeaways

### 1. Context Engineering > Model Choice
Aider's repo-map (tree-sitter + PageRank) and AutoCodeRover's AST search APIs prove that
**what you show the LLM matters more than which LLM you use.** Both achieve strong results
by giving the model precisely the right context.

### 2. Edit Application Is the Hardest Part
Every agent struggles with reliably applying LLM-generated edits. Solutions:
- **Lint-gating** (SWE-Agent): Revert edits that break syntax
- **Fuzzy matching** (Aider): Tolerate whitespace/minor differences
- **Range-anchored edits** (Sidecar): Use LSP/AST to find exact locations
- **Typed actions** (OpenHands): Structured str_replace with old/new strings

### 3. Two Emerging Architectures

**Architecture A: "Shell Agent"** (SWE-Agent, OpenHands)
- Agent types shell commands in a Docker container
- Simple, flexible, language-agnostic
- Fragile — depends on LLM generating correct bash

**Architecture B: "IDE Agent"** (Sidecar, Aider)
- Agent uses structured APIs (LSP, tree-sitter, MCP)
- More reliable, compiler-aware
- More complex to build, tighter coupling

### 4. The MCP Trend
Goose's MCP-native architecture points to the future: **agents as thin orchestrators
over pluggable tool servers.** Instead of hardcoding tools, discover them dynamically
via a standard protocol.

### 5. Phase Separation Works
AutoCodeRover's insight: **don't let the agent write code until it understands the
codebase.** Separating exploration from generation reduces hallucination and improves
patch quality.

### 6. Git Is Your Safety Net
Aider's auto-commit pattern is the simplest safety mechanism: every change is a Git
commit, every mistake is `git reset --hard`. No Docker needed.

---

## If You're Building a Coding Agent, Start Here:

```
Week 1: Build a basic ReAct loop (Pattern 1)
         → LLM + shell commands + Docker sandbox

Week 2: Add context engineering (Pattern 2)
         → tree-sitter repo map + intelligent file selection

Week 3: Add edit reliability
         → Lint-gating + fuzzy matching + Git auto-commit

Week 4: Add phase separation (Pattern 3)
         → Explore first, then edit

Month 2: Add MCP support (Pattern 5)
         → Make tools pluggable via standard protocol

Month 3: Add LSP integration (Pattern 5)
         → Compiler-aware navigation and editing
```

---

*Generated: 2026-02-20*
*Based on analysis of: SWE-Agent, OpenHands, Aider, AutoCodeRover, GPT-Engineer, Goose, Sidecar/Aide*
