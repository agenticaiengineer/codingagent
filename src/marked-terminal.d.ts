declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";

  interface MarkedTerminalOptions {
    heading?: ((text: string, level: number) => string) | ((text: string) => string);
    strong?: (text: string) => string;
    em?: (text: string) => string;
    codespan?: (code: string) => string;
    blockquote?: (text: string) => string;
    hr?: () => string;
    link?: (href: string, title: string, text: string) => string;
    listitem?: (text: string) => string;
    tableOptions?: Record<string, unknown>;
    width?: number;
    showSectionPrefix?: boolean;
    reflowText?: boolean;
    tab?: number;
    code?: (code: string, lang?: string) => string;
    paragraph?: (text: string) => string;
    [key: string]: unknown;
  }

  export function markedTerminal(options?: MarkedTerminalOptions): MarkedExtension;
  export default markedTerminal;
}
