# Agent Memory & Context Management — Deep Research Report

> **Date:** 2026-02-25  
> **Scope:** Memory architectures, save/retrieve patterns, available packages & tools for AI agents

---

## Table of Contents

1. [Why Memory Matters](#1-why-memory-matters)
2. [Memory Taxonomy](#2-memory-taxonomy)
3. [Memory Architecture Patterns](#3-memory-architecture-patterns)
4. [Context Window Management Techniques](#4-context-window-management-techniques)
5. [Available Packages & Tools](#5-available-packages--tools)
6. [Comparative Feature Matrix](#6-comparative-feature-matrix)
7. [Implementation Patterns](#7-implementation-patterns)
8. [Best Practices](#8-best-practices)
9. [Gaps & Emerging Trends](#9-gaps--emerging-trends)
10. [Recommendations for This Project](#10-recommendations-for-this-project)
11. [Sources](#11-sources)

---

## 1. Why Memory Matters

Stateless agents treat every conversation as a blank slate, wasting **70–80% of context tokens** on repeated information. Adding persistent memory delivers measurable improvements:

| Metric | Stateless Agent | Memory-Enabled Agent | Improvement |
|---|---|---|---|
| Context tokens/conversation | 2,500 avg | 600 avg | 76% reduction |
| LLM API costs/month (100K convos) | $2,400 | $960 | **60% savings** |
| Response quality score | 7.2/10 | 9.7/10 | +35% |
| Resolution time | 8.3 min | 3.1 min | 63% faster |

As of 2026, **67% of enterprise AI deployments** are planning memory systems, up from 12% in 2025. Memory-augmented agents are now table stakes.

---

## 2. Memory Taxonomy

Inspired by human cognitive science, agent memory is categorized into distinct types:

### 2.1 Short-Term Memory (Working Memory)
- **What:** Current conversation context, recent messages, active tool results
- **Lifespan:** Single session / conversation
- **Implementation:** In-context window, message buffers
- **Example:** The last 5–10 messages in the current chat

### 2.2 Long-Term Memory

#### Episodic Memory
- **What:** Specific past conversations, interactions, and events with timestamps
- **Use case:** "You asked about deployment issues last Tuesday"
- **Storage:** Time-series DB or vector store with temporal metadata
- **Cost:** ~$0.001–0.003 per stored episode

#### Semantic Memory
- **What:** Extracted facts, user preferences, learned knowledge
- **Use case:** "You prefer Python over JavaScript for backend code"
- **Storage:** Vector embeddings (Pinecone, Qdrant, pgvector)
- **Cost:** ~$0.002–0.005 per fact stored

#### Procedural Memory
- **What:** Learned workflows, action sequences, decision patterns
- **Use case:** "When debugging API errors, you check logs first, then trace requests"
- **Storage:** Graph DB (Neo4j, Neptune) or workflow state machines
- **Cost:** ~$0.003–0.008 per workflow pattern

### 2.3 Hybrid / Hierarchical Memory
Some advanced systems (MemoryOS) use **four-level hierarchies** — Short-, Mid-, Long-, and Profile-term — achieving state-of-the-art results on benchmarks like LoCoMo (+49% F1).

---

## 3. Memory Architecture Patterns

### 3.1 Memory Block Pattern (Letta/MemGPT style)
The agent's memory is organized as **labeled text blocks** compiled into the system prompt:

```
System Prompt:
  <agent instructions>
  
  ### Memory
  [persona]: I am a helpful coding assistant...
  [human]: The user prefers TypeScript, uses VS Code...
  [project]: Current project is a Node.js agent...
  
  <tool instructions>
```

The agent has **self-editing tools** (`memory_replace`, `memory_append`, `memory_rethink`) to mutate its own memory blocks during execution. Changes are persisted to DB and compiled into the next system prompt.

**Strengths:** White-box, full agent control, persistent across sessions  
**Weaknesses:** Character limits on blocks, no built-in knowledge graph

### 3.2 Extraction + Retrieval Pattern (Mem0 style)
Conversations are processed through an **extraction pipeline** that identifies facts, preferences, and patterns. Extracted memories are stored as embeddings and retrieved via semantic search:

```
User message → LLM Extraction → Facts/Preferences → Embed → Vector Store
                                                              ↓
Query → Embed → Semantic Search → Top-K relevant memories → System Prompt
```

**Strengths:** Automatic, scales to many users, production-ready APIs  
**Weaknesses:** Black-box extraction, potential hallucinated facts

### 3.3 Knowledge Graph Pattern (Zep/Cognee style)
Interactions are ingested into a **temporal knowledge graph** that tracks entities, relationships, and how facts change over time:

```
Conversations → Entity Extraction → Graph DB (Neo4j/Neptune)
                                         ↓
Query → Graph Traversal + Vector Search → Relevant subgraph → Context
```

**Strengths:** Multi-hop reasoning, temporal queries, handles changing facts  
**Weaknesses:** Heavier infrastructure, requires graph DB

### 3.4 Checkpoint/State Pattern (LangGraph style)
The entire agent state is **checkpointed** at each step. Long-term memory is implemented as namespace-scoped key-value stores:

```
Agent State → Checkpoint → Storage Backend (PostgreSQL, Redis, MongoDB)
                              ↓
Resume → Load Checkpoint → Restore Full State
```

**Strengths:** Full state recovery, integrates with LangChain ecosystem  
**Weaknesses:** Can be heavy, thin abstraction over storage

---

## 4. Context Window Management Techniques

### 4.1 Context Trimming
Keep only the last **N turns** (user message + all subsequent assistant/tool responses). Simple, deterministic, zero added latency.

```typescript
// Pseudocode: Keep last N user turns
function trim(history: Message[], maxTurns: number): Message[] {
  const userIndices = history
    .map((m, i) => m.role === 'user' ? i : -1)
    .filter(i => i >= 0);
  if (userIndices.length <= maxTurns) return history;
  const cutoff = userIndices[userIndices.length - maxTurns];
  return history.slice(cutoff);
}
```

**Pros:** Simple, predictable, no extra LLM calls  
**Cons:** Abrupt forgetting, long-range context lost

### 4.2 Context Summarization (Compaction)
When history exceeds a threshold, **summarize older messages** into a compact representation and keep recent turns verbatim.

```
[Older messages] → LLM Summarizer → Compact Summary
[Summary] + [Recent N turns] → New context window
```

**Pros:** Retains long-range memory compactly, smoother UX  
**Cons:** Summarization loss, added latency, potential "context poisoning"

### 4.3 Sliding Window + Summary Hybrid
Combine both: maintain a rolling window of recent messages with a periodically refreshed summary of everything older. This is the most common production pattern.

### 4.4 RAG-Augmented Memory
Store all interactions in a vector store. For each new query, **retrieve** the most relevant past interactions via semantic search and inject them into the context.

**Best for:** Large knowledge bases, many users, when you can't predict which past context matters

---

## 5. Available Packages & Tools

### 5.1 Mem0 ⭐ (Most Popular — 38.8K GitHub stars)

| Property | Detail |
|---|---|
| **Repo** | [github.com/mem0ai/mem0](https://github.com/mem0ai/mem0) |
| **License** | Apache-2.0 |
| **Languages** | Python SDK + **Node.js/TypeScript SDK** (`mem0ai` on npm) |
| **Memory model** | Three layers: User, Session, Agent |
| **Storage** | Vector stores (Qdrant, Chroma, Milvus, pgvector, Redis) + optional graph (Neo4j) |
| **Key feature** | LoCoMo pipeline: +26% accuracy, −91% latency vs full-context |
| **SaaS** | Yes (managed platform + OpenMemory MCP server) |

**Node.js Quick Start:**
```typescript
import { Memory } from "mem0ai/oss";

const memory = new Memory({
  version: "v1.1",
  embedder: {
    provider: "openai",
    config: { apiKey: process.env.OPENAI_API_KEY, model: "text-embedding-3-small" }
  },
  vectorStore: {
    provider: "memory",  // or "qdrant", "chroma", etc.
    config: { collectionName: "memories", dimension: 1536 }
  },
  llm: {
    provider: "openai",
    config: { apiKey: process.env.OPENAI_API_KEY, model: "gpt-4-turbo-preview" }
  },
  historyDbPath: "memory.db"
});

// Add memories
await memory.add("I prefer TypeScript over JavaScript", { userId: "user-1" });

// Search memories
const results = await memory.search("What language does the user prefer?", { userId: "user-1" });

// Manage
const history = await memory.history("memory-id");
await memory.delete("memory-id");
await memory.deleteAll({ userId: "user-1" });
await memory.reset();
```

---

### 5.2 Letta (ex-MemGPT) — 18.1K stars

| Property | Detail |
|---|---|
| **Repo** | [github.com/letta-ai/letta](https://github.com/letta-ai/letta) |
| **License** | Apache-2.0 |
| **Language** | Python |
| **Architecture** | OS-style memory kernel with self-editing memory blocks |
| **Storage** | PostgreSQL (default) |
| **Key feature** | Agent controls its own memory via system calls (`memory_replace`, `memory_append`, `memory_rethink`) |
| **GUI** | Agent Development Environment (ADE) for debugging |

**Memory Block Architecture:**
- **`persona` block**: Agent's personality/role description
- **`human` block**: Stored info about the user
- **Custom blocks**: Domain-specific memory  
- **File blocks**: Read-only, open file contents with LRU eviction
- **Archival memory**: Long-term passage storage with embedding-based retrieval
- **Recall memory**: Recently accessed data

**Memory Tools (V3 — unified omni-tool):**
```python
# The agent calls these tools itself during execution:
memory(label="human", action="replace", old="prefers Python", new="prefers TypeScript")
memory(label="project", action="append", content="Uses Redis for caching")
memory_rethink(label="persona", new_content="Complete rewrite of persona block...")
```

---

### 5.3 Zep + Graphiti — 17.3K stars (Graphiti)

| Property | Detail |
|---|---|
| **Repos** | [github.com/getzep/graphiti](https://github.com/getzep/graphiti) (core), [github.com/getzep/zep](https://github.com/getzep/zep) |
| **License** | Apache-2.0 |
| **SDKs** | Python, TypeScript, Go |
| **Architecture** | Temporal Knowledge Graph |
| **Key feature** | Graph-based memory with time-aware queries, handles fact changes |
| **SaaS** | Zep Cloud (CE support discontinued April 2025) |

**Key capabilities:**
- Incremental graph updates from conversations
- Semantic + BM25 hybrid search
- Temporal queries for fact recency
- Multi-hop reasoning via graph traversal
- Integrations: LangChain, LangGraph, Autogen, Vercel AI SDK

---

### 5.4 Redis Agent Memory Server

| Property | Detail |
|---|---|
| **Repo** | [github.com/redis/agent-memory-server](https://github.com/redis/agent-memory-server) |
| **License** | Apache-2.0 |
| **Interface** | REST API + MCP Server |
| **Architecture** | Two-tier: Working Memory (session) + Long-term Memory (persistent) |
| **LLM Support** | 100+ providers via LiteLLM (OpenAI, Anthropic, Bedrock, Ollama) |

**Features:**
- Configurable memory strategies (discrete, summary, preferences, custom)
- Automatic topic extraction, entity recognition, conversation summarization
- Python SDK + LangChain integration
- MCP protocol support for Claude Desktop and other MCP clients
- Background task worker for async memory extraction

```python
from agent_memory_client import MemoryAPIClient

client = MemoryAPIClient(base_url="http://localhost:8000")

# Store
await client.create_long_term_memories([{
    "text": "User prefers morning meetings",
    "user_id": "user123",
    "memory_type": "preference"
}])

# Search
results = await client.search_long_term_memory(
    text="What time does the user like meetings?",
    user_id="user123"
)
```

---

### 5.5 Cognee — Knowledge Graph Memory

| Property | Detail |
|---|---|
| **Repo** | [github.com/topoteretes/cognee](https://github.com/topoteretes/cognee) |
| **License** | Apache-2.0 |
| **Language** | Python |
| **Architecture** | Semantic graph + vector search (ECL pipelines) |
| **Storage** | Neo4j, Memgraph, Qdrant, Weaviate, pgvector |

**Key capabilities:**
- Combines vector search and knowledge graphs
- Modular ETL/ECL pipelines for data processing
- Automatic entity extraction and graph construction
- 100% local operation supported (with Ollama)
- MCP server support

---

### 5.6 LangGraph Memory (Checkpointing)

| Property | Detail |
|---|---|
| **Repo** | Part of [LangChain ecosystem](https://github.com/langchain-ai/langgraph) |
| **License** | MIT |
| **Languages** | Python, JavaScript/TypeScript |
| **Architecture** | Graph-based state machine with namespace-scoped memory |

**Key features:**
- Full state checkpointing at each node
- Namespace-scoped long-term memory stores
- MongoDB Atlas, PostgreSQL backends
- Replaces deprecated `ConversationBufferMemory` from LangChain v0.3

> **Note:** LangChain v0.3 **deprecated** legacy Memory classes. Migrate to LangGraph checkpointing.

---

### 5.7 LlamaIndex Memory

| Property | Detail |
|---|---|
| **Docs** | [docs.llamaindex.ai](https://docs.llamaindex.ai/en/stable/module_guides/deploying/agents/memory/) |
| **License** | Apache-2.0 |
| **Architecture** | Customizable `BaseMemory` with interaction nodes |

- Flexible retrievers, 20+ index types
- Multi-modal retrieval (images, figures)
- No automatic eviction (manual management)

---

### 5.8 Microsoft Semantic Kernel / Kernel Memory

| Property | Detail |
|---|---|
| **Repo** | [github.com/microsoft/kernel-memory](https://github.com/microsoft/kernel-memory) |
| **License** | MIT |
| **SDKs** | C#, Python, Java |
| **Storage** | PostgreSQL, Redis, Azure Search, and more |

- Enterprise-ready with strong security model
- Multi-tenant support
- Integrates with Azure AI services
- .NET-first but supports Python/Java

---

### 5.9 Other Notable Tools

| Tool | Stars | Description |
|---|---|---|
| **LangMem** | — | Functional primitives for memory recording + background consolidation daemon. MIT license. |
| **MemoryOS** | — | Four-level hierarchy (Short/Mid/Long/Profile). Rust core + Python client. SOTA on LoCoMo (+49% F1). Apache-2.0. |
| **A-MEM** | — | Zettelkasten-style note+link model with dynamic linking. Research-oriented. MIT. |
| **Memary** | — | Local-first memory layer with Neo4j/FalkorDB knowledge graph + Streamlit GUI. MIT. |
| **AWS AgentCore** | — | Enterprise memory service. Async extraction, built-in RAG. Episodic + Semantic. |
| **OpenAI Memory** | — | Built into ChatGPT. Saved Memories + Reference History. Zero-setup but closed-source. |

---

## 6. Comparative Feature Matrix

| Solution | Hierarchical | Knowledge Graph | Vector Retrieval | Event Triggers | Agent Runtime | SaaS | Node.js SDK | License |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|---|
| **Mem0** | ✅ | ⚠️ | ✅ | ❌ | ⚠️ | ✅ | ✅ | Apache-2.0 |
| **Letta** | ✅ | ❌ | ✅ | ✅ | ✅ | ❌ | ❌ | Apache-2.0 |
| **Zep/Graphiti** | ✅ | ✅ | ✅ | ⚠️ | ⚠️ | ✅ | ✅ | Apache-2.0 |
| **Redis Agent Memory** | ⚠️ | ❌ | ✅ | ❌ | ❌ | ❌ | ❌ | Apache-2.0 |
| **Cognee** | ❌ | ✅ | ✅ | ❌ | ❌ | ⚠️ | ❌ | Apache-2.0 |
| **LangGraph** | ⚠️ | ⚠️ | ✅ | ⚠️ | ✅ | ❌ | ✅ | MIT |
| **LlamaIndex** | ⚠️ | ❌ | ✅ | ❌ | ✅ | ❌ | ✅ | Apache-2.0 |
| **Semantic Kernel** | ❌ | ❌ | ✅ | ❌ | ⚠️ | ✅ | ❌ | MIT |
| **MemoryOS** | ✅ | ❌ | ✅ | ❌ | ✅ | ❌ | ❌ | Apache-2.0 |
| **OpenAI Memory** | ❌ | ❌ | ⚠️ | ❌ | ✅ | ✅ | ✅ | Proprietary |

✅ = Full support · ⚠️ = Partial/inherited · ❌ = Not supported

---

## 7. Implementation Patterns

### 7.1 Pattern: File-Based Memory (Simplest — Good for Single-User Agents)

Store memories as structured markdown/JSON files that are loaded into context:

```typescript
// CLAUDE.md / MEMORY.md pattern (what this project already uses)
interface FileMemory {
  load(): string;           // Read file content
  save(content: string);    // Write updated content
  append(fact: string);     // Add new fact
}

// Load into system prompt:
const memory = fs.readFileSync('CLAUDE.md', 'utf-8');
systemPrompt = `${basePrompt}\n\n## Memory\n${memory}`;
```

**Pros:** Zero infrastructure, version-controlled, human-readable  
**Cons:** Doesn't scale, no semantic search, entire file loaded every time

---

### 7.2 Pattern: Vector Store Memory (Production-Ready)

```typescript
// Using Mem0 Node.js SDK
import { Memory } from "mem0ai/oss";

class AgentMemory {
  private memory: Memory;
  
  constructor() {
    this.memory = new Memory({
      version: "v1.1",
      embedder: { provider: "openai", config: { model: "text-embedding-3-small" } },
      vectorStore: { provider: "qdrant", config: { url: "http://localhost:6333" } },
      llm: { provider: "openai", config: { model: "gpt-4o-mini" } }
    });
  }

  async remember(text: string, userId: string) {
    await this.memory.add(text, { userId });
  }

  async recall(query: string, userId: string, topK = 5) {
    return this.memory.search(query, { userId, limit: topK });
  }

  async getContext(query: string, userId: string): string {
    const memories = await this.recall(query, userId);
    return memories.map(m => `- ${m.text}`).join('\n');
  }
}
```

---

### 7.3 Pattern: Self-Editing Memory Blocks (Letta-style)

The agent has tools to read and write its own memory:

```typescript
// Memory as labeled blocks in system prompt
interface MemoryBlock {
  label: string;
  value: string;
  limit: number;
  readOnly: boolean;
}

// Tools the agent can call:
const memoryTools = {
  core_memory_replace: (label: string, oldText: string, newText: string) => {
    const block = blocks.find(b => b.label === label);
    block.value = block.value.replace(oldText, newText);
    persistToDb(block);
  },
  core_memory_append: (label: string, text: string) => {
    const block = blocks.find(b => b.label === label);
    block.value += '\n' + text;
    persistToDb(block);
  }
};

// Compile into system prompt each turn:
function compileMemory(blocks: MemoryBlock[]): string {
  return blocks.map(b => `[${b.label}]:\n${b.value}`).join('\n\n');
}
```

---

### 7.4 Pattern: Context Compaction (Summarization)

When conversation history exceeds a threshold, summarize older messages:

```typescript
async function compactContext(
  messages: Message[],
  maxTurns: number,
  keepRecent: number
): Promise<Message[]> {
  const userTurnIndices = messages
    .map((m, i) => m.role === 'user' ? i : -1)
    .filter(i => i >= 0);

  if (userTurnIndices.length <= maxTurns) return messages;

  // Split into old (to summarize) and recent (to keep verbatim)
  const boundary = userTurnIndices[userTurnIndices.length - keepRecent];
  const oldMessages = messages.slice(0, boundary);
  const recentMessages = messages.slice(boundary);

  // Summarize old messages
  const summary = await llm.summarize(oldMessages);

  return [
    { role: 'user', content: 'Summary of earlier conversation:' },
    { role: 'assistant', content: summary },
    ...recentMessages
  ];
}
```

---

### 7.5 Pattern: Background Memory Extraction

Extract memories asynchronously without blocking the response:

```typescript
class BackgroundMemoryExtractor {
  private queue: Message[][] = [];

  // Non-blocking: queue for background processing
  enqueue(messages: Message[]) {
    this.queue.push(messages);
    setImmediate(() => this.processQueue());
  }

  private async processQueue() {
    while (this.queue.length > 0) {
      const messages = this.queue.shift()!;
      const facts = await this.extractFacts(messages);
      for (const fact of facts) {
        await this.vectorStore.upsert(fact);
      }
    }
  }

  private async extractFacts(messages: Message[]): Promise<string[]> {
    const response = await llm.chat({
      messages: [{
        role: 'system',
        content: `Extract user preferences, facts, and patterns from this conversation.
                  Return JSON: { "facts": ["fact1", "fact2"] }`
      }, ...messages]
    });
    return JSON.parse(response).facts;
  }
}
```

---

## 8. Best Practices

### 8.1 Memory Retention Policies
Don't store everything forever:
- **Episodic memory:** 90 days (old conversations rarely matter)
- **Semantic memory:** 1 year (preferences stay relevant longer)
- **Procedural memory:** 6 months (workflows evolve)

### 8.2 Relevance Scoring
- Use cosine similarity threshold (> 0.7) — don't inject irrelevant memories
- Limit to **5–7 most relevant** memories per query
- Summarize memories rather than injecting raw text

### 8.3 Asynchronous Extraction
Never block the response waiting for memory extraction. Use background workers or `setImmediate()` / `asyncio.create_task()`.

### 8.4 Memory Validation
Validate extracted facts with a second LLM pass or rule-based filters. Extracted nonsense like "User prefers yes" degrades quality.

### 8.5 Multi-Tenant Isolation
Always namespace memories by `userId` and `agentId`. Use vector store namespaces (Pinecone) or collection-per-tenant patterns.

### 8.6 Privacy & Compliance (GDPR)
- Implement user data deletion (`deleteAll({ userId })`)
- Maintain audit logs of stored/retrieved memories
- Encrypt at rest (Redis encryption, AWS KMS)
- Provide user controls to view/delete their memories

### 8.7 Observability
Monitor:
- Memory retrieval latency (P50, P95, P99)
- Cache hit rates
- Relevance scores of retrieved memories
- Storage costs per user
- Extraction success rate

### 8.8 Memory vs. RAG — Use Both
| Use Case | Tool |
|---|---|
| User preferences & behavior | **Agent Memory** |
| Large knowledge bases (docs, catalogs) | **RAG** |
| Conversation continuity | **Agent Memory** |
| Frequently changing external data | **RAG** |
| User-specific context (tech stack, team) | **Agent Memory** |
| Factual grounding from external sources | **RAG** |

---

## 9. Gaps & Emerging Trends

### Current Gaps (Opportunities)
1. **Spatial/hyperbolic topology** — absent across all tools; limits global reasoning and visualization
2. **Unified 3D workspace** for humans and agents — not yet emerged
3. **Reasoning-on-memory** — most systems are passive retrieval caches, not active cognitive modules
4. **Multi-modal memory** (images, audio, video) — not systematically integrated
5. **Collaborative memory between agents** — still in infancy
6. **Automated memory compression with "rewind"** — fine-grained time-travel is rare

### Emerging Trends (2025–2026)
1. **AgeMem framework** (Alibaba, Jan 2026) — unified short-term and long-term memory, +23% improvement on long-horizon tasks
2. **MCP-based memory servers** — Redis, Mem0 offer MCP protocol support for plug-and-play memory
3. **Temporal Knowledge Graphs** (Graphiti/Zep) — memory that understands fact changes over time
4. **Self-editing memory** (Letta v3) — agents managing their own memory blocks via unified "omni-tool"
5. **Sleeptime agents** — background processes that consolidate and refine memory when idle
6. **Context engineering** replacing "prompt engineering" — treating the entire context window as a carefully curated input

---

## 10. Recommendations for This Project

Given that this is a **TypeScript/Node.js coding agent** (`codingagent`), here are tailored recommendations:

### Quick Wins (Low effort, high impact)
1. **Enhance CLAUDE.md** — Already using file-based memory. Add structured sections for user preferences, project facts, and workflow patterns that the agent updates.
2. **Session-level compaction** — The project already has `src/core/compaction`. Ensure it uses summarization (not just trimming) to preserve long-range context.

### Medium-Term (Moderate effort)
3. **Mem0 integration via npm** — Install `mem0ai` package for persistent semantic memory:
   ```bash
   npm install mem0ai
   ```
   Use it to store/retrieve user preferences and project facts across sessions.

4. **Self-editing memory blocks** — Add tools that let the agent update its own memory files (similar to Letta's `core_memory_replace`).

### Long-Term (Higher effort, highest value)
5. **MCP Memory Server** — Connect to Redis Agent Memory Server or Mem0's OpenMemory MCP server for enterprise-grade persistent memory with semantic search.
6. **Background extraction** — After each conversation, asynchronously extract facts and preferences into a vector store using the gateway worker architecture.

### Architecture Fit

```
┌──────────────────────────────────────────────────┐
│                   Agent Core                      │
│  ┌────────────┐  ┌─────────────┐  ┌───────────┐  │
│  │ Short-Term │  │  Compaction  │  │  Session   │  │
│  │  (context) │→ │ (summarize) │  │  Manager   │  │
│  └────────────┘  └─────────────┘  └───────────┘  │
│        ↕                ↕               ↕         │
│  ┌─────────────────────────────────────────────┐  │
│  │           Memory Layer (new)                │  │
│  │  ┌──────────┐ ┌──────────┐ ┌─────────────┐ │  │
│  │  │ CLAUDE.md│ │ Mem0 SDK │ │ MCP Memory  │ │  │
│  │  │ (file)   │ │ (vector) │ │ Server      │ │  │
│  │  └──────────┘ └──────────┘ └─────────────┘ │  │
│  └─────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

---

## 11. Sources

1. [AI Agent Memory Systems Implementation Guide 2026](https://iterathon.tech/blog/ai-agent-memory-systems-implementation-guide-2026) — Iterathon
2. [Memory in the Age of AI Agents: A Survey](https://arxiv.org/abs/2512.13564) — arXiv (Dec 2025)
3. [Survey of AI Agent Memory Frameworks](https://www.graphlit.com/blog/survey-of-ai-agent-memory-frameworks) — Graphlit
4. [Landscape of Memory Solutions for LLM Agents](https://mnemoverse.com/docs/research/memory-solutions-landscape) — Mnemoverse (Aug 2025)
5. [Mem0 Documentation & Node.js Quickstart](https://docs.mem0.ai/open-source/node-quickstart) — Mem0
6. [Letta Agent Memory System](https://deepwiki.com/letta-ai/letta/2.3-agent-memory-system) — DeepWiki
7. [Redis Agent Memory Server](https://github.com/redis/agent-memory-server) — Redis
8. [Context Engineering: Session Memory](https://developers.openai.com/cookbook/examples/agents_sdk/session_memory) — OpenAI Cookbook
9. [Agent Memory: Letta vs Mem0 vs Zep vs Cognee](https://forum.letta.com/t/agent-memory-letta-vs-mem0-vs-zep-vs-cognee/88) — Letta Forum
10. [From Beta to Battle-Tested: Letta, Mem0, Zep](https://medium.com/asymptotic-spaghetti-integration/from-beta-to-battle-tested-picking-between-letta-mem0-zep-for-ai-memory-6850ca8703d1) — Medium
11. [Memory in Agents: Episodic vs Semantic](https://principia-agentica.io/blog/2025/09/19/memory-in-agents-episodic-vs-semantic-and-the-hybrid-that-works/) — Principia Agentica
12. [Build Hour: Agent Memory Patterns](https://rmj.videotoblog.ai/agent-memory-playbook) — Agent Memory Playbook
13. [Cognee: Knowledge Graph Memory](https://www.cognee.ai/) — Cognee
14. [Microsoft Kernel Memory](https://github.com/microsoft/kernel-memory) — Microsoft
15. [LangGraph Long-Term Memory](https://langchain-tutorials.github.io/implement-long-term-memory-langgraph-step-by-step/) — LangChain Tutorials

---

*Report generated for the codingagent project. Last updated: 2026-02-25.*
