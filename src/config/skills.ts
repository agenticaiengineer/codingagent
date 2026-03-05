/**
 * Skills & Memory System
 *
 * Implements a unified project memory and skill system that reads
 * instruction/memory files from Claude Code, GitHub Copilot, OpenAI Codex,
 * and Claude Desktop configuration locations.
 *
 * Memory hierarchy (loaded at startup, most specific wins):
 *
 * Claude Code:
 *   1. `~/.claude/CLAUDE.md`                — User memory (all projects)
 *   2. `./CLAUDE.md` or `.claude/CLAUDE.md` — Project memory (team)
 *   3. `./CLAUDE.local.md`                  — Local project memory (personal)
 *   4. `.claude/rules/*.md`                 — Modular project rules
 *
 * GitHub Copilot:
 *   5. `.github/copilot-instructions.md`    — Copilot repo-wide instructions
 *   6. `.github/instructions/*.instructions.md` — Path-scoped Copilot instructions
 *
 * OpenAI Codex:
 *   7. `~/.codex/AGENTS.md`                 — Personal global Codex guidance
 *   8. `./AGENTS.md`                        — Repo root agent instructions
 *   9. `./AGENTS.md` in cwd                 — Sub-folder agent specifics
 *
 * Google Gemini:
 *   10. `./GEMINI.md`                       — Gemini agent instructions
 *
 * Skill files:
 *   - `~/.claude/skills/`                   — Personal skills (always loaded)
 *   - `.claude/skills/`                     — Project skills (always loaded)
 *   - Additional directories via `skillDirs` in settings.json
 *   - `.github/prompts/*.prompt.md`         — Copilot prompt files (as skills)
 *   - Each SKILL.md has YAML frontmatter + markdown instructions
 *
 * MCP config locations read by mcp-client.ts:
 *   - `.mcp.json`                           — Claude Code / codingagent project MCP
 *   - `~/.claude.json`                      — Claude Code user MCP
 *   - `.vscode/mcp.json`                    — VS Code / Copilot MCP
 *   - `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
 *   - `%APPDATA%\Claude\claude_desktop_config.json` (Windows) — Claude Desktop MCP
 *
 * Features:
 *   - Hierarchical memory loading with precedence
 *   - Path-scoped rules (via YAML frontmatter `paths:` / `applyTo:` field)
 *   - Skill discovery and slash-command registration
 *   - `$ARGUMENTS` substitution in skill templates
 *   - Import support via `@path/to/file` references in CLAUDE.md
 */

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, resolve, relative, dirname, isAbsolute } from "path";
import { homedir } from "os";
import { hasErrnoCode } from "../tools/validate.js";
import { getConfig } from "./config.js";

// ── Types ──

export interface MemoryEntry {
  source: string;
  content: string;
  /** For path-scoped rules, the glob patterns that activate this rule. */
  pathScopes?: string[];
  priority: number;
}

export interface SkillDefinition {
  name: string;
  description: string;
  instructions: string;
  /** Source file path */
  source: string;
  /** Disable automatic invocation by the model */
  disableModelInvocation: boolean;
  /** Whether the user can invoke this via `/skill-name` */
  userInvocable: boolean;
  /** Tools the skill is allowed to use without prompting */
  allowedTools?: string[];
  /** Run in an isolated sub-agent context */
  context?: "fork" | "inline";
  /** Sub-agent type when context is "fork" */
  agent?: string;
}

interface SkillFrontmatter {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
  "user-invocable"?: boolean;
  "allowed-tools"?: string | string[];
  context?: "fork" | "inline";
  agent?: string;
  paths?: string[];
  [key: string]: unknown;
}

// ── Module State ──

let cachedMemory: MemoryEntry[] | null = null;
let cachedSkills: Map<string, SkillDefinition> | null = null;
let cachedProjectDir: string | null = null;

// ── YAML Frontmatter Parser (minimal) ──

/**
 * Parse simple YAML frontmatter from a markdown file.
 * Handles the common subset used by SKILL.md and path-scoped rules:
 *   - Simple key: value pairs
 *   - Boolean values (true/false)
 *   - Array values (both `[a, b]` and `- item` syntax)
 *   - Quoted strings
 *
 * Returns null if no frontmatter is found (no `---` delimiter).
 */
function parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } | null {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return null;

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      endIdx = i;
      break;
    }
  }
  if (endIdx === -1) return null;

  const yamlLines = lines.slice(1, endIdx);
  const body = lines.slice(endIdx + 1).join("\n").trim();
  const frontmatter: SkillFrontmatter = {};

  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of yamlLines) {
    // Detect array items: `  - value`
    const arrayItemMatch = line.match(/^\s+-\s+(.+)/);
    if (arrayItemMatch && currentKey && currentArray) {
      currentArray.push(arrayItemMatch[1].trim().replace(/^["']|["']$/g, ""));
      continue;
    }

    // Flush previous array
    if (currentKey && currentArray) {
      frontmatter[currentKey] = currentArray;
      currentKey = null;
      currentArray = null;
    }

    // Key: value pairs
    const kvMatch = line.match(/^([a-zA-Z][\w-]*)\s*:\s*(.*)/);
    if (!kvMatch) continue;

    const key = kvMatch[1];
    let value = kvMatch[2].trim();

    // Empty value → start of array
    if (!value) {
      currentKey = key;
      currentArray = [];
      continue;
    }

    // Boolean
    if (value === "true") { frontmatter[key] = true; continue; }
    if (value === "false") { frontmatter[key] = false; continue; }

    // Inline array: [a, b, c]
    if (value.startsWith("[") && value.endsWith("]")) {
      frontmatter[key] = value.slice(1, -1).split(",").map(s => s.trim().replace(/^["']|["']$/g, ""));
      continue;
    }

    // Quoted string
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    frontmatter[key] = value;
  }

  // Flush last array
  if (currentKey && currentArray) {
    frontmatter[currentKey] = currentArray;
  }

  return { frontmatter, body };
}

// ── Import Resolution ──

/**
 * Resolve `@path/to/file` import references in CLAUDE.md content.
 * Supports up to 5 levels of nesting to prevent circular references.
 * Imported file content replaces the `@path` line in-place.
 */
function resolveImports(content: string, baseDir: string, depth = 0): string {
  if (depth >= 5) return content;

  return content.replace(/^@(.+)$/gm, (_match, importPath: string) => {
    const trimmed = importPath.trim();
    const fullPath = resolve(baseDir, trimmed);

    try {
      const imported = readFileSync(fullPath, "utf-8");
      // Recursively resolve imports in the imported file
      return resolveImports(imported, dirname(fullPath), depth + 1);
    } catch (err: unknown) {
      if (hasErrnoCode(err) && (err as { code: string }).code === "ENOENT") {
        return `[Import not found: ${trimmed}]`;
      }
      return `[Import error: ${trimmed}]`;
    }
  });
}

// ── Memory Loading ──

/**
 * Try to read a file, returning null if it doesn't exist.
 */
function tryReadFile(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Load all memory files (CLAUDE.md hierarchy) for the given project directory.
 * Returns entries in priority order (lowest → highest).
 */
function loadMemoryEntries(cwd: string): MemoryEntry[] {
  const entries: MemoryEntry[] = [];

  // 1. User memory: ~/.claude/CLAUDE.md (lowest priority)
  try {
    const userMemoryPath = join(homedir(), ".claude", "CLAUDE.md");
    const content = tryReadFile(userMemoryPath);
    if (content) {
      entries.push({
        source: userMemoryPath,
        content: resolveImports(content, dirname(userMemoryPath)),
        priority: 10,
      });
    }
  } catch { /* homedir() may throw */ }

  // 2. Project memory: ./CLAUDE.md or .claude/CLAUDE.md
  const projectMdPath = join(cwd, "CLAUDE.md");
  const projectMdAltPath = join(cwd, ".claude", "CLAUDE.md");
  const projectContent = tryReadFile(projectMdPath) ?? tryReadFile(projectMdAltPath);
  if (projectContent) {
    const sourcePath = existsSync(projectMdPath) ? projectMdPath : projectMdAltPath;
    entries.push({
      source: sourcePath,
      content: resolveImports(projectContent, dirname(sourcePath)),
      priority: 20,
    });
  }

  // 3. Modular rules: .claude/rules/*.md
  const rulesDir = join(cwd, ".claude", "rules");
  try {
    const ruleFiles = collectMarkdownFiles(rulesDir);
    for (const rulePath of ruleFiles) {
      const ruleContent = tryReadFile(rulePath);
      if (!ruleContent) continue;

      const parsed = parseFrontmatter(ruleContent);
      const entry: MemoryEntry = {
        source: rulePath,
        content: parsed ? parsed.body : ruleContent,
        priority: 25,
      };

      // Path-scoped rules
      if (parsed?.frontmatter.paths && Array.isArray(parsed.frontmatter.paths)) {
        entry.pathScopes = parsed.frontmatter.paths;
      }

      entries.push(entry);
    }
  } catch { /* rules dir may not exist */ }

  // 4. Local project memory: ./CLAUDE.local.md (highest priority, personal)
  const localMdPath = join(cwd, "CLAUDE.local.md");
  const localContent = tryReadFile(localMdPath);
  if (localContent) {
    entries.push({
      source: localMdPath,
      content: resolveImports(localContent, cwd),
      priority: 30,
    });
  }

  // ── GitHub Copilot instructions ──

  // 5. .github/copilot-instructions.md — repo-wide Copilot instructions
  const copilotInstrPath = join(cwd, ".github", "copilot-instructions.md");
  const copilotInstr = tryReadFile(copilotInstrPath);
  if (copilotInstr) {
    entries.push({
      source: copilotInstrPath,
      content: copilotInstr,
      priority: 20, // Same priority as project CLAUDE.md
    });
  }

  // 6. .github/instructions/*.instructions.md — path-scoped Copilot instructions
  const copilotInstrDir = join(cwd, ".github", "instructions");
  try {
    const instrFiles = collectInstructionFiles(copilotInstrDir);
    for (const instrPath of instrFiles) {
      const instrContent = tryReadFile(instrPath);
      if (!instrContent) continue;

      const parsed = parseFrontmatter(instrContent);
      const entry: MemoryEntry = {
        source: instrPath,
        content: parsed ? parsed.body : instrContent,
        priority: 25,
      };

      // Copilot uses `applyTo:` for path scoping (equivalent to Claude's `paths:`)
      if (parsed?.frontmatter.applyTo) {
        const applyTo = parsed.frontmatter.applyTo;
        if (typeof applyTo === "string") {
          entry.pathScopes = applyTo.split(",").map(s => s.trim());
        } else if (Array.isArray(applyTo)) {
          entry.pathScopes = applyTo;
        }
      }

      entries.push(entry);
    }
  } catch { /* instructions dir may not exist */ }

  // ── OpenAI Codex AGENTS.md ──

  // 7. ~/.codex/AGENTS.md — personal global Codex guidance
  try {
    const codexGlobalAgents = join(homedir(), ".codex", "AGENTS.md");
    const codexGlobalContent = tryReadFile(codexGlobalAgents);
    if (codexGlobalContent) {
      entries.push({
        source: codexGlobalAgents,
        content: codexGlobalContent,
        priority: 10, // Same as user-level CLAUDE.md
      });
    }
  } catch { /* homedir() may throw */ }

  // 8. ./AGENTS.md — repo root agent instructions
  const agentsMdPath = join(cwd, "AGENTS.md");
  const agentsMdContent = tryReadFile(agentsMdPath);
  if (agentsMdContent) {
    entries.push({
      source: agentsMdPath,
      content: agentsMdContent,
      priority: 20, // Same as project CLAUDE.md
    });
  }

  // ── Google Gemini ──

  // 9. ./GEMINI.md — Gemini agent instructions
  const geminiMdPath = join(cwd, "GEMINI.md");
  const geminiContent = tryReadFile(geminiMdPath);
  if (geminiContent) {
    entries.push({
      source: geminiMdPath,
      content: geminiContent,
      priority: 20,
    });
  }

  return entries;
}

/**
 * Recursively collect `.md` files from a directory.
 */
function collectMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectMarkdownFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(fullPath);
      }
    }
  } catch { /* directory may not exist */ }
  return files;
}

/**
 * Recursively collect `.instructions.md` files from a directory.
 * Used for Copilot's path-scoped instruction files in `.github/instructions/`.
 */
function collectInstructionFiles(dir: string): string[] {
  const files: string[] = [];
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...collectInstructionFiles(fullPath));
      } else if (entry.isFile() && entry.name.endsWith(".instructions.md")) {
        files.push(fullPath);
      }
    }
  } catch { /* directory may not exist */ }
  return files;
}

// ── Skill Loading ──

/**
 * Expand a directory path that may contain `~` (home directory) or be
 * relative. Absolute paths are returned as-is; `~` is expanded to the
 * user's home directory; relative paths are resolved against `cwd`.
 */
function resolveSkillDir(dir: string, cwd: string): string {
  if (dir.startsWith("~/") || dir.startsWith("~\\") || dir === "~") {
    try {
      return join(homedir(), dir.slice(dir === "~" ? 1 : 2));
    } catch {
      // homedir() can throw in containerized environments — return
      // the path as-is and let the directory-read fail gracefully.
      return dir;
    }
  }
  if (isAbsolute(dir)) return dir;
  return resolve(cwd, dir);
}

/**
 * Load skill definitions from the built-in default directories and any
 * additional directories configured via `skillDirs` in settings.json.
 *
 * Built-in directories (always loaded, in this order):
 *   1. `~/.claude/skills`  — User-level personal skills
 *   2. `.claude/skills`    — Project-level team skills (relative to cwd)
 *
 * Then any extra directories from `config.skillDirs` are loaded on top.
 *
 * Later directories take precedence when skill names collide, so:
 *   project skills override user skills, and configured extras override both.
 */
function loadSkillDefinitions(cwd: string): Map<string, SkillDefinition> {
  const skills = new Map<string, SkillDefinition>();

  // 1. Built-in: user-level skills (~/.claude/skills)
  try {
    const userSkillsDir = join(homedir(), ".claude", "skills");
    loadSkillsFromDir(userSkillsDir, skills);
  } catch { /* homedir() may throw */ }

  // 2. Built-in: project-level skills (.claude/skills)
  const projectSkillsDir = join(cwd, ".claude", "skills");
  loadSkillsFromDir(projectSkillsDir, skills);

  // 3. Additional directories from config (takes highest precedence)
  const config = getConfig();
  for (const dir of config.skillDirs) {
    const resolvedDir = resolveSkillDir(dir, cwd);
    loadSkillsFromDir(resolvedDir, skills);
  }

  return skills;
}

/**
 * Load SKILL.md files from a directory into the skills map.
 */
function loadSkillsFromDir(dir: string, skills: Map<string, SkillDefinition>): void {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        // Check for SKILL.md inside subdirectory
        const skillFile = join(fullPath, "SKILL.md");
        loadSkillFile(skillFile, skills);
      } else if (entry.isFile() && entry.name.toUpperCase() === "SKILL.MD") {
        loadSkillFile(fullPath, skills);
      }
    }
  } catch { /* directory may not exist */ }
}

/**
 * Parse a single SKILL.md file and add it to the skills map.
 */
function loadSkillFile(path: string, skills: Map<string, SkillDefinition>): void {
  const content = tryReadFile(path);
  if (!content) return;

  const parsed = parseFrontmatter(content);
  if (!parsed) {
    // No frontmatter — treat the entire file as the skill instructions
    // Use the parent directory name as the skill name
    const dirName = dirname(path).split(/[\\/]/).pop() ?? "unknown-skill";
    skills.set(dirName, {
      name: dirName,
      description: `Skill from ${relative(process.cwd(), path)}`,
      instructions: content,
      source: path,
      disableModelInvocation: false,
      userInvocable: true,
    });
    return;
  }

  const fm = parsed.frontmatter;
  const name = (fm.name as string) ?? dirname(path).split(/[\\/]/).pop() ?? "unknown-skill";

  // Parse allowed-tools: can be a string ("Read, Grep, Bash(git *)") or array
  let allowedTools: string[] | undefined;
  if (fm["allowed-tools"]) {
    if (Array.isArray(fm["allowed-tools"])) {
      allowedTools = fm["allowed-tools"];
    } else if (typeof fm["allowed-tools"] === "string") {
      allowedTools = fm["allowed-tools"].split(",").map(s => s.trim());
    }
  }

  skills.set(name, {
    name,
    description: (fm.description as string) ?? `Skill: ${name}`,
    instructions: parsed.body,
    source: path,
    disableModelInvocation: fm["disable-model-invocation"] === true,
    userInvocable: fm["user-invocable"] !== false,
    allowedTools,
    context: fm.context as "fork" | "inline" | undefined,
    agent: fm.agent as string | undefined,
  });
}

// ── Argument Substitution ──

/**
 * Substitute `$ARGUMENTS`, `$ARGUMENTS[0]`, `$0`, etc. in skill instructions.
 */
export function substituteArguments(template: string, args: string): string {
  const argParts = args.trim().split(/\s+/);

  let result = template;
  // $ARGUMENTS — the full argument string
  result = result.replace(/\$ARGUMENTS/g, args);
  // $ARGUMENTS[N] — individual argument by index
  result = result.replace(/\$ARGUMENTS\[(\d+)\]/g, (_m, idx: string) => {
    return argParts[parseInt(idx, 10)] ?? "";
  });
  // $N — shorthand for $ARGUMENTS[N]
  result = result.replace(/\$(\d+)/g, (_m, idx: string) => {
    return argParts[parseInt(idx, 10)] ?? "";
  });

  return result;
}

// ── Public API ──

/**
 * Load project memory (CLAUDE.md files) and return a combined context string
 * suitable for inclusion in the system prompt.
 *
 * Results are cached per project directory. Call `resetMemoryCache()` on
 * `/clear` or `/reload` to force re-reading from disk.
 */
export function loadProjectMemory(cwd: string): string {
  if (cachedMemory && cachedProjectDir === cwd) {
    // Use cached version
  } else {
    cachedMemory = loadMemoryEntries(cwd);
    cachedProjectDir = cwd;
  }

  if (cachedMemory.length === 0) return "";

  // Sort by priority (lowest first → higher priority entries appear later
  // in the prompt, giving them implicit precedence for the model)
  const sorted = [...cachedMemory].sort((a, b) => a.priority - b.priority);

  const sections: string[] = [];
  for (const entry of sorted) {
    const relativeSrc = relative(cwd, entry.source);
    const header = `[Memory: ${relativeSrc}]`;
    let body = entry.content.trim();

    // Truncate individual entries to prevent a massive CLAUDE.md from
    // consuming the entire context window
    const MAX_ENTRY_CHARS = 10_000;
    if (body.length > MAX_ENTRY_CHARS) {
      body = body.slice(0, MAX_ENTRY_CHARS) + "\n\n[... truncated — original was " + body.length.toLocaleString() + " chars]";
    }

    if (entry.pathScopes) {
      sections.push(`${header} (applies to: ${entry.pathScopes.join(", ")})\n${body}`);
    } else {
      sections.push(`${header}\n${body}`);
    }
  }

  return "\n\n" + sections.join("\n\n") + "\n";
}

/**
 * Load skill definitions and return them indexed by name.
 * Results are cached per project directory.
 */
export function loadSkills(cwd: string): ReadonlyMap<string, SkillDefinition> {
  if (cachedSkills && cachedProjectDir === cwd) {
    return cachedSkills;
  }

  cachedSkills = loadSkillDefinitions(cwd);
  cachedProjectDir = cwd;
  return cachedSkills;
}

/**
 * Get a specific skill by name.
 */
export function getSkill(cwd: string, name: string): SkillDefinition | undefined {
  const skills = loadSkills(cwd);
  return skills.get(name);
}

/**
 * Get all user-invocable skills (for slash-command registration).
 */
export function getInvocableSkills(cwd: string): SkillDefinition[] {
  const skills = loadSkills(cwd);
  return Array.from(skills.values()).filter(s => s.userInvocable);
}

/**
 * Build a skill description for the system prompt (model-invocable skills).
 */
export function getSkillDescriptions(cwd: string): string {
  const skills = loadSkills(cwd);
  const modelSkills = Array.from(skills.values()).filter(s => !s.disableModelInvocation);

  if (modelSkills.length === 0) return "";

  const lines = modelSkills.map(s => `- /${s.name}: ${s.description}`);
  return `\n\nAvailable skills (can be invoked via slash commands):\n${lines.join("\n")}\n`;
}

/**
 * Reset the memory and skills cache. Called on /clear, /reload, /resume.
 */
export function resetMemoryCache(): void {
  cachedMemory = null;
  cachedSkills = null;
  cachedProjectDir = null;
}
