# How Coding Agents Work: From Raw LLMs to Autonomous Agents

## Comprehensive Research Notes

*Compiled from web research across academic papers, engineering blogs, and documentation.*

---

## Table of Contents

1. [How Raw LLMs Generate Code](#1-how-raw-llms-generate-code)
2. [Prompt Engineering for Code Generation](#2-prompt-engineering-for-code-generation)
3. [Chain-of-Thought Reasoning and Its Role in Coding](#3-chain-of-thought-reasoning-and-its-role-in-coding)
4. [Tool Use / Function Calling in LLMs](#4-tool-use--function-calling-in-llms)
5. [The ReAct Pattern and Agentic Loops](#5-the-react-pattern-and-agentic-loops)
6. [How Coding Agents Use Tools](#6-how-coding-agents-use-tools)
7. [The Edit-Test-Debug Feedback Loop](#7-the-edit-test-debug-feedback-loop)
8. [Architecture of Real Coding Agents](#8-architecture-of-real-coding-agents)
9. [Multi-Agent Architectures and Orchestration Patterns](#9-multi-agent-architectures-and-orchestration-patterns)
10. [Scaffolding, Memory, and Context Management](#10-scaffolding-memory-and-context-management)

---

## 1. How Raw LLMs Generate Code

### Next-Token Prediction as the Foundation

At their core, all autoregressive LLMs — including code-generating models — work by **next-token prediction**. Given a sequence of tokens, the model predicts a probability distribution over the vocabulary for the next token. This deceptively simple mechanism, when applied at scale with billions of parameters and massive training corpora, produces remarkably coherent code.

> "If you peel away all the complexity of modern large language models — billions of parameters, reinforcement learning from human feedback, retrieval-augmented generation — the essence of how they work comes down to a simple principle: predicting a probability distribution over the next token given the preceding tokens."
> — [WWW Insights](https://www.wwwinsights.com/ai/llm-next-token-prediction/)

The process works as follows:
1. **Tokenization**: Source code is broken into tokens (keywords, identifiers, operators, whitespace).
2. **Embedding**: Each token is mapped to a high-dimensional vector.
3. **Transformer Processing**: Self-attention layers process the full sequence, building contextual representations through intermediate layers.
4. **Prediction Head**: A final linear layer + softmax produces probabilities over the vocabulary.
5. **Sampling/Decoding**: The next token is selected (via greedy, temperature-based, or nucleus sampling).
6. **Autoregressive Generation**: The selected token is appended to the input, and the process repeats.

### Key Code LLMs and Their Training

#### Codex (OpenAI, 2021)
- **Architecture**: GPT-3 (decoder-only transformer), 12B parameters.
- **Training Data**: 159GB of Python files from 54 million GitHub repositories.
- **Key Results**: Solved 28.8% of HumanEval problems (vs. 0% for GPT-3), rising to 37.7% after fine-tuning on standalone Python functions.
- **Contribution**: Created the **HumanEval** benchmark (164 hand-written programming problems with unit tests) and powered GitHub Copilot.
- **Source**: [Chen et al., 2021 — arXiv:2107.03374](https://arxiv.org/abs/2107.03374)

#### Code Llama (Meta, 2023)
- **Architecture**: Built on Llama 2, available in 7B, 13B, and 34B parameter sizes.
- **Training Data**: 500B tokens of publicly available code, plus an additional 100B tokens for the Python-specialized variant.
- **Key Innovations**:
  - **Long Context Fine-Tuning (LCFT)**: Extended context length from 4,096 to 16,384 tokens.
  - **Infilling objective**: Beyond next-token prediction — trained to fill in missing code at cursor positions (critical for IDE completion).
  - **Self-Instruct**: Novel execution-feedback approach to create instruction-tuning data without expensive human annotation.
- **Variants**: Code Llama (general), Code Llama-Python, Code Llama-Instruct.
- **Results**: 53% on HumanEval, 55% on MBPP.
- **Source**: [Rozière et al., 2023](https://ai.meta.com/blog/code-llama-large-language-model-coding/) | [Towards Data Science deep dive](https://towardsdatascience.com/cracking-the-code-llms-354505c53295/)

#### Historical Evolution
| Model | Year | Architecture | Key Innovation |
|-------|------|-------------|----------------|
| Code2Vec | 2018 | RNN + Feed-Forward | AST path-based code embeddings |
| CodeBERT | 2020 | RoBERTa (encoder-only) | Bimodal NL+PL pre-training |
| Codex | 2021 | GPT-3 (decoder-only) | First successful NL→code generation |
| CodeT5 | 2021 | T5 (encoder-decoder) | Identifier-aware denoising |
| PLBart | 2021 | BART (enc-dec) | Denoising auto-encoder for code |
| Code Llama | 2023 | Llama 2 (decoder-only) | Long context + infilling + self-instruct |

### Why Next-Token Prediction Works for Code

Code is **highly structured** and has lower entropy than natural language in many contexts. Programming languages have strict syntax, patterns of indentation, and common idioms. LLMs exploit these statistical regularities. Furthermore, code frequently contains docstrings, comments, and variable names that bridge natural language and programming language — making the NL→code mapping learnable from the training distribution.

---

## 2. Prompt Engineering for Code Generation

### Zero-Shot Prompting
The simplest approach: provide a natural-language description of the desired code without any examples. The model relies entirely on its pre-training to generate code.

```
Write a Python function that takes a list of integers and returns the two numbers that sum to a target value.
```

### Few-Shot Prompting
Provide several input-output examples within the prompt so the model can learn the pattern:

```
# Example 1:
# Input: [2, 7, 11, 15], target = 9
# Output: [0, 1]

# Example 2:
# Input: [3, 2, 4], target = 6
# Output: [1, 2]

# Now write the function:
def two_sum(nums, target):
```

**Key findings** from research:
- Few-shot prompting significantly improves **format adherence** and output structure.
- The **quality and diversity** of examples matters more than quantity.
- Examples should cover **edge cases** relevant to the task.
- **Source**: [DataCamp Tutorial](https://www.datacamp.com/tutorial/few-shot-prompting) | [Brown et al., 2020](https://github.com/duriri/prompt-engineering)

### System Prompts for Code Generation
System prompts define the model's persona, constraints, and output requirements:

```
You are an expert Python developer. Follow PEP 8 conventions.
Always include type hints and docstrings. Write tests using pytest.
Return only the code without explanations.
```

### Structured Output
Techniques to constrain the model's output format:
- **JSON mode**: Force the model to output valid JSON (OpenAI's `response_format`).
- **Schema-based constraints**: Define the exact structure of expected output.
- **Delimiters**: Use markers like ````python` and ```` to delineate code blocks.
- **Prompt templates**: Parameterized prompts with placeholders for variables, task instructions, and format specifications.

> "Prompt templates are not just good practice — they're essential for scaling. Structure your prompts like code: Inputs (variables), Logic (task instruction), Format (output spec)."
> — [Medium: Prompt Engineering 102](https://medium.com/@WilllliamZhou/prompt-engineering-102-designing-structured-prompt-templates-1a22c4e39f05)

### Best Practices
1. **Be specific** about language, framework, and conventions.
2. **Provide context** (file structure, existing functions, imports).
3. **Constrain the output** with explicit format requirements.
4. **Use role prompts** ("You are a senior backend engineer...").
5. **Include negative examples** to show what NOT to do.
6. **Source**: [Real Python: Practical Prompt Engineering](https://realpython.com/practical-prompt-engineering/)

---

## 3. Chain-of-Thought Reasoning and Its Role in Coding

### What is Chain-of-Thought (CoT)?
Chain-of-Thought prompting asks the model to generate **intermediate reasoning steps** before producing the final answer. Instead of jumping directly from problem to solution, the model "thinks aloud."

> "The key innovation behind Chain-of-Thought prompting is its ability to 'unlock' reasoning capabilities in large language models through structured prompting."
> — [Medium: CoT in LLMs](https://medium.com/@devmallyakarar/chain-of-thought-cot-in-large-language-models-prompting-and-concise-cot-with-code-82821f9a832d)

### Standard CoT for Code
A standard CoT prompt for code generation:
```
Think step by step about how to solve this problem:
1. Understand what the function needs to do.
2. Identify the algorithm and data structures.
3. Write pseudocode.
4. Implement the solution in Python.
```

### Structured Chain-of-Thought (SCoT) for Code Generation
Li et al. (2023) proposed **SCoT prompting**, which leverages the structural nature of source code — specifically that all code can be decomposed into **sequence, branch, and loop structures**.

**Key insight**: Instead of free-form natural language reasoning steps, SCoT asks the LLM to structure its intermediate reasoning using program structures (if-then-else, for loops, sequential steps).

**Results**:
- SCoT outperformed standard CoT prompting by **up to 13.79% in Pass@1** across HumanEval, MBPP, and MBCPP benchmarks.
- Human evaluators preferred programs generated with SCoT prompting.
- SCoT was robust across different numbers of few-shot examples.
- **Source**: [Li et al., 2023 — arXiv:2305.06599](https://arxiv.org/abs/2305.06599) | [ACM](https://dl.acm.org/doi/10.1145/3690635)

### Long Chain-of-Thought for Coding
Recent research on **long CoT reasoning** (as used in models like o1 and DeepSeek-R1) shows that extended reasoning traces can dramatically improve performance on complex coding tasks. The model spends more tokens "thinking" before generating code, exploring alternative approaches, catching potential bugs, and verifying logic.

> "Large language models have demonstrated remarkable reasoning abilities in domains like mathematics and programming. A key technique for enabling reasoning abilities in LLMs is chain-of-thought."
> — [GitHub: Demystifying Long CoT](https://github.com/eddycmu/demystify-long-cot)

### CoT's Limitations in Code
Research from ICML 2025 (OpenReview) revisits CoT for code generation, finding that:
- CoT training (learning reasoning steps before the final answer) doesn't always help.
- For **simpler tasks**, CoT adds unnecessary overhead.
- For **complex multi-step tasks**, CoT provides significant benefits.
- The quality of reasoning traces during training matters more than quantity.
- **Source**: [OpenReview: Revisiting CoT in Code Generation](https://openreview.net/forum?id=wSZeQoJ1Vk)

---

## 4. Tool Use / Function Calling in LLMs

### Overview
Function calling (tool calling) allows LLMs to **interface with external systems** — APIs, databases, file systems, calculators — by generating structured requests that application code can execute. This transforms a text-in/text-out model into an agent capable of taking actions in the real world.

### How It Works (Technical Flow)

The tool calling flow has **five steps** (per OpenAI's documentation):

1. **Define tools**: Provide the model with JSON schema descriptions of available functions (name, description, parameters).
2. **Model decides**: Given a prompt and tool definitions, the model either generates a text response OR returns one or more **tool calls** with structured arguments.
3. **Execute**: Application code parses the tool call, executes the actual function, and captures the result.
4. **Return results**: The tool output is sent back to the model as a new message with role `"tool"`.
5. **Final response**: The model incorporates the tool result and generates the final answer (or makes more tool calls).

**Source**: [OpenAI Function Calling Guide](https://developers.openai.com/api/docs/guides/function-calling)

### OpenAI Implementation
```python
tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get current temperature for a location.",
        "parameters": {
            "type": "object",
            "properties": {
                "location": {"type": "string", "description": "City and country"},
                "units": {"type": "string", "enum": ["celsius", "fahrenheit"]}
            },
            "required": ["location", "units"],
            "additionalProperties": False
        },
        "strict": True  # Enforce schema compliance
    }
}]

response = client.chat.completions.create(
    model="gpt-4.1",
    messages=[{"role": "user", "content": "Weather in Paris?"}],
    tools=tools
)
```

**Key features**:
- **`tool_choice`**: Control when tools are used (`"auto"`, `"required"`, or force a specific function).
- **Parallel tool calls**: Model can request multiple functions in a single turn.
- **Strict mode**: Uses structured outputs to guarantee schema-conformant arguments.
- **Streaming**: Tool call arguments can be streamed as they are generated.

### Anthropic Implementation
Anthropic uses a similar pattern called "tool use" with its `tool_use` and `tool_result` content block types. Key differences:
- Uses content blocks within messages rather than separate message types.
- Tool results are returned as `tool_result` content blocks.
- Supports parallel tool calls.

### Key Technical Details
- **Under the hood**, function definitions are injected into the system message in a special syntax the model was trained on. They **count against the context limit** and are billed as input tokens.
- Models are **fine-tuned** specifically to understand when to call functions and how to generate valid JSON arguments.
- **Function descriptions** are critical — they serve as the model's only understanding of what a tool does. Poorly described tools lead to poor tool usage.
- **Source**: [Analytics Vidhya: Tool Calling](https://www.analyticsvidhya.com/blog/2024/08/tool-calling-in-llms/) | [GetAthenic Guide](https://getathenic.com/blog/function-calling-llms-implementation-guide)

### Best Practices (from OpenAI)
1. Write **clear, detailed descriptions** for every function and parameter.
2. Use **enums** and object structure to prevent invalid states.
3. **Offload burden** from the model — don't make it fill arguments you already know.
4. **Combine functions** that are always called in sequence.
5. Keep the number of functions small (aim for **< 20** at any one time).
6. Apply the **"intern test"**: could a human correctly use the function given only the description?

---

## 5. The ReAct Pattern and Agentic Loops

### What is ReAct?
**ReAct** (Reasoning + Acting) is a framework introduced by Yao et al. (2022) where LLMs **interleave reasoning traces with actions** in a loop. The model thinks about what to do (Thought), takes an action (Act), and observes the result (Observation), then repeats.

> "ReAct prompts LLMs to generate verbal reasoning traces and actions for a task. This allows the system to perform dynamic reasoning to create, maintain, and adjust plans for acting while also enabling interaction to external environments."
> — [Prompt Engineering Guide](https://www.promptingguide.ai/techniques/react)

### The Thought-Action-Observation Loop

```
Question: What is the elevation range for the area that the eastern
          sector of the Colorado orogeny extends into?

Thought 1: I need to search Colorado orogeny, find the area that the
           eastern sector extends into, then find its elevation range.
Action 1:  Search[Colorado orogeny]
Observation 1: The Colorado orogeny was an episode of mountain building...

Thought 2: It doesn't mention the eastern sector. I need to look that up.
Action 2:  Lookup[eastern sector]
Observation 2: The eastern sector extends into the High Plains...

Thought 3: I need to search High Plains and find its elevation range.
Action 3:  Search[High Plains (United States)]
Observation 3: The High Plains rise from around 1,800 to 7,000 ft...

Thought 4: The answer is 1,800 to 7,000 ft.
Action 4:  Finish[1,800 to 7,000 ft]
```

**Source**: [Yao et al., 2022 — arXiv:2210.03629](https://arxiv.org/abs/2210.03629)

### Why ReAct Works
1. **Reasoning traces** allow the model to plan, track progress, and handle exceptions.
2. **Actions** allow it to interface with external tools and knowledge bases.
3. **The combination** reduces hallucination (CoT alone hallucinates facts; actions alone lack planning).
4. **Interpretability**: Humans can trace the agent's reasoning and understand its decisions.

### ReAct vs. Other Patterns

| Pattern | Description | Strength |
|---------|-------------|----------|
| **CoT only** | Reasoning without actions | Good for closed-book reasoning; prone to hallucination |
| **Act only** | Actions without reasoning | Can execute but fails to plan/decompose |
| **ReAct** | Interleaved reasoning + actions | Best for tasks requiring external information |
| **Plan-and-Execute** | Full plan first, then execute | Better for well-defined multi-step tasks |

### The Agentic Loop (Implementation)

In practice, a ReAct agent is implemented as a **while-loop**:

```python
while not done:
    # 1. Send history + tools to LLM
    response = llm.generate(messages, tools)

    # 2. If the response contains tool calls, execute them
    if response.has_tool_calls():
        for tool_call in response.tool_calls:
            result = execute_tool(tool_call)
            messages.append(tool_result(result))
    else:
        # 3. If plain text, the agent is done
        done = True
        final_answer = response.text
```

This loop is the fundamental building block of **all coding agents**.

**Source**: [Agent Patterns Documentation](https://agent-patterns.readthedocs.io/en/stable/patterns/react.html) | [APXML: ReAct Pattern](https://apxml.com/courses/getting-started-with-llm-toolkit/chapter-8-developing-autonomous-agents/react-pattern-for-agents)

---

## 6. How Coding Agents Use Tools

### The Tool Ecosystem

Coding agents interact with the development environment through a set of specialized tools. Each tool is a function the agent can call, with defined inputs and outputs.

#### File Operations
- **Read/View**: Read file contents (often limited to ~100-2000 lines at a time to avoid overwhelming the model's context).
- **Edit/Patch**: Apply surgical edits using diff-like patches or string replacements.
- **Write/Create**: Write entire files or create new ones.
- **List/Glob**: Browse directory structures and find files matching patterns.
- **Search/Grep**: Full regex-powered search across repositories (like `ripgrep`).

#### Terminal/Shell Execution
- **Bash/Shell**: Execute arbitrary shell commands in a persistent session.
- **Run tests**: Execute test suites and capture results.
- **Build**: Compile code and capture build errors.
- **Package management**: Install dependencies (`pip install`, `npm install`, etc.).

#### Code Intelligence
- **Linter integration**: Check code for syntax errors, style violations.
- **Language server**: Get type information, go-to-definition, find references.
- **AST analysis**: Structural code understanding.

#### Web/Browser
- **Web search**: Search the internet for documentation, APIs, Stack Overflow answers.
- **Fetch pages**: Read web page content.
- **API calls**: Interact with external services.

### The Agent-Computer Interface (ACI)

SWE-Agent introduced the concept of the **Agent-Computer Interface (ACI)**: an interface designed for LLMs (not humans) to interact with computers effectively.

Key ACI design principles:
1. **Custom commands** with clear documentation (not raw shell).
2. **Windowed file viewing**: Show ~100 lines at a time (agents, like humans, get overwhelmed by too much code).
3. **A linter** to catch and auto-correct formatting errors (51.7% of SWE-agent's edits had at least one error caught by the linter).
4. **Explicit feedback**: "Command ran successfully with no output" instead of empty strings.
5. **Context indicators**: Current file, line number, working directory shown with each command.

> "The agent seems to get overwhelmed and produce worse results when there's more [than 100 lines]. Interestingly, humans also work like this."
> — [Pragmatic Engineer: How AI SE Agents Work](https://newsletter.pragmaticengineer.com/p/ai-coding-agents)

**Source**: [SWE-Agent Architecture](https://swe-agent.com/latest/background/architecture/) | [SWE-Agent Paper — arXiv:2405.15793](https://arxiv.org/abs/2405.15793)

---

## 7. The Edit-Test-Debug Feedback Loop

### The Core Loop

The defining characteristic of a **coding agent** (vs. a raw LLM doing code generation) is the ability to **iteratively refine** its output. The edit-test-debug loop works as follows:

```
1. PLAN    → Analyze the task and decide what to change
2. EDIT    → Modify source files
3. TEST    → Run tests, linter, or the program
4. OBSERVE → Read error messages, test results, output
5. DEBUG   → If errors exist, diagnose the cause
6. REPEAT  → Go back to step 2 with corrected approach
```

### Evidence from SWE-Agent's Behavior

Research on SWE-Agent's behavior shows this loop clearly:
- **Turns 1-2**: The agent searches files and directories, reads code to understand the codebase.
- **Turns 2-5**: The agent begins editing files and running Python to check if changes work.
- **Turns 5-10**: Dominant actions are editing + running, with refinement iterations.
- **Turn ~10**: Most successful runs submit a solution. Agents that haven't solved the problem by turn 10 usually continue iterating until giving up.

**Key finding**: The fewer turns an agent takes, the more likely it succeeds. Getting stuck in long iteration loops is a common failure mode.

**Source**: [Pragmatic Engineer](https://newsletter.pragmaticengineer.com/p/ai-coding-agents)

### Self-Correction Capabilities

Modern coding agents employ several self-correction strategies:
- **Linter feedback**: Immediate syntactic error correction (SWE-Agent caught errors in 51.7% of edits).
- **Test-driven development**: Run the test suite after each edit; use failures to guide the next edit.
- **Error message parsing**: Read compiler/runtime errors and use them diagnostically.
- **Bug reproduction**: First reproduce the bug, then verify the fix resolves it.
- **Regression checking**: Ensure fixes don't break existing functionality.

### Guiding the Loop with Instructions

SWE-Agent's system prompt includes explicit tips for the edit-test-debug loop:
- *"Always start by trying to replicate the bug..."*
- *"If you run a command and it doesn't work, try running a different command."*
- *"When you think you've fixed the bug, re-run the bug reproduction script."*
- *"When editing files, it is easy to accidentally specify a wrong line number."*

These mirror the instructions a senior developer might give a junior — check your work, don't repeat mistakes, verify your fix.

---

## 8. Architecture of Real Coding Agents

### Claude Code (Anthropic)

**Architecture**: Single-threaded master loop (codenamed "nO") — deliberately simple.

**Core Design**:
- A `while` loop that continues as long as the model's responses include tool calls.
- When Claude produces plain text without tool invocations, the loop terminates.
- **Single main thread**, one flat message history — no threaded conversations or competing agent personas.
- Real-time steering via "h2A" asynchronous dual-buffer queue for mid-task course correction.

**Tools**:
| Tool | Purpose |
|------|---------|
| View | Read files (~2000 lines default) |
| LS | Directory listing |
| Glob | Wildcard file search |
| GrepTool | Regex search (ripgrep-like) |
| Edit | Surgical patches/diffs |
| Write/Replace | Whole-file operations |
| Bash | Persistent shell sessions with risk classification |
| TodoWrite | Structured task list management |
| Task Agent (I2A) | Sub-agent dispatch for parallelism |

**Context Management**: "Compressor wU2" triggers at ~92% context utilization, summarizing conversations and moving information to long-term Markdown-based memory.

**Planning**: TodoWrite creates JSON task lists (IDs, content, status, priority). Current TODO state is injected as system messages after tool uses to prevent losing track.

**Safety**: Permission system for write ops, risky commands, external tools. Command sanitization with risk-level classification. Diffs-first workflow for visibility.

**Key Philosophy**: *"A simple, single-threaded master loop combined with disciplined tools and planning delivers controllable autonomy."*

**Source**: [ZenML Analysis](https://www.zenml.io/llmops-database/claude-code-agent-architecture-single-threaded-master-loop-for-autonomous-coding) | [PromptLayer Behind the Scenes](https://blog.promptlayer.com/claude-code-behind-the-scenes-of-the-master-agent-loop/)

---

### GitHub Copilot Agent Mode

**Architecture**: Orchestrator of tools through a system prompt that instructs Copilot to keep iterating until reaching a final state.

**How it works**:
1. User provides a natural-language prompt.
2. Prompt is augmented by a backend system prompt (including workspace structure, machine context, tool descriptions).
3. Copilot parses the question, asks an LLM how to resolve the task, and begins working.
4. After running commands and applying edits, agent mode **detects syntax errors, terminal output, test results, and build errors**.
5. Based on results, it course-corrects with additional edits, terminal commands, or tool calls.

**Built-in Tools**: `read_file`, `edit_file`, `run_in_terminal`, workspace search, error detection from the editor.

**Extensibility**: Supports **MCP (Model Context Protocol)** servers and VS Code extensions for additional tools.

**Two modes**:
- **Agent Mode** (in-IDE): Synchronous, real-time pair programmer.
- **Copilot Coding Agent** (GitHub Actions): Asynchronous teammate that creates PRs from issues.

**Source**: [GitHub Blog: Agent Mode 101](https://github.blog/ai-and-ml/github-copilot/agent-mode-101-all-about-github-copilots-powerful-mode/) | [VS Code Blog](https://code.visualstudio.com/blogs/2025/02/24/introducing-copilot-agent-mode)

---

### SWE-Agent (Princeton University)

**Architecture**: LLM + Agent-Computer Interface (ACI) + Docker sandbox.

**Key components**:
1. **SWEEnv**: Manages the Docker execution environment (local or remote via AWS/Modal).
2. **Agent**: Configured via YAML; core method is `forward()` which prompts the model and executes actions.
3. **HistoryProcessor**: Compresses conversation history to fit context windows.
4. **ACI (Custom Tools)**: Specialized commands (`edit`, `open`, `goto`, `search_file`, `find_file`, `scroll_up/down`, `submit`).
5. **Shell Session**: Persistent bash session inside the container.
6. **Parser**: Extracts actions from model output.

**Workflow**: Takes a GitHub issue → agent browses files, edits, runs tests → submits a PR.

**Performance**: Solved 12.5% of SWE-bench tickets autonomously (4x better than best LLM-only approach at the time).

**Team**: Built in 6 months by 7 people (only 2 full-time) at Princeton.

**Source**: [SWE-Agent Docs](https://swe-agent.com/latest/background/architecture/) | [Paper — arXiv:2405.15793](https://arxiv.org/abs/2405.15793)

---

### Devin (Cognition Labs)

**Architecture**: Autonomous AI software engineer with its own IDE, shell, and browser in a managed sandbox.

**Key characteristics**:
- Runs tasks **end-to-end** inside a managed cloud environment.
- Has its own **code editor**, **web browser**, and **terminal**.
- **Interactive Planning**: Automatically creates and updates plans as it works.
- **Repository Indexing**: Automatically indexes repositories every few hours, creating architecture diagrams and documentation.
- Handles multi-file changes, debugging, testing, and deployment.

**Devin 2.0**:
- Agent-native IDE with closer human-AI collaboration.
- Operates as an asynchronous teammate (assign issues/tasks to Devin).

**Source**: [Devin.ai](https://devin.ai/) | [Cognition Blog: Devin 2.0](https://cognition.ai/blog/devin-2) | [Real Python: Devin](https://realpython.com/ref/ai-coding-tools/devin/)

---

### OpenHands (formerly OpenDevin)

**Architecture**: Open-source platform with modular agent types and Docker sandboxing.

**Agent Types**:
- **CodeAct Agent** (default): Uses code-based actions.
- **Browsing Agent**: Specialized for web research.
- **Monologue Agent**: Simpler agent for straightforward tasks.

**Sandbox**: All code execution in **isolated Docker containers** (secure by default, reproducible, customizable).

**Capabilities**: Modify code, run commands, browse the web, call APIs, write tests, debug issues.

**Self-correction**: Reads error messages → adjusts approach → retries with fixes → learns from failures within a session.

**Multi-LLM support**: OpenAI GPT-4, Anthropic Claude, open-source models (Ollama), Azure OpenAI.

**Source**: [OpenHands Paper — arXiv:2407.16741](https://arxiv.org/abs/2407.16741) | [Turion.ai Deep Dive](https://turion.ai/blog/coding-agent-deep-dive-openhands/)

---

### Aider

**Architecture**: Terminal-based AI pair programming tool with an **Architect/Editor** two-model approach.

**Key Innovation**: Separates code **reasoning** from code **editing**:
1. **Architect model** (e.g., o1-preview, Claude 3.5 Sonnet): Focuses on problem-solving, solution design, and high-level reasoning.
2. **Editor model** (e.g., GPT-4, DeepSeek): Translates the architect's plan into specific code edits.

**Design principles**:
- Works directly in your **git repository**.
- Edits files and **commits changes** with meaningful messages.
- Supports dozens of LLM providers.
- Interactive conversational interface in the terminal.
- Git-aware: understands repo structure and history.
- Over 80% of Aider's own codebase was written by Aider itself.

**Source**: [Aider Chat: Architect/Editor](https://aider.chat/2024/09/26/architect.html) | [GitHub: Aider](https://github.com/Aider-AI/aider)

---

### Cursor

**Architecture**: AI-native code editor (VS Code fork) with deep IDE integration.

**Modes**:
- **Tab completion**: Inline code suggestions.
- **Chat**: Conversational coding assistance with codebase context.
- **Agent mode**: Autonomous multi-step task execution with file editing, terminal access, and web search.

**Key feature**: Deep integration with the IDE — the agent can read open files, see diagnostics, run commands in the embedded terminal, and apply edits with full awareness of the project structure.

---

## 9. Multi-Agent Architectures and Orchestration Patterns

### Why Multi-Agent?

Single-agent systems have limitations:
- **Context window limits**: Complex tasks exceed what one agent can hold in memory.
- **Parallelism**: Many subtasks can be explored simultaneously.
- **Specialization**: Different agents can be optimized for different roles.
- **Compression**: Subagents distill findings before returning to the coordinator.

### Anthropic's Research System (Production Multi-Agent)

Anthropic's Claude Research feature uses an **orchestrator-worker pattern**:

1. **Lead Agent** (Claude Opus 4): Analyzes the query, develops strategy, spawns subagents.
2. **Subagents** (Claude Sonnet 4): Explore different aspects simultaneously with their own context windows.
3. **Citation Agent**: Post-processes to ensure proper attribution.

**Performance**: Multi-agent system with Opus 4 lead + Sonnet 4 subagents outperformed single-agent Opus 4 by **90.2%** on internal research evals.

**Key finding**: Token usage explains **80%** of performance variance. Multi-agent architectures effectively scale token usage. Agents typically use ~4× more tokens than chat; multi-agent systems use ~15× more.

**Cost tradeoff**: Multi-agent systems excel at **valuable tasks** involving heavy parallelization, information exceeding single context windows, and interfacing with numerous complex tools.

**Source**: [Anthropic Engineering Blog](https://www.anthropic.com/engineering/multi-agent-research-system)

### Common Multi-Agent Patterns

#### 1. Orchestrator-Worker
One lead agent coordinates multiple specialized worker agents.
```
Lead Agent → [Worker A, Worker B, Worker C] → Lead Agent → Final Output
```

#### 2. Pipeline / Sequential
Agents pass work sequentially like a production line.
```
Planner Agent → Coder Agent → Reviewer Agent → Tester Agent
```

#### 3. Supervisor-Subordinate Hierarchy
A supervisor agent manages subordinates, handling retries, fallbacks, and quality checks.

#### 4. Peer-to-Peer / Role-Based
Multiple agents with distinct roles communicate as peers (like a virtual team).
Example: CAMEL framework — user agent + assistant agent + task-specifier agent.

#### 5. Open SWE Architecture (LangChain)
Three specialized LangGraph agents in sequence:
- **Manager**: High-level task understanding and assignment.
- **Planner**: Breaks down the task into actionable steps.
- **Programmer** (with sub-agent Reviewer): Implements and reviews code.

**Source**: [LangChain Blog: Open SWE](https://blog.langchain.com/introducing-open-swe-an-open-source-asynchronous-coding-agent/)

### Prompt Engineering for Multi-Agent Systems

Anthropic's lessons from building their multi-agent Research system:

1. **Teach the orchestrator to delegate**: Each subagent needs an objective, output format, guidance on tools, and clear task boundaries.
2. **Scale effort to query complexity**: Embed explicit scaling rules (simple task = 1 agent with 3-10 tool calls; complex research = 10+ subagents).
3. **Tool design is critical**: Agents with poorly described tools fail fundamentally.
4. **Let agents improve themselves**: Claude 4 models can diagnose prompt failures and suggest improvements. A tool-testing agent that rewrote tool descriptions achieved **40% decrease in task completion time**.
5. **Start wide, then narrow**: Explore the landscape before drilling into specifics.
6. **Guide the thinking process**: Extended thinking mode as a controllable scratchpad.
7. **Parallel tool calling**: Cut research time by up to **90%** for complex queries.

**Source**: [Anthropic Engineering](https://www.anthropic.com/engineering/multi-agent-research-system)

### Frameworks for Multi-Agent Systems

| Framework | Creator | Key Feature |
|-----------|---------|-------------|
| **AutoGen** | Microsoft | Python library for chatbot-style multi-agent systems |
| **LangGraph** | LangChain | Stateful orchestration with graph-based workflows |
| **CAMEL** | Academic | Role-based agents (user, assistant, task-specifier) |
| **MetaGPT** | Academic | Multiple agents simulating a software team (PM, Architect, Engineer, QA) |
| **CrewAI** | CrewAI | Task-focused multi-agent coordination |
| **Agent Development Kit** | Google | Formalized stateful orchestration |

---

## 10. Scaffolding, Memory, and Context Management

### What is Agent Scaffolding?

**Agent scaffolding** is the software architecture and tooling built around an LLM to enable it to perform complex, goal-driven tasks. It includes:
- **Prompt templates** and instructions
- **Memory** (short-term and long-term)
- **Tool interfaces** and action handlers
- **Control flow** (the agentic loop)
- **Decision logic** and planning
- **Safety guardrails** and feedback mechanisms

> "Scaffolding means placing an LLM in a control loop with memory, tools, and decision logic so it can reason, plan, and act beyond simple one-shot prompts."
> — [ZBrain: Agent Scaffolding](https://zbrain.ai/agent-scaffolding/)

### Types of Scaffolds

| Type | Description |
|------|-------------|
| **Baseline scaffold** | Planning, reflection, and action phases in a structured reasoning loop |
| **Action-only scaffold** | Reactive execution without planning (lower performance) |
| **Pseudoterminal scaffold** | Direct interface to a terminal shell with real-time state |
| **Web search scaffold** | On-demand internet queries for external knowledge |

### Memory Systems

#### Short-Term Memory (Context Window)
- The conversation history within the current context window.
- Limited by model's maximum context length (e.g., 128K-200K tokens for modern models).
- Managed through **compaction/compression** when limits are approached.

#### Long-Term Memory
- **File-based**: Simple Markdown files for project notes (Claude Code's approach).
- **Vector databases**: Embedding-based retrieval of past interactions and documents.
- **Knowledge graphs**: Structured relationships between entities.
- **Conversation summaries**: Compressed versions of past interactions.

### Context Management Strategies

#### Claude Code's Approach
- **Compressor wU2** triggers at ~92% context utilization.
- Summarizes conversations and moves important information to **Markdown-based long-term storage**.
- Pragmatic choice: simple files over complex vector databases.
- Prioritizes **reliability and debuggability** over theoretical sophistication.

#### SWE-Agent's Approach
- **HistoryProcessor** compresses conversation history to fit context windows.
- Configurable amount of history retention.
- Prevents the agent from repeating itself.

#### Anthropic Research System
- Agents **save plans to Memory** to persist context (since context windows may be truncated at 200K tokens).
- Subagents operate in **separate context windows**, effectively multiplying available context.
- Completed work phases are summarized and stored before proceeding.
- Fresh subagents with clean contexts can be spawned while maintaining continuity through handoffs.

#### Active Context Compression (Academic Research)
Recent research introduces agents that **actively manage their own working context**:
- LLM agents autonomously decide what to keep, compress, or discard.
- **"Context Bloat"** is identified as a primary challenge: as interaction history grows, costs explode, latency increases, and reasoning degrades due to irrelevant past errors.
- **Context Folding**: Framework that empowers agents to actively manage working context, breaking tasks into subtasks and folding completed sub-trajectories into concise summaries.

**Source**: [arXiv: Active Context Compression (2601.07190)](https://arxiv.org/abs/2601.07190) | [JetBrains Research](https://blog.jetbrains.com/research/2025/12/efficient-context-management/) | [Weaviate: Context Engineering](https://weaviate.io/blog/context-engineering)

### Core Scaffolding Components

```
┌─────────────────────────────────────────────┐
│                  USER INPUT                  │
└──────────────────┬──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│              AGENT SCAFFOLD                  │
│                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ Planning │  │  Memory  │  │  Tools   │  │
│  │ & CoT    │  │ (short + │  │ (file,   │  │
│  │          │  │  long)   │  │  shell,  │  │
│  │          │  │          │  │  search) │  │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  │
│       │              │              │        │
│       └──────────┬───┘──────────────┘        │
│                  │                            │
│            ┌─────▼─────┐                     │
│            │    LLM    │                     │
│            │  (Brain)  │                     │
│            └─────┬─────┘                     │
│                  │                            │
│            ┌─────▼─────┐                     │
│            │ Feedback  │                     │
│            │ & Safety  │                     │
│            └───────────┘                     │
└─────────────────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│                  OUTPUT                      │
└─────────────────────────────────────────────┘
```

### Evolution of the Concept

| Period | Development |
|--------|-------------|
| 2022 | PromptChainer and early prompt-chaining interfaces |
| 2023 | CAMEL framework, chain-of-thought methods, tree-of-thought |
| 2024 | Microsoft AutoGen, LangChain LangGraph, Google ADK |
| 2025 | Production multi-agent platforms, Claude Agent SDK, standardized orchestration |

The term "scaffolding" captures the metaphor of **building support structures around an LLM** — framing and supporting the model as it works, similar to how construction scaffolding supports a building under construction.

### Best Practices

1. **Define clear objectives** — vague goals lead to scope creep.
2. **Break tasks into steps** — decompose so no single LLM call requires enormous reasoning leaps.
3. **Separate logic from memory** — keep prompt templates distinct from stored knowledge.
4. **Use interpretable intermediate outputs** — log reasoning steps for auditability.
5. **Implement safety checks** — validators, critics, max-iteration counters, kill switches.
6. **Leverage modular tools** — well-defined, task-specific tools with clear documentation.
7. **Monitor and log aggressively** — record every agent input/output and tool call.
8. **Iterate and test with feedback** — continuously refine based on failure cases.

---

## Summary: The Stack from LLM to Coding Agent

```
Layer 6: MULTI-AGENT ORCHESTRATION
         Coordinator + specialized workers, parallel execution

Layer 5: AGENTIC LOOP (ReAct)
         while(not_done): think → act → observe → repeat

Layer 4: TOOL USE / FUNCTION CALLING
         File I/O, terminal, search, browser, APIs

Layer 3: SCAFFOLDING
         Memory, context management, planning, safety

Layer 2: PROMPT ENGINEERING
         System prompts, few-shot examples, CoT instructions

Layer 1: RAW LLM
         Next-token prediction on code corpora
```

Each layer builds on the ones below it. A raw LLM can generate code one token at a time. Prompt engineering makes it more reliable. Scaffolding gives it memory and structure. Tool use lets it interact with the real world. The agentic loop lets it iterate and self-correct. Multi-agent orchestration lets it tackle problems too large for a single agent.

---

## Key References

1. Chen et al. (2021). "Evaluating Large Language Models Trained on Code" (Codex). [arXiv:2107.03374](https://arxiv.org/abs/2107.03374)
2. Rozière et al. (2023). "Code Llama: Open Foundation Models for Code." [Meta AI Blog](https://ai.meta.com/blog/code-llama-large-language-model-coding/)
3. Li et al. (2023). "Structured Chain-of-Thought Prompting for Code Generation." [arXiv:2305.06599](https://arxiv.org/abs/2305.06599)
4. Yao et al. (2022). "ReAct: Synergizing Reasoning and Acting in Language Models." [arXiv:2210.03629](https://arxiv.org/abs/2210.03629)
5. Yang et al. (2024). "SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering." [arXiv:2405.15793](https://arxiv.org/abs/2405.15793)
6. Wang et al. (2024). "OpenHands: An Open Platform for AI Software Developers as Generalist Agents." [arXiv:2407.16741](https://arxiv.org/abs/2407.16741)
7. OpenAI. "Function Calling Guide." [OpenAI API Docs](https://developers.openai.com/api/docs/guides/function-calling)
8. Anthropic. "How we built our multi-agent research system." [Anthropic Engineering Blog](https://www.anthropic.com/engineering/multi-agent-research-system)
9. GitHub. "Agent mode 101." [GitHub Blog](https://github.blog/ai-and-ml/github-copilot/agent-mode-101-all-about-github-copilots-powerful-mode/)
10. ZenML. "Claude Code Agent Architecture." [ZenML LLMOps Database](https://www.zenml.io/llmops-database/claude-code-agent-architecture-single-threaded-master-loop-for-autonomous-coding)
11. Pragmatic Engineer. "How do AI software engineering agents work?" [Newsletter](https://newsletter.pragmaticengineer.com/p/ai-coding-agents)
12. ZBrain. "Agent scaffolding explained." [ZBrain](https://zbrain.ai/agent-scaffolding/)
13. Prompt Engineering Guide. "ReAct Prompting." [promptingguide.ai](https://www.promptingguide.ai/techniques/react)
14. Towards Data Science. "Cracking the Code LLMs." [TDS](https://towardsdatascience.com/cracking-the-code-llms-354505c53295/)
15. Aider. "Separating code reasoning and editing." [aider.chat](https://aider.chat/2024/09/26/architect.html)
