# Contributing to CodingAgent

Thank you for your interest in contributing! Here's how to get started.

## Development Setup

```bash
# Clone the repo
git clone https://github.com/agenticaiengineer/codingagent.git
cd codingagent

# Install dependencies
npm install

# Run in development mode
npm run dev
```

## Project Structure

| Folder | Purpose |
|---|---|
| `src/core/` | Agent loop, client, context, streaming executor, compaction |
| `src/tools/` | Tool implementations (Read, Write, Edit, Glob, Grep, Bash, etc.) |
| `src/session/` | Session management |
| `src/gateway/` | Gateway & agent worker (multi-process IPC) |
| `src/ports/` | I/O adapters (Terminal, Telegram, Teams) |
| `src/ui/` | UI rendering and markdown |
| `src/config/` | Configuration and skills |
| `src/eval/` | Evaluation framework |
| `publish/` | Build & publish scripts |
| `tests/` | Integration tests |

## Making Changes

1. **Fork** the repository
2. **Create a branch** for your change: `git checkout -b my-feature`
3. **Read before editing** — always read a file before modifying it
4. **Test your changes**: `npm test`
5. **Submit a pull request** with a clear description

## Code Style

- TypeScript with strict mode
- ESM modules (`"type": "module"`)
- No default exports — use named exports
- Document public functions with JSDoc comments
- Keep functions focused and small

## Running Tests

```bash
# Full test suite (builds + runs)
npm test

# Agent behavior tests only
npm run test:agent

# Integration tests only
npm run test:integration

# All test suites
npm run test:all
```

## Reporting Issues

- Use the [GitHub issue tracker](https://github.com/agenticaiengineer/codingagent/issues)
- Include steps to reproduce, expected behavior, and actual behavior
- Include your Node.js version and OS

## Pull Request Guidelines

- Keep PRs focused on a single change
- Include tests for new functionality
- Update documentation if needed
- Ensure `npm test` passes

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
