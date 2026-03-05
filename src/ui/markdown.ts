/**
 * Terminal Markdown Renderer — renders Markdown as styled ANSI text
 * for rich console output.
 *
 * Uses `marked` for parsing and `marked-terminal` for terminal-aware
 * rendering with syntax highlighting, colored headings, tables, etc.
 *
 * **Mermaid diagram support:**
 * When a ` ```mermaid ` code block is detected, the renderer opens
 * the diagram in the Mermaid Live Editor (https://mermaid.live) by
 * encoding the source into the URL. This provides a full-featured
 * editor with pan/zoom, export to SVG/PNG, and theme switching.
 * The terminal shows the raw Mermaid source as a styled code block.
 *
 * Opt out of auto-opening the browser via `MERMAID_NO_BROWSER=1`.
 *
 * The renderer is configured once at module load time and reused for
 * every call. It respects the NO_COLOR environment variable and
 * degrades to plain text on non-TTY outputs.
 *
 * @module markdown
 */

import { Marked } from "marked";
import { markedTerminal } from "marked-terminal";
import { deflateSync } from "zlib";
import { spawn } from "child_process";

// ── Detect color support ─────────────────────────────────────────────────────

const colorsDisabled: boolean =
  "NO_COLOR" in process.env ||
  process.env.TERM === "dumb" ||
  !process.stdout.isTTY;

// ── ANSI helpers (local to avoid circular deps with ui.ts) ───────────────────

function ansi(open: string, close: string, text: string): string {
  if (colorsDisabled) return text;
  return `\x1b[${open}m${text}\x1b[${close}m`;
}

const bold = (t: string) => ansi("1", "22", t);
const dim = (t: string) => ansi("2", "22", t);
const italic = (t: string) => ansi("3", "23", t);
const cyan = (t: string) => ansi("36", "39", t);

const white = (t: string) => ansi("37", "39", t);
const bgGray = (t: string) => ansi("100", "49", t);

// ── Mermaid Live Editor Integration ─────────────────────────────────────────

/**
 * Whether to auto-open Mermaid diagrams in the browser.
 * Disabled by setting MERMAID_NO_BROWSER=1.
 */
const mermaidBrowserDisabled: boolean =
  process.env.MERMAID_NO_BROWSER === "1" ||
  process.env.MERMAID_NO_BROWSER === "true";

/**
 * Encode a Mermaid diagram source into a mermaid.live URL.
 *
 * Uses the same encoding as the Mermaid Live Editor:
 *   1. Build a JSON state object with the diagram code + config
 *   2. JSON.stringify → UTF-8 bytes → zlib deflate (level 9)
 *   3. URL-safe base64 encode the compressed bytes
 *   4. Construct URL: https://mermaid.live/edit#pako:{encoded}
 *
 * This approach uses only Node.js built-in modules (zlib, Buffer) —
 * no external dependencies like `pako` or `js-base64` needed.
 *
 * @param mermaidSource - Raw Mermaid diagram source
 * @returns Full mermaid.live editor URL
 */
function buildMermaidLiveUrl(mermaidSource: string): string {
  const state = {
    code: mermaidSource,
    mermaid: JSON.stringify({ theme: "default" }),
    autoSync: true,
    rough: false,
    updateDiagram: true,
  };

  const json = JSON.stringify(state);
  const compressed = deflateSync(Buffer.from(json, "utf-8"), { level: 9 });

  // URL-safe base64: replace +→-, /→_, strip trailing =
  const encoded = compressed
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return `https://mermaid.live/edit#pako:${encoded}`;
}

/**
 * Open a Mermaid diagram in the Mermaid Live Editor (https://mermaid.live).
 *
 * The diagram source is encoded directly into the URL, so no temp files
 * are needed. The live editor provides full rendering, pan/zoom,
 * theme switching, and proper SVG/PNG export.
 *
 * @param mermaidSource - Raw Mermaid diagram source (without ```mermaid fences)
 */
function openMermaidInBrowser(mermaidSource: string): void {
  if (mermaidBrowserDisabled || colorsDisabled) return;

  try {
    const url = buildMermaidLiveUrl(mermaidSource);

    const cmd =
      process.platform === "win32"
        ? "start"
        : process.platform === "darwin"
          ? "open"
          : "xdg-open";

    // On Windows, `start` interprets `&` in URLs — wrap in quotes and
    // provide an empty title argument so the URL isn't parsed as a window title.
    const args =
      process.platform === "win32" ? ['""', url] : [url];

    const proc = spawn(cmd, args, {
      detached: true,
      shell: process.platform === "win32",
      stdio: "ignore",
    });
    proc.unref();
  } catch {
    // Silently fail — the terminal source display is the primary output
  }
}

// ── Mermaid Pre-Processing ──────────────────────────────────────────────────

/**
 * Regex to match fenced mermaid code blocks.
 * Captures the mermaid source between the fences.
 */
const MERMAID_FENCE_RE = /```mermaid\s*\n([\s\S]*?)```/g;

/**
 * Pre-process markdown text to detect Mermaid diagrams and open them
 * in the Mermaid Live Editor.
 *
 * The mermaid code block is preserved as-is in the markdown so that
 * marked-terminal renders it as a styled code block in the terminal.
 * The browser is opened as a side-effect for the full interactive view.
 *
 * @param text - Raw markdown text potentially containing mermaid blocks
 * @returns Text with mermaid info note appended, and whether mermaid was found
 */
function preprocessMermaid(text: string): { processed: string; hasMermaid: boolean } {
  let hasMermaid = false;

  const processed = text.replace(MERMAID_FENCE_RE, (_match, source: string) => {
    hasMermaid = true;
    const trimmedSource = source.trim();

    // Open in Mermaid Live Editor (fire-and-forget)
    openMermaidInBrowser(trimmedSource);

    // Keep the mermaid source as a regular code block for terminal display,
    // and append a note about the browser view.
    const browserNote = mermaidBrowserDisabled
      ? ""
      : `\n\n> 📊 _Diagram opened in [mermaid.live](https://mermaid.live) — edit, zoom, and export SVG/PNG there._`;

    return `\`\`\`mermaid\n${trimmedSource}\n\`\`\`${browserNote}`;
  });

  return { processed, hasMermaid };
}

// ── Configure marked + marked-terminal ───────────────────────────────────────

/**
 * A dedicated Marked instance with terminal rendering configured.
 *
 * Using a dedicated instance (vs the global `marked`) avoids conflicts
 * if other code imports `marked` for HTML rendering.
 */
const terminalMarked = new Marked();

if (!colorsDisabled) {
  terminalMarked.use(
    markedTerminal({
      // Headings: bold + cyan
      heading: (text: string) => `\n${bold(cyan(text))}\n`,
      // Bold
      strong: bold,
      // Italic/emphasis
      em: italic,
      // Inline code: highlighted background
      codespan: (code: string) => bgGray(white(` ${code} `)),
      // Block quotes: dim with bar
      blockquote: (text: string) => {
        const lines = text.split("\n").map((l) => `  ${dim("│")} ${dim(l)}`);
        return `\n${lines.join("\n")}\n`;
      },
      // Horizontal rules
      hr: () => dim("─".repeat(Math.min(process.stdout.columns || 60, 60))),
      // Links: show URL in parens
      link: (href: string, _title: string, text: string) =>
        `${cyan(text)} ${dim(`(${href})`)}`,
      // List items (bullet)
      listitem: (text: string) => `  ${dim("•")} ${text}`,
      // Tables: use Unicode box-drawing
      tableOptions: {
        chars: {
          top: "─",
          "top-mid": "┬",
          "top-left": "┌",
          "top-right": "┐",
          bottom: "─",
          "bottom-mid": "┴",
          "bottom-left": "└",
          "bottom-right": "┘",
          left: "│",
          "left-mid": "├",
          mid: "─",
          "mid-mid": "┼",
          right: "│",
          "right-mid": "┤",
          middle: "│",
        },
      },
      // Width for word wrapping (0 = no wrapping, use terminal width)
      width: Math.min(process.stdout.columns || 80, 100),
      // Don't show images (terminal can't render them)
      showSectionPrefix: false,
      // Reflection marks for emphasis
      reflowText: true,
      // Tab size for code blocks
      tab: 2,
    }) as any, // marked-terminal types don't perfectly match marked's extension type
  );
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Render a Markdown string as ANSI-styled terminal text.
 *
 * - When colors are enabled: full Markdown rendering with styled headings,
 *   bold/italic, code blocks with highlighting, tables, lists, etc.
 * - When colors are disabled (NO_COLOR, non-TTY): returns the raw text
 *   unchanged (Markdown is already readable as plain text).
 * - Mermaid code blocks are opened in the Mermaid Live Editor
 *   (https://mermaid.live) and displayed as source in the terminal.
 *
 * Trailing whitespace and newlines are trimmed to prevent extra blank
 * lines when the output is logged via `output.log()`.
 *
 * @param text - Raw Markdown text from the assistant
 * @returns ANSI-styled string ready for terminal output
 */
export function renderMarkdown(text: string): string {
  if (!text || colorsDisabled) return text;

  try {
    // Pre-process mermaid blocks: opens diagram in mermaid.live browser
    // and preserves the source as a code block for terminal display.
    const { processed } = preprocessMermaid(text);

    // marked.parse() with marked-terminal returns a string (not HTML)
    const rendered = terminalMarked.parse(processed) as string;
    // Trim trailing whitespace/newlines that marked-terminal tends to add
    return rendered.trimEnd();
  } catch {
    // If rendering fails for any reason, return the raw text
    return text;
  }
}

/**
 * Check if markdown rendering is active (colors enabled + TTY).
 */
export function isMarkdownEnabled(): boolean {
  return !colorsDisabled;
}
