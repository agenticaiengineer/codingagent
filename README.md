# @agenticaiengineer/codingagent

[![npm version](https://img.shields.io/npm/v/@agenticaiengineer/codingagent)](https://www.npmjs.com/package/@agenticaiengineer/codingagent)
[![license](https://img.shields.io/npm/l/@agenticaiengineer/codingagent)](LICENSE)

An autonomous AI coding agent for your terminal.

Read, write, and edit files. Run shell commands. Search the web. Spawn sub-agents. Manage sessions. All from a single interactive REPL.

---

## Install

```bash
npm install -g @agenticaiengineer/codingagent
```

> **Requires Node.js 18+** and an [Anthropic API key](https://console.anthropic.com/).

## Quick Start

```bash
# Set your API key (Linux/macOS)
export ANTHROPIC_API_KEY=sk-ant-...

# Set your API key (Windows PowerShell)
$env:ANTHROPIC_API_KEY = "sk-ant-..."

# Set your API key (Windows cmd)
set ANTHROPIC_API_KEY=sk-ant-...

# Launch the agent
codingagent
```

You'll land in an interactive REPL where you can give instructions in plain English:

```
> Refactor the auth module to use JWT tokens
> Find all TODO comments and create a summary
> Write unit tests for src/utils.ts
```

## Features

### 🛠 Built-in Tools

| Tool | Description |
|------|-------------|
| **Read** | Read files with line numbers, offset, and limit |
| **Write** | Write/create files (creates parent directories) |
| **Edit** | Exact string replacements in files |
| **Glob** | Fast file pattern matching (`**/*.ts`) |
| **Grep** | Regex search powered by ripgrep |
| **Bash** | Execute shell commands |
| **Task** | Spawn autonomous sub-agents |
| **Transcribe** | Local audio-to-text transcription (Whisper ONNX) |
| **WebFetch** | Fetch and extract content from URLs |
| **WebSearch** | Search the web via DuckDuckGo |
| **Open** | Open files/URLs in external applications |

### 🎤 Audio Transcription

Built-in local transcription powered by Whisper ONNX — no API calls, no Python, no ffmpeg.

**Supported formats:** `.wav`, `.oga` (Telegram voice), `.ogg`, `.mp3`, `.flac`

**Models** (auto-downloaded on first use):

| Model | Size | Speed | Accuracy |
|-------|------|-------|----------|
| `tiny` | ~75 MB | Fastest | Basic |
| `base` | ~150 MB | Fast | Good (default) |
| `small` | ~500 MB | Medium | Better |
| `medium` | ~1.5 GB | Slow | Best |

Audio decoding uses pure WASM decoders (no native dependencies):

| Format | Decoder | Typical use |
|--------|---------|-------------|
| `.wav` | Inline RIFF parser | Standard audio |
| `.oga`/`.ogg` | `ogg-opus-decoder` | Telegram voice messages |
| `.mp3` | `mpg123-decoder` | Common audio |
| `.flac` | `@wasm-audio-decoders/flac` | Lossless audio |

Telegram voice messages are automatically transcribed when using the Telegram port.

### 🤖 Sub-Agents

Spawn specialized background agents for parallel work:

- **Explore** — Fast read-only codebase exploration (uses small model)
- **Plan** — Architecture and implementation planning
- **Bash** — Shell-heavy automation tasks
- **General-purpose** — Full-capability agent

```
> /agents        # list running agents
```

### 🔌 MCP (Model Context Protocol)

Connect to external MCP servers for additional tools. Configuration is auto-discovered from:

- `.mcp.json` — Project-level (team-shared)
- `~/.claude.json` — User-level (all projects)
- `.vscode/mcp.json` — VS Code / Copilot MCP
- Claude Desktop config — Desktop app MCP servers

```
> /mcp           # show connected servers & tools
```

### 🧠 Project Memory & Skills

Automatically loads context from instruction files:

| Source | File |
|--------|------|
| Claude Code | `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| OpenAI Codex | `AGENTS.md`, `~/.codex/AGENTS.md` |
| Google Gemini | `GEMINI.md` |
| Skills | `.claude/skills/*.md`, `.github/prompts/*.prompt.md` |

### 💾 Session Management

Save, resume, and manage conversation sessions:

```
> /save              # save current session
> /sessions          # list saved sessions
> /resume             # resume last session
> /resume #3          # resume session by number
```

### ⚡ Context Management

Automatic context compaction keeps conversations within token limits. Extended thinking support for complex reasoning tasks.

### 🔍 Multi-Judge Eval Gate

Enable AI evaluation to verify the agent's work before accepting it:

```bash
codingagent --eval -p "Refactor the auth module to use JWT tokens"
```

Three independent judges evaluate from different perspectives:
- **Correctness** — Are there bugs or logic errors?
- **Completeness** — Were all parts of the request addressed?
- **Goal Alignment** — Does the result actually solve the user's problem?

The work is accepted when a **majority** of judges approve. If they don't, their
feedback is automatically injected and the agent refines its work (up to 3 rounds).

## REPL Commands

| Command | Description |
|---------|-------------|
| `/help` | Show help message |
| `/clear` | Clear conversation history |
| `/compact` | Compact context to save tokens |
| `/tokens` | Show estimated token count |
| `/status` | Show session info & statistics |
| `/history` | Show recent prompt history |
| `/model <name>` | Switch model |
| `/smallmodel <name>` | Switch small model (compaction/exploration) |
| `/undo` | Stash uncommitted file changes |
| `/retry` | Re-send last prompt |
| `/agents` | Show background agent status |
| `/save` | Save session |
| `/sessions` | List saved sessions |
| `/resume [id]` | Resume a saved session |
| `/cache` | Show explore cache statistics |
| `/mcp` | Show MCP server status |
| `/memory` | Show loaded project memory |
| `/skills` | List available skills |
| `/reload` | Hot restart (reload code + tools) |
| `/quit` | Exit |

## Configuration

Configuration is loaded from multiple sources with **first-set-wins** semantics — a variable set in a higher-priority source is never overridden by a lower one.

**Priority order:**
1. Environment variables (highest)
2. `~/.claude/settings.json` → `"env"` object
3. `.env` file in project root
4. `~/.codingagent/secrets.json`

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Your Anthropic API key (required) | — |
| `ANTHROPIC_BASE_URL` | Custom API endpoint URL | `https://api.anthropic.com` |
| `ANTHROPIC_MODEL` | Model to use | `claude-sonnet-4-20250514` |
| `ANTHROPIC_SMALL_FAST_MODEL` | Small model for compaction/exploration | `claude-haiku-3-5-20241022` |
| `ANTHROPIC_MAX_OUTPUT_TOKENS` | Max output tokens per response | `16384` |
| `ANTHROPIC_COMPACTION_THRESHOLD` | Token count to trigger auto-compaction | `160000` |
| `ANTHROPIC_DISABLE_STREAMING` | Skip streaming API, use non-streaming directly | `false` |
| `CODINGAGENT_DEBUG` | Enable debug output (`1`, `true`, `yes`, `on`) | `false` |

### Settings File

Create `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_API_KEY": "sk-ant-...",
    "ANTHROPIC_BASE_URL": "https://api.anthropic.com",
    "ANTHROPIC_MODEL": "claude-sonnet-4-20250514",
    "ANTHROPIC_SMALL_FAST_MODEL": "claude-haiku-3-5-20241022",
    "ANTHROPIC_MAX_OUTPUT_TOKENS": "16384",
    "ANTHROPIC_COMPACTION_THRESHOLD": "160000"
  },
  "skillDirs": ["/path/to/custom/skills"]
}
```

### `.env` File

Create a `.env` file in your project root:

```bash
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_BASE_URL=https://api.anthropic.com
ANTHROPIC_MODEL=claude-sonnet-4-20250514
```

### Custom API Endpoint

To use a proxy or alternative API-compatible endpoint, set `ANTHROPIC_BASE_URL`:

```bash
# Linux/macOS
export ANTHROPIC_BASE_URL=https://my-proxy.example.com

# Windows PowerShell
$env:ANTHROPIC_BASE_URL = "https://my-proxy.example.com"

# Windows cmd
set ANTHROPIC_BASE_URL=https://my-proxy.example.com
```

> **Note:** Do **not** include `/v1` at the end — the SDK appends `/v1/messages` automatically. A base URL ending in `/v1` would produce a double-pathed URL like `https://proxy.com/v1/v1/messages`.

## Development

```bash
# Clone the repo
git clone https://github.com/agenticaiengineer/codingagent.git
cd codingagent

# Install dependencies
npm install

# Run in development mode (uses tsx, runs TypeScript directly)
npm run dev

# Build (TypeScript compilation only, for local use)
npm run build

# Bundle for publishing (esbuild single-file bundle)
npm run bundle
```

### Testing

```bash
# Run integration tests (bundles first)
npm test

# Run agent behavior tests only (skip rebuild)
npm run test:agent

# Run install & load tests only
npm run test:integration

# Run all test suites (install + agent)
npm run test:all
```

## Publishing

```bash
# Bump version
npm version patch

# Publish to npm (auto-runs clean + bundle + smoke-test)
npm publish --access=public
```

## Security Notes

- **Teams integration**: The Microsoft Teams bot port does **not** implement full JWT token verification of incoming requests. It relies on tenant ID filtering only. **Do not deploy the Teams port to the public internet** without implementing proper Bot Framework authentication. See `src/ports/teams-port.ts` for details.
- **API keys**: Never commit API keys. Use environment variables, `~/.claude/settings.json`, or `.env` files (which are gitignored).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

[MIT](LICENSE)
