# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT** open a public GitHub issue
2. Email the maintainers or use [GitHub Security Advisories](https://github.com/agenticaiengineer/codingagent/security/advisories/new)
3. Include a description of the vulnerability and steps to reproduce

We will acknowledge your report within 48 hours and aim to release a fix within 7 days for critical issues.

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest  | ✅ |
| Older   | ❌ |

## Known Security Considerations

### API Keys

- Never commit API keys to the repository
- Use environment variables, `~/.claude/settings.json`, or `.env` files
- `.env` files are gitignored by default

### Browser Tool

- The built-in browser tool includes SSRF protection (`src/tools/browser-ssrf.ts`)
- Private/internal IP ranges and cloud metadata endpoints are blocked by default
- Allowed internal hosts can be configured if needed

### Microsoft Teams Integration

- The Teams bot port (`src/ports/teams-port.ts`) does **not** implement full JWT verification of incoming Bot Framework requests
- Tenant ID filtering is implemented but is not a substitute for proper authentication
- **Do not expose the Teams port to the public internet** without implementing Bot Framework JWT validation

### Bash Tool

- The Bash tool executes arbitrary shell commands as requested by the LLM
- It runs with the same permissions as the user running the agent
- Use with caution in production/shared environments

### Sub-Agents

- Sub-agents inherit the parent agent's permissions and tool access
- Background agents are limited to 10 concurrent instances
- Agent output is capped at 1 MB per agent

## Best Practices

- Run the agent with minimal necessary permissions
- Use `TEAMS_ALLOWED_TENANTS` to restrict Teams access to specific tenants
- Use `TELEGRAM_ALLOWED_CHAT_IDS` to restrict Telegram access
- Review the agent's actions in the conversation before deploying changes
