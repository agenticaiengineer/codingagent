/**
 * Command registry — single source of truth for all REPL slash commands.
 *
 * Commands register themselves here so that help text, tab-completion,
 * inline hints, and CLI --help output are always in sync with the actual
 * command implementations in index.ts. Adding a new `case "/foo":` in
 * handleCommand without a corresponding `registerCommand()` call will
 * be caught by the runtime validation check at startup.
 *
 * This module is intentionally dependency-free (no imports from index.ts
 * or ui.ts) to avoid circular dependencies.
 */

/** Metadata for a registered REPL command. */
export interface CommandEntry {
  /** The command with optional argument placeholders, e.g. "/model <name>" */
  command: string;
  /** Human-readable description shown in /help and inline hints. */
  description: string;
  /** Alternative command names (e.g., "/exit" is an alias for "/quit"). */
  aliases?: string[];
}

/**
 * Mutable command registry. Commands are registered at module load time
 * via `registerCommand()` and consumed by ui.ts for tab-completion,
 * inline hints, help rendering, etc.
 *
 * Order matters — commands are displayed in registration order in /help.
 */
const registry: CommandEntry[] = [];

/**
 * Dynamic skill commands discovered at runtime from SKILL.md files.
 * Kept separate from `registry` so they can be replaced wholesale on
 * `/reload` without affecting the built-in command list, and so that
 * `renderHelp()` can display them in a distinct "Skills" section.
 */
const skillRegistry: CommandEntry[] = [];

/**
 * Register a REPL command. Call this for every slash command that should
 * appear in /help, tab-completion, and inline hints.
 *
 * @param entry - Command metadata (name, description, optional aliases)
 *
 * @example
 * ```ts
 * registerCommand({ command: "/cache", description: "Show explore cache statistics" });
 * registerCommand({ command: "/quit", description: "Exit the REPL", aliases: ["/exit"] });
 * ```
 */
export function registerCommand(entry: CommandEntry): void {
  registry.push(entry);
}

/**
 * Get all registered commands (read-only snapshot).
 * Used by ui.ts for help display, tab-completion, and inline hints.
 */
export function getRegisteredCommands(): readonly CommandEntry[] {
  return registry;
}

/**
 * Get registered skill commands (read-only snapshot).
 * Used by ui.ts to render skills in a separate section in /help and
 * to visually distinguish them in inline hints.
 */
export function getRegisteredSkills(): readonly CommandEntry[] {
  return skillRegistry;
}

/**
 * Replace the dynamic skill commands. Called by index.ts after loading
 * skills from disk. Clears the previous set so `/reload` picks up
 * renamed/deleted skills.
 */
export function registerSkillCommands(entries: CommandEntry[]): void {
  skillRegistry.length = 0;
  skillRegistry.push(...entries);
}

/**
 * Clear all dynamic skill commands. Called on `/clear` before the
 * skill cache is reset.
 */
export function clearSkillCommands(): void {
  skillRegistry.length = 0;
}

/**
 * Get all command names (base command only, no argument placeholders)
 * including aliases. Used for tab-completion.
 *
 * @example
 * // For { command: "/resume [id|#]", aliases: ["/exit"] }
 * // Returns: ["/resume", "/exit"]
 */
export function getAllCommandNames(): readonly string[] {
  const names: string[] = [];
  for (const entry of registry) {
    names.push(entry.command.split(" ")[0]);
    if (entry.aliases) {
      names.push(...entry.aliases);
    }
  }
  for (const entry of skillRegistry) {
    names.push(entry.command.split(" ")[0]);
  }
  return names;
}

/**
 * Validate that all expected command names are registered.
 * Call this at startup (after all registerCommand calls) to catch
 * missing registrations early.
 *
 * @param expectedCommands - Base command names (e.g., ["/cache", "/model"])
 *                           that should be in the registry.
 * @returns Array of command names that are missing from the registry.
 */
export function findUnregisteredCommands(expectedCommands: string[]): string[] {
  const registered = new Set(getAllCommandNames());
  return expectedCommands.filter((cmd) => !registered.has(cmd));
}

// ── Argument Provider Registry ───────────────────────────────────────────────

/**
 * A suggested argument value for a command.
 * Displayed in the hint menu when the user types a command + space.
 */
export interface ArgumentSuggestion {
  /** The argument value (e.g., "claude-sonnet-4-20250514"). */
  value: string;
  /** Optional description shown alongside the value. */
  description?: string;
}

/**
 * A function that returns argument suggestions for a command.
 * Called lazily when the user types a command + space.
 */
export type ArgumentProvider = () => ArgumentSuggestion[];

/** Registry of argument providers keyed by lowercase command name. */
const argumentProviders = new Map<string, ArgumentProvider>();

/**
 * Register an argument provider for a command.
 * The provider is called when the user types the command followed by a space.
 *
 * @param command - The command name (e.g., "/model")
 * @param provider - Function returning argument suggestions
 */
export function registerArgumentProvider(command: string, provider: ArgumentProvider): void {
  argumentProviders.set(command.toLowerCase(), provider);
}

/**
 * Get the argument provider for a command, if one is registered.
 */
export function getArgumentProvider(command: string): ArgumentProvider | undefined {
  return argumentProviders.get(command.toLowerCase());
}
