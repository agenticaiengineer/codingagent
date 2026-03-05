import { spawn } from "child_process";
import type { Tool, ToolInput, ToolContext, ToolResult } from "../core/types.js";
import { requireString, optionalString, ToolInputError } from "./validate.js";

/**
 * Mapping of well-known application aliases to the commands used to launch them
 * on each platform. The `args` function receives the optional `path` parameter
 * and returns the argument list for the command.
 *
 * `"default"` is the fallback used by `xdg-open` (Linux), `open` (macOS), or
 * `start` (Windows) to open a file/folder with the system's default handler.
 */
interface LaunchSpec {
  /** Command to execute. */
  cmd: string;
  /** Build the argument list. `target` is the optional path/URL. */
  args: (target?: string) => string[];
  /** If true, launch with `shell: true` (needed for Windows `start`). */
  shell?: boolean;
}

type PlatformSpecs = Record<string, LaunchSpec>;

const PLATFORM_SPECS: Record<string, PlatformSpecs> = {
  win32: {
    vscode: {
      cmd: "code",
      args: (t) => (t ? [t] : []),
    },
    explorer: {
      cmd: "explorer",
      args: (t) => [t ?? "."],
    },
    diff: {
      cmd: "code",
      args: (t) => (t ? ["--diff", ...t.split("|").map((s) => s.trim())] : []),
    },
    terminal: {
      cmd: "cmd",
      args: () => ["/c", "start", "cmd"],
      shell: true,
    },
    browser: {
      cmd: "start",
      args: (t) => [t ?? "https://localhost"],
      shell: true,
    },
    default: {
      cmd: "start",
      args: (t) => ["", t ?? "."],
      shell: true,
    },
  },
  darwin: {
    vscode: {
      cmd: "code",
      args: (t) => (t ? [t] : []),
    },
    explorer: {
      cmd: "open",
      args: (t) => [t ?? "."],
    },
    diff: {
      cmd: "code",
      args: (t) => (t ? ["--diff", ...t.split("|").map((s) => s.trim())] : []),
    },
    terminal: {
      cmd: "open",
      args: () => ["-a", "Terminal"],
    },
    browser: {
      cmd: "open",
      args: (t) => [t ?? "https://localhost"],
    },
    default: {
      cmd: "open",
      args: (t) => [t ?? "."],
    },
  },
  linux: {
    vscode: {
      cmd: "code",
      args: (t) => (t ? [t] : []),
    },
    explorer: {
      cmd: "xdg-open",
      args: (t) => [t ?? "."],
    },
    diff: {
      cmd: "code",
      args: (t) => (t ? ["--diff", ...t.split("|").map((s) => s.trim())] : []),
    },
    terminal: {
      cmd: "xdg-open",
      args: () => ["x-terminal-emulator"],
    },
    browser: {
      cmd: "xdg-open",
      args: (t) => [t ?? "https://localhost"],
    },
    default: {
      cmd: "xdg-open",
      args: (t) => [t ?? "."],
    },
  },
};

/**
 * Known application names the model can use. Listed in the tool description
 * so the model knows which aliases are available without guessing.
 */
const KNOWN_APPS = ["vscode", "explorer", "diff", "terminal", "browser"];

export const openTool: Tool = {
  name: "Open",
  description:
    `Launch an external application (GUI) on the user's machine. ` +
    `Use this to open files/folders in VS Code, the file explorer, a browser, ` +
    `a terminal, or to diff two files. Works cross-platform (Windows, macOS, Linux).\n\n` +
    `Known application aliases: ${KNOWN_APPS.join(", ")}.\n` +
    `• "vscode" — opens a file or folder in VS Code\n` +
    `• "explorer" — opens a file or folder in the system file manager\n` +
    `• "diff" — opens a VS Code diff view (pass two paths separated by "|")\n` +
    `• "terminal" — opens a new terminal window\n` +
    `• "browser" — opens a URL in the default browser\n` +
    `• Any other value — opens the target with the system's default handler`,
  inputSchema: {
    type: "object" as const,
    properties: {
      application: {
        type: "string",
        description:
          `The application to launch. Use one of the known aliases: ${KNOWN_APPS.join(", ")}. ` +
          `For diff, pass two file paths separated by "|" in the target parameter. ` +
          `Any unrecognized value will open the target with the system default handler.`,
      },
      target: {
        type: "string",
        description:
          "The file path, folder path, or URL to open. " +
          'For diff, pass two paths separated by "|" (e.g., "file1.ts | file2.ts"). ' +
          "Optional — some applications (like terminal) don't need a target.",
      },
    },
    required: ["application"],
  },
  isConcurrencySafe: true,

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    let application: string;
    let target: string | undefined;
    try {
      application = requireString(input, "application").toLowerCase();
      target = optionalString(input, "target");
    } catch (err: unknown) {
      if (err instanceof ToolInputError) {
        return { content: err.message, is_error: true };
      }
      throw err;
    }

    // Resolve the platform specs
    const platform = process.platform === "win32"
      ? "win32"
      : process.platform === "darwin"
        ? "darwin"
        : "linux"; // Default to linux for other POSIX systems

    const specs = PLATFORM_SPECS[platform];
    const spec = specs[application] ?? specs["default"];

    // For "default" handler, make sure we have a target
    if (!specs[application] && !target) {
      return {
        content:
          `Unknown application "${application}" and no target specified. ` +
          `Provide a target (file, folder, or URL) to open with the system default handler, ` +
          `or use one of: ${KNOWN_APPS.join(", ")}.`,
        is_error: true,
      };
    }

    // For diff, validate that two paths are provided
    if (application === "diff") {
      if (!target || !target.includes("|")) {
        return {
          content:
            'Diff requires two file paths separated by "|". ' +
            'Example: "src/old.ts | src/new.ts"',
          is_error: true,
        };
      }
      const parts = target.split("|").map((s) => s.trim());
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return {
          content:
            'Diff requires exactly two non-empty file paths separated by "|". ' +
            'Example: "src/old.ts | src/new.ts"',
          is_error: true,
        };
      }
    }

    const cmd = spec.cmd;
    const args = spec.args(target);

    // Check for abort before spawning
    if (context.abortController.signal.aborted) {
      return { content: "Aborted by user.", is_error: true };
    }

    return new Promise((resolve) => {
      try {
        const proc = spawn(cmd, args, {
          cwd: context.cwd,
          // Detach so the launched application outlives the agent process.
          // On Windows, shell: true is needed for `start` commands.
          detached: true,
          shell: spec.shell ?? false,
          stdio: "ignore",
        });

        // Allow the agent process to exit without waiting for the child
        proc.unref();

        // Give the process a moment to fail (e.g., ENOENT for missing command)
        // before reporting success. 500ms is enough to catch spawn errors
        // without blocking the agent for a noticeable duration.
        let settled = false;

        proc.on("error", (err) => {
          if (settled) return;
          settled = true;
          const isNotFound =
            err && typeof err === "object" && "code" in err && (err as { code: string }).code === "ENOENT";
          if (isNotFound) {
            resolve({
              content:
                `Error: Could not launch "${cmd}" — command not found.\n` +
                (application === "vscode"
                  ? "  • Make sure VS Code is installed and the `code` command is in PATH.\n" +
                    '  • In VS Code: Cmd+Shift+P → "Shell Command: Install \'code\' command in PATH"'
                  : `  • Make sure "${cmd}" is installed and available in PATH.`),
              is_error: true,
            });
          } else {
            resolve({
              content: `Error launching "${cmd}": ${(err as Error).message}`,
              is_error: true,
            });
          }
        });

        // If no error after 500ms, assume it launched successfully
        setTimeout(() => {
          if (settled) return;
          settled = true;
          const targetDesc = target ? ` "${target}"` : "";
          resolve({
            content: `Launched ${application}${targetDesc} successfully.`,
          });
        }, 500);
      } catch (err: unknown) {
        resolve({
          content: `Error: Failed to spawn "${cmd}": ${(err as Error).message}`,
          is_error: true,
        });
      }
    });
  },
};
