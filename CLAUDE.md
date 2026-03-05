# Codingagent — Project Memory

## Overview
A **TypeScript-based AI Coding Agent**. This is the codebase that powers the coding assistant itself.

## Project Structure

| Folder | Purpose |
|---|---|
| `src/core/` | Agent loop, client, context, streaming executor, compaction, MCP client, debug |
| `src/tools/` | Tool implementations — Read, Write, Edit, Glob, Grep, Bash, Task, Web, Browser, Open, Transcribe |
| `src/session/` | Session management and runner |
| `src/gateway/` | Gateway & agent worker (multi-process IPC) |
| `src/ports/` | I/O adapters — Terminal, Telegram, Teams |
| `src/ui/` | UI rendering, markdown, commands, frecency |
| `src/config/` | Configuration and skills |
| `src/eval/` | Evaluation framework |
| `src/scripts/` | Telegram & Teams entry scripts |
| `publish/` | Build & publish scripts — bundle, smoke-test |
| `tests/` | Integration tests — mock server, agent behavior tests |
| `dist/` | Compiled JavaScript output |
| `bench/` | Benchmarks (audio decoding) |

## Key Files
- `ARCHITECTURE.md` — Architecture documentation
- `CODING_AGENT_PATTERNS.md` — Patterns and best practices
- `CODE_IMPROVEMENT_REPORT.md` — Improvement notes
- `tsconfig.json` — TypeScript configuration
- `package.json` — Dependencies and scripts

## Features
- **Multiple interfaces**: Terminal, Telegram, Teams
- **MCP client support** for external tool servers
- **Session management** with compaction
- **Full tool suite**: file operations, search, bash execution, web access, browser automation, transcription, sub-agents
- **Skills system**: Slash-command invocable specialist prompts (Angular, React, Python, C#, etc.)
- **Gateway architecture**: Multi-process with IPC protocol
- **Streaming execution**: Real-time response streaming

## Tech Stack
- **Language**: TypeScript
- **Runtime**: Node.js
- **Build output**: `dist/` folder (bundled JS via esbuild)
