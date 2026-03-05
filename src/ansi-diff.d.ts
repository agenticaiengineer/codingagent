declare module "ansi-diff" {
  interface AnsiDiffInstance {
    update(text: string): Buffer;
    resize(opts: { width?: number; height?: number }): void;
    toString(): string;
    x: number;
    y: number;
    width: number;
    height: number;
  }

  interface AnsiDiffOptions {
    width?: number;
    height?: number;
  }

  function createDiff(opts?: AnsiDiffOptions): AnsiDiffInstance;
  export default createDiff;
}
