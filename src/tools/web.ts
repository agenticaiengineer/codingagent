import type { Tool, ToolInput, ToolContext, ToolResult } from "../core/types.js";
import { requireString, optionalString, optionalInteger, ToolInputError, safeTruncate } from "./validate.js";
import { combineSignals } from "../utils/retry.js";
import { isPrivateOrReservedHost } from "./browser-ssrf.js";

/**
 * Maximum response body size (in bytes) to read into memory.
 * Shared by both webFetchTool and webSearchTool.
 * 2 MB is generous for web pages while preventing OOM crashes on
 * multi-GB responses (e.g., binary file downloads, malformed servers).
 */
const MAX_BODY_BYTES = 2 * 1024 * 1024; // 2 MB

/**
 * Maximum HTML size (in characters) to retain before running `stripHtml()`.
 * HTML beyond this limit is truncated after removing <head>/<script>/<style>
 * blocks (which typically account for 30–60% of page size). 500K of remaining
 * HTML comfortably produces more than 50K chars of text content — the final
 * truncation limit — even for tag-heavy pages with low text-to-markup ratios.
 *
 * This avoids running ~17 regex replacements (each allocating a new string) on
 * the full 2 MB body limit, which would produce ~34 MB of intermediate string
 * allocations that are immediately discarded after the 50K output truncation.
 */
const HTML_PRETRUNCATE_LIMIT = 500_000; // 500K chars

/**
 * Read a fetch Response body with a streaming size cap to prevent OOM.
 *
 * `response.text()` reads the *entire* body into memory before returning,
 * so a server streaming gigabytes would crash Node.js. This helper uses
 * the ReadableStream reader to accumulate chunks up to `maxBytes`, then
 * cancels the download and works with what we have.
 *
 * Returns `{ text, truncated }` — `truncated` is true if the body exceeded
 * the size cap and was cut short.
 *
 * Falls back to `response.text()` + substring when `response.body` is null
 * (rare but possible in some Node.js environments).
 */
async function readBodyWithLimit(
  response: Response,
  maxBytes: number = MAX_BODY_BYTES
): Promise<{ text: string; truncated: boolean }> {
  const body = response.body;
  if (body) {
    const reader = body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: false });
    const chunks: string[] = [];
    let totalBytes = 0;
    let truncated = false;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          // Keep the portion that fits within the cap
          const excess = totalBytes - maxBytes;
          if (excess < value.byteLength) {
            // Decode the portion of this chunk that fits, with `stream: false`
            // to flush the decoder's internal buffer (any incomplete multi-byte
            // sequence held from a previous `{ stream: true }` call).
            chunks.push(decoder.decode(value.subarray(0, value.byteLength - excess), { stream: false }));
          } else {
            // The entire chunk is excess (excess >= value.byteLength). This
            // happens when the *previous* chunk brought totalBytes to exactly
            // maxBytes or very close, and this chunk pushed it over entirely.
            // No new bytes from this chunk should be decoded, but the decoder
            // may still hold incomplete multi-byte bytes from the previous
            // `{ stream: true }` call — flush them with a no-arg decode().
            const flushed = decoder.decode();
            if (flushed) chunks.push(flushed);
          }
          truncated = true;
          break;
        }
        chunks.push(decoder.decode(value, { stream: true }));
      }
      // Flush the TextDecoder's internal buffer when the stream ends normally.
      // Every intermediate chunk above is decoded with `{ stream: true }`, which
      // tells the decoder "more data is coming" — it may hold back incomplete
      // multi-byte UTF-8 sequences (e.g., a 3-byte emoji split across two
      // network chunks). Without this final flush call, those trailing bytes are
      // silently dropped when the decoder is GC'd. The truncation path already
      // uses `{ stream: false }` on the last chunk, so this flush is only needed
      // for the non-truncated (normal completion) path.
      if (!truncated) {
        const flushed = decoder.decode();
        if (flushed) chunks.push(flushed);
      }
    } finally {
      // Cancel the remaining stream to release the connection.
      // Without this, the fetch connection stays open until the server
      // finishes sending all data, tying up a socket for potentially minutes.
      //
      // `reader.cancel()` returns a Promise — awaiting it ensures the
      // underlying TCP connection is actually released before we return.
      // Without `await`, the cancellation is fire-and-forget: the connection
      // lingers in a half-closed state until the microtask runs, and rapid
      // successive WebFetch calls (e.g., the model fetching multiple URLs
      // in parallel) can accumulate dangling connections that tie up sockets
      // and may hit OS connection limits. The `await` is inside a try/catch
      // so a rejection from an already-closed reader doesn't propagate.
      try { await reader.cancel(); } catch { /* best-effort */ }
    }
    return { text: chunks.join(""), truncated };
  } else {
    // Fallback for environments where response.body is null.
    // `response.text()` reads the full body — truncate afterward.
    // Compare against byte length (not string length) for consistency with
    // the streaming path, which counts actual bytes received. `fullText.length`
    // counts UTF-16 code units, which is roughly equal to byte count for ASCII
    // but can be 2-4× smaller for multi-byte UTF-8 content, making the cap
    // effectively 2-4× too generous. Use Buffer.byteLength for accuracy.
    const fullText = await response.text();
    const byteLen = Buffer.byteLength(fullText, "utf-8");
    if (byteLen > maxBytes) {
      // Approximate a character cut point from the byte ratio, then apply
      // surrogate-aware truncation via safeTruncate.
      const end = Math.floor(fullText.length * (maxBytes / byteLen));
      return { text: safeTruncate(fullText, end), truncated: true };
    }
    return { text: fullText, truncated: false };
  }
}

export const webFetchTool: Tool = {
  name: "WebFetch",
  description:
    "Fetch content from a URL. Returns the text content of the page.",
  inputSchema: {
    type: "object" as const,
    properties: {
      url: {
        type: "string",
        description: "The URL to fetch",
      },
      prompt: {
        type: "string",
        description: "What information to extract from the page",
      },
    },
    required: ["url"],
  },
  isConcurrencySafe: true,

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    let url: string;
    try {
      url = requireString(input, "url");
    } catch (err: unknown) {
      if (err instanceof ToolInputError) {
        return { content: err.message, is_error: true };
      }
      throw err;
    }

    // Check for abort before starting URL validation and network I/O.
    // Without this, a queued WebFetch tool call would proceed through URL
    // parsing, SSRF host checking, network request setup, and only then detect
    // the abort via the fetch signal — wasting time on all the pre-fetch
    // validation. This is the same pre-abort pattern applied in grep.ts
    // (improvement #25), bash.ts, task.ts, and glob.ts.
    if (context.abortController.signal.aborted) {
      return { content: "Aborted by user.", is_error: true };
    }

    // Reject excessively long URLs. A model could pass a multi-MB data URI
    // or an extremely long query string, causing `new URL()` to allocate a
    // large object and `fetch` to send a huge request header that most servers
    // reject with 414 URI Too Long. 8 KB is the practical limit for most HTTP
    // servers (Apache default: 8190 bytes, nginx: 4096–8192, Cloudflare: 16 KB)
    // and exceeds any legitimate URL length.
    if (url.length > 8192) {
      return {
        content: `Error: URL is too long (${url.length.toLocaleString()} characters, max 8192). Shorten the URL or reduce query parameters.`,
        is_error: true,
      };
    }

    // Validate URL protocol to prevent SSRF via file://, ftp://, etc.
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return {
        content: `Error: Invalid URL: ${url}`,
        is_error: true,
      };
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return {
        content: `Error: Only http:// and https:// URLs are allowed. Got: ${parsed.protocol}`,
        is_error: true,
      };
    }

    // Block requests to private/internal hosts to prevent SSRF.
    // The LLM could attempt to fetch cloud metadata endpoints
    // (169.254.169.254), localhost admin panels, or internal services.
    if (isPrivateOrReservedHost(parsed.hostname, parsed.port || undefined)) {
      return {
        content: `Error: Requests to private/internal network addresses are blocked (${parsed.hostname}). WebFetch can only access public internet URLs. To allow local development servers, add the host:port to "allowedHosts" in ~/.claude/settings.json.`,
        is_error: true,
      };
    }

    try {
      // Combine the user's abort signal with a 30-second timeout.
      // If the user presses Ctrl+C, the context abort fires and cancels the fetch.
      const response = await fetch(url, {
        headers: {
          // Use a browser-like User-Agent to avoid 403 blocks from sites that
          // reject non-browser UAs (common on documentation sites, news sites,
          // and CDNs with bot protection). Previously webFetchTool used a
          // generic "CodingAgent/0.1" UA while webSearchTool already used a
          // Chrome UA — resulting in inconsistent behavior where the same site
          // could be searched via WebSearch but not fetched via WebFetch.
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/json,text/plain,*/*",
        },
        redirect: "follow",
        signal: combineSignals([
          context.abortController.signal,
          AbortSignal.timeout(30_000),
        ]),
      });

      // After following redirects, check that the final URL's hostname is
      // not a private/internal address. Without this, the LLM could bypass
      // the pre-fetch SSRF check by using an open redirect on a public site
      // (e.g., `https://public.example.com/redirect?url=http://169.254.169.254/`)
      // to reach internal services, cloud metadata endpoints, or localhost
      // admin panels. `response.url` is the final URL after all redirects.
      try {
        const finalUrl = new URL(response.url);
        if (isPrivateOrReservedHost(finalUrl.hostname, finalUrl.port || undefined)) {
          return {
            content: `Error: Request was redirected to a private/internal address (${finalUrl.hostname}). WebFetch can only access public internet URLs.`,
            is_error: true,
          };
        }
      } catch {
        // If the final URL can't be parsed (shouldn't happen with a valid
        // response), fall through — the pre-fetch check already validated
        // the original URL.
      }

      if (!response.ok) {
        // Provide actionable guidance for common HTTP errors instead of
        // bare status codes that don't help the user or model self-correct.
        let hint = "";
        if (response.status === 403) {
          hint = " The site may be blocking automated requests. Try WebSearch to find the information instead, or look for an API endpoint.";
        } else if (response.status === 404) {
          hint = " The page was not found. Check the URL for typos, or use WebSearch to find the current URL.";
        } else if (response.status === 429) {
          hint = " The site is rate-limiting requests. Wait a moment before retrying.";
        } else if (response.status === 500) {
          hint = " The server encountered an internal error. This is often transient — try again in a moment, or use WebSearch to find the information from a different source.";
        } else if (response.status === 502) {
          hint = " A gateway or proxy error occurred. This is often transient — try again in a moment.";
        } else if (response.status === 503) {
          hint = " The service is temporarily unavailable (possibly under maintenance or overloaded). Try again in a moment, or use WebSearch to find alternative sources.";
        }
        return {
          content: `HTTP ${response.status}: ${response.statusText}.${hint}`,
          is_error: true,
        };
      }

      // Reject known binary Content-Types before reading the body. Binary
      // files (images, PDFs, executables, archives, audio, video) decoded
      // as UTF-8 produce megabytes of garbage replacement characters that
      // waste tokens and provide no useful information to the model.
      // Checking *before* readBodyWithLimit avoids downloading up to 2 MB
      // of useless binary data. The check is conservative — unknown types
      // and text/* types pass through unchanged.
      const contentType = response.headers.get("content-type") ?? "";
      const ctLower = contentType.toLowerCase();
      if (
        ctLower.startsWith("image/") ||
        ctLower.startsWith("audio/") ||
        ctLower.startsWith("video/") ||
        ctLower.startsWith("font/") ||
        ctLower.includes("application/pdf") ||
        ctLower.includes("application/zip") ||
        ctLower.includes("application/gzip") ||
        ctLower.includes("application/x-tar") ||
        ctLower.includes("application/octet-stream") ||
        ctLower.includes("application/x-executable") ||
        ctLower.includes("application/x-sharedlib") ||
        ctLower.includes("application/wasm") ||
        ctLower.includes("application/x-7z-compressed") ||
        ctLower.includes("application/x-rar-compressed") ||
        ctLower.includes("application/x-bzip2")
      ) {
        // Extract the MIME type (strip charset/boundary parameters) for a
        // clean error message.
        const mime = ctLower.split(";")[0].trim();
        return {
          content: `Error: The URL returned binary content (${mime}) which cannot be meaningfully displayed as text. Use WebSearch to find a text version, documentation page, or API endpoint instead.`,
          is_error: true,
        };
      }

      // Read the response body with a streaming size cap to prevent OOM
      // on multi-GB responses (e.g., binary downloads, malformed servers).
      const { text: rawText, truncated: truncatedBySize } = await readBodyWithLimit(response);
      let text = rawText;
      if (truncatedBySize) {
        text += `\n\n... (response truncated — exceeded ${MAX_BODY_BYTES / (1024 * 1024)} MB download limit)`;
      }

      // Strip HTML markup to reduce token waste when fetching web pages.
      // Remove script/style blocks entirely, then strip remaining tags,
      // collapse excessive whitespace, and decode common HTML entities.
      // Detect HTML content: check Content-Type header first (cheap), then
      // inspect the first bytes of the body.
      let isHtml = contentType.includes("html");
      if (!isHtml) {
        // Skip body-based HTML detection when the Content-Type explicitly
        // indicates a non-HTML text format. These types can never be HTML,
        // so the 3-regex body inspection is pure waste — it allocates a
        // 1200-char substring and runs regex tests that always fail. This
        // is the common path for JSON APIs (`application/json`), plain text
        // files (`text/plain`), and structured data (`text/csv`, `text/calendar`).
        //
        // Only skip for types that are unambiguously non-HTML. Types like
        // `application/xml` or `text/xml` may contain XHTML and need the body
        // check. Types without a recognizable prefix (empty, missing, or
        // unusual types) also need the body check as a fallback.
        const isKnownNonHtml =
          ctLower.startsWith("application/json") ||
          ctLower.startsWith("text/plain") ||
          ctLower.startsWith("text/csv") ||
          ctLower.startsWith("text/calendar") ||
          ctLower.startsWith("text/css") ||
          ctLower.startsWith("text/javascript") ||
          ctLower.startsWith("application/javascript") ||
          ctLower.startsWith("text/markdown") ||
          ctLower.startsWith("application/yaml") ||
          ctLower.startsWith("text/yaml");
        if (!isKnownNonHtml) {
          // Strip leading whitespace and BOM (U+FEFF) before inspecting the
          // body's first tag. BOM (byte order mark) characters are prepended to
          // some UTF-8/UTF-16 web responses and appear as invisible whitespace
          // before '<!DOCTYPE' or '<?xml'. Without stripping BOM, the regex
          // tests below would fail to match, causing XHTML/BOM-prefixed pages
          // to flow through as raw HTML with all tags intact — wasting tokens
          // and producing unreadable output.
          //
          // Only slice the first 1200 characters before trimming — the detection
          // patterns only need the first ~1000 chars (the XHTML check explicitly
          // limits itself to 1000 chars). Previously `text.replace(/^[\s\uFEFF]+/, "")`
          // ran against the full text (up to 2MB after body read). While the `^`
          // anchor directs the regex to only scan from position 0, `String.replace()`
          // still allocates a new string containing the entire remainder (~2MB minus
          // whitespace). For non-HTML responses (JSON APIs, plain text, XML feeds),
          // this allocation is pure waste — the result is tested against three regexes
          // and immediately discarded. The 1200-char prefix accommodates any realistic
          // amount of leading whitespace/BOM before the document's opening tag.
          const trimmed = text.slice(0, 1200).replace(/^[\s\uFEFF]+/, "");
          isHtml =
            /^<!doctype\b/i.test(trimmed) ||
            /^<html[\s>]/i.test(trimmed) ||
            // Detect XHTML served as application/xml or text/xml: these start
            // with an XML declaration (<?xml ...?>) followed by an HTML doctype
            // or <html> root. The Content-Type header won't contain "html" for
            // XHTML-strict or XML-wrapped pages, so we check the body.
            //
            // Previously this matched any `<?xml` prefix, which caused false
            // positives on RSS feeds (<rss>, <feed>), Atom feeds, SVG images,
            // and other XML documents. The HTML stripping logic (removing <nav>,
            // <footer>, <form>, etc.) would then destroy actual content in these
            // documents — e.g., RSS <item> elements wrapped in stripped tags, or
            // SVG <path> data removed by the generic tag stripper. Now we require
            // that `<html` or `<!DOCTYPE html` appears within the first 1000
            // characters after the XML declaration, confirming it's actually
            // XHTML and not a different XML vocabulary.
            (/^<\?xml\b/i.test(trimmed) &&
              /(?:<html[\s>]|<!doctype\s+html\b)/i.test(trimmed.slice(0, 1000)));
        }
      }
      if (isHtml) {
        // Pre-truncate very large HTML before running stripHtml to avoid
        // running ~17 regex replacements on up to 2 MB of text. Each
        // replacement allocates a new string, so the total allocation
        // approaches 17 × 2 MB ≈ 34 MB for a max-size response — all of
        // which is thrown away when the final output is truncated to 50K
        // chars anyway.
        //
        // HTML is typically 3–10× larger than its text content (tags,
        // attributes, scripts, styles, navigation). 500K of raw HTML
        // after <head>/<script>/<style> removal comfortably produces more
        // than 50K of text content. We apply the limit *after* removing
        // the heaviest non-content blocks (head, script, style) which
        // often account for 30–60% of page size — this preserves more
        // actual content from large pages compared to a blind truncation.
        //
        // The three-step approach (remove heavy blocks → truncate → finish
        // stripping) avoids the worst case where a 2 MB page is 80%
        // JavaScript/CSS that would be stripped anyway.
        if (text.length > HTML_PRETRUNCATE_LIMIT) {
          // Phase 1: Remove the heaviest non-content blocks first
          RE_HEAD_BLOCK.lastIndex = 0;
          text = text.replace(RE_HEAD_BLOCK, "");
          RE_SCRIPT_BLOCK.lastIndex = 0;
          text = text.replace(RE_SCRIPT_BLOCK, "");
          RE_STYLE_BLOCK.lastIndex = 0;
          text = text.replace(RE_STYLE_BLOCK, "");
          // Phase 2: If still too large after removing heavy blocks, truncate
          if (text.length > HTML_PRETRUNCATE_LIMIT) {
            text = safeTruncate(text, HTML_PRETRUNCATE_LIMIT);
          }
          // Phase 3: Run full stripHtml (which will skip already-removed
          // head/script/style via the regex finding no matches)
        }
        text = stripHtml(text);
      }

      // Truncate large responses using safeTruncate to avoid splitting
      // surrogate pairs (emoji, CJK characters) at the cut point.
      // Include the original character count so the model knows how much
      // content was lost — a page truncated from 200K to 50K is very
      // different from one truncated from 55K.
      if (text.length > 50000) {
        const originalLen = text.length;
        text = safeTruncate(text, 50000) + `\n... (content truncated — showing 50,000 of ${originalLen.toLocaleString("en-US")} chars)`;
      }

      // Notify the model when the final URL differs from the requested URL
      // (i.e., a redirect occurred). Without this, the model has no idea the
      // content came from a different URL — it may cite the original URL in
      // responses, try to fetch sub-paths relative to the original domain, or
      // retry the same URL expecting different content. Common scenarios:
      //   - HTTP → HTTPS redirect (http://example.com → https://example.com)
      //   - www normalization (example.com → www.example.com)
      //   - Trailing slash (docs.rs/foo → docs.rs/foo/)
      //   - Vanity URLs (short.link/abc → realsite.com/full-path)
      //   - Version redirects (docs.python.org/library/ → docs.python.org/3/library/)
      //
      // Only show when the URLs are meaningfully different (not just protocol
      // or trailing slash normalization) to avoid noise. Compare after
      // normalizing: lowercase scheme+host, strip trailing slash. The
      // `response.url` is always set by `fetch()` to the final URL after all
      // redirects, even if no redirect occurred (in which case it equals the
      // request URL).
      if (response.url && response.url !== url) {
        // Check if the difference is meaningful (not just trivial normalization)
        const normalize = (u: string): string => {
          try {
            const p = new URL(u);
            // Normalize: lowercase host, remove trailing slash, remove default port
            let normalized = `${p.protocol}//${p.host.toLowerCase()}${p.pathname.replace(/\/+$/, "")}`;
            if (p.search) normalized += p.search;
            return normalized;
          } catch {
            return u;
          }
        };
        if (normalize(url) !== normalize(response.url)) {
          text = `[Redirected to: ${response.url}]\n\n${text}`;
        }
      }

      return { content: text };
    } catch (err: unknown) {
      // Distinguish timeout from user-initiated abort so the user/model
      // knows whether to retry (timeout) or stop (Ctrl+C).  Both produce
      // a DOMException with a generic "The operation was aborted" message,
      // but `AbortSignal.timeout()` sets `name: "TimeoutError"` while
      // user Ctrl+C (via AbortController.abort()) sets `name: "AbortError"`.
      if (err instanceof DOMException) {
        if (err.name === "TimeoutError") {
          return {
            content: "Fetch timed out after 30 seconds. The server may be slow or unresponsive. Try again, or use WebSearch to find alternative sources.",
            is_error: true,
          };
        }
        if (err.name === "AbortError") {
          return { content: "Aborted by user.", is_error: true };
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      // Provide actionable hints for common network errors. Without these,
      // the model sees a bare error like "Fetch error: fetch failed" or
      // "Fetch error: getaddrinfo ENOTFOUND example.com" with no guidance
      // on what to do. The same approach is already used in loop.ts for
      // API call errors (networkErrorHint), but WebFetch errors surface
      // directly to the model as tool results — making actionable messages
      // even more important since the model will use them to decide its
      // next action (retry, try a different URL, fall back to WebSearch).
      let hint = "";
      if (/ENOTFOUND|getaddrinfo/i.test(msg)) {
        hint = " The hostname could not be resolved — check for typos in the URL or use WebSearch instead.";
      } else if (/ECONNREFUSED/i.test(msg)) {
        hint = " The connection was refused. The server may be down or blocking requests. Try WebSearch to find alternative sources.";
      } else if (/ECONNRESET|socket hang up/i.test(msg)) {
        hint = " The connection was reset by the server. Try again, or use WebSearch to find the information.";
      } else if (/ETIMEDOUT/i.test(msg)) {
        hint = " The connection timed out at the TCP level. The server may be unreachable or overloaded. Try again, or use WebSearch to find the information from a different source.";
      } else if (/certificate|CERT|SSL|TLS/i.test(msg)) {
        hint = " There was an SSL/TLS certificate error. The site's certificate may be expired or invalid.";
      }
      return { content: `Fetch error: ${msg}${hint}`, is_error: true };
    }
  },
};

export const webSearchTool: Tool = {
  name: "WebSearch",
  description:
    "Search the web using DuckDuckGo. Returns titles, URLs, and snippets for matching results.",
  inputSchema: {
    type: "object" as const,
    properties: {
      query: {
        type: "string",
        description: "The search query",
      },
      count: {
        type: "number",
        description:
          "Maximum number of results to return (default 10, max 20)",
      },
      type: {
        type: "string",
        description:
          'Type of search: "web" (default) or "news"',
      },
    },
    required: ["query"],
  },
  isConcurrencySafe: true,

  async execute(input: ToolInput, context: ToolContext): Promise<ToolResult> {
    let query: string;
    let count: number;
    let searchType: string;
    try {
      query = requireString(input, "query");
      count = Math.min(Math.max(optionalInteger(input, "count") ?? 10, 1), 20);
      searchType = optionalString(input, "type") ?? "web";
    } catch (err: unknown) {
      if (err instanceof ToolInputError) {
        return { content: err.message, is_error: true };
      }
      throw err;
    }

    // Reject whitespace-only queries. `requireString` only checks the field
    // exists and is a string, so a query of `"   "` or `"\n\t"` passes
    // validation but sends a blank search to DuckDuckGo, producing
    // unpredictable results (usually zero results or an error page) with
    // no indication that the query itself was empty. Trim and check
    // explicitly for a clear error message.
    if (query.trim().length === 0) {
      return {
        content: "Error: Search query is empty or contains only whitespace. Provide a non-empty search query.",
        is_error: true,
      };
    }

    // Check for abort before starting network I/O. Without this, a queued
    // WebSearch tool call would proceed through input validation, URL encoding,
    // body construction, and the fetch() request — all wasted work when the
    // result will be discarded. This is the same pre-abort check pattern
    // already established in WebFetch (web.ts line ~375), grep.ts, bash.ts,
    // task.ts, and glob.ts.
    if (context.abortController.signal.aborted) {
      return { content: "Aborted by user.", is_error: true };
    }

    // Validate search type — only "web" and "news" are supported.
    // Without this guard, passing "images", "videos", or a typo like "nws"
    // silently falls through to a plain web search with no feedback that
    // the requested type was ignored.
    if (searchType !== "web" && searchType !== "news") {
      return {
        content: `Error: Invalid search type "${searchType}". Supported types: "web", "news".`,
        is_error: true,
      };
    }

    try {
      const encodedQuery = encodeURIComponent(query);
      // Use GET instead of POST. DuckDuckGo's bot-detection (CAPTCHA/anomaly
      // challenge) triggers on POST requests from Node.js's fetch (undici)
      // due to TLS fingerprinting differences, but allows GET requests through.
      // The query is passed in the URL query string.
      let url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;
      if (searchType === "news") {
        url += "&ia=news&iar=news";
      }

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          Referer: "https://html.duckduckgo.com/",
        },
        redirect: "follow",
        signal: combineSignals([
          context.abortController.signal,
          AbortSignal.timeout(30_000),
        ]),
      });

      if (!response.ok) {
        // HTTP 202 is DuckDuckGo's bot-detection CAPTCHA page. Fall back to
        // curl which has a different TLS fingerprint and avoids the challenge.
        if (response.status === 202) {
          return await searchViaCurl(query, searchType, count);
        }
        return {
          content: `Search request failed: HTTP ${response.status} ${response.statusText}`,
          is_error: true,
        };
      }

      // Read the response body with a streaming size cap. DuckDuckGo HTML
      // pages are typically small (~50 KB), but a malformed response or
      // man-in-the-middle attack could send a multi-GB response.
      const { text: html } = await readBodyWithLimit(response);
      const results = parseDuckDuckGoResults(html, count);

      if (results.length === 0) {
        // The parser found nothing. If the page is large (>5 KB), DDG almost
        // certainly returned results but the HTML structure has changed.
        // Check for bot-detection challenge pages (anomaly-modal, challenge-form)
        // that slip through with HTTP 200.
        if (html.includes("challenge-form") || html.includes("anomaly-modal")) {
          return await searchViaCurl(query, searchType, count);
        }
        if (html.length > 5000) {
          return {
            content: `Search for "${query}" returned results, but the result parser could not extract them (page structure may have changed). Raw page length: ${html.length} chars.`,
            is_error: true,
          };
        }
        return { content: `No results found for: "${query}"` };
      }

      const formatted = results
        .map(
          (r, i) =>
            `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`
        )
        .join("\n\n");

      return {
        content: `${searchType === "news" ? "News search" : "Search"} results for "${query}" (${results.length} results):\n\n${formatted}`,
      };
    } catch (err: unknown) {
      if (err instanceof DOMException) {
        if (err.name === "TimeoutError") {
          return {
            content: "Search request timed out after 30 seconds. DuckDuckGo may be slow or unreachable. Try again in a moment.",
            is_error: true,
          };
        }
        if (err.name === "AbortError") {
          return { content: "Aborted by user.", is_error: true };
        }
      }
      const msg = err instanceof Error ? err.message : String(err);
      // Provide actionable hints for common network errors — same pattern
      // as the WebFetch error handler. When the model can't reach DDG, it
      // needs to know whether to retry (transient) or give up (DNS failure).
      let hint = "";
      if (/ENOTFOUND|getaddrinfo/i.test(msg)) {
        hint = " DNS resolution failed — check your internet connection.";
      } else if (/ECONNREFUSED/i.test(msg)) {
        hint = " The connection was refused. DuckDuckGo may be blocked by a firewall or proxy.";
      } else if (/ECONNRESET|socket hang up/i.test(msg)) {
        hint = " The connection was reset. Try again in a moment.";
      } else if (/ETIMEDOUT/i.test(msg)) {
        hint = " The connection timed out at the TCP level. DuckDuckGo may be unreachable — check your internet connection and try again.";
      }
      return { content: `Search error: ${msg}${hint}`, is_error: true };
    }
  },
};

// ── Curl fallback for bot-detection bypass ───────────────────────────────────

/**
 * Fall back to curl when DuckDuckGo's bot-detection blocks Node.js fetch.
 *
 * DuckDuckGo fingerprints the TLS handshake (JA3/JA4) and blocks requests
 * from Node.js/undici with a CAPTCHA challenge (HTTP 202, "anomaly-modal").
 * curl has a different TLS fingerprint that DDG allows through.
 *
 * This function spawns curl as a child process to fetch the search results,
 * then parses them with the same regex-based parser.
 */
async function searchViaCurl(
  query: string,
  searchType: string,
  maxResults: number
): Promise<{ content: string; is_error?: boolean }> {
  try {
    const { execSync } = await import("child_process");
    const encodedQuery = encodeURIComponent(query);
    let url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;
    if (searchType === "news") {
      url += "&ia=news&iar=news";
    }

    const html = execSync(
      `curl -s "${url}" -H "User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" --max-time 15`,
      { encoding: "utf-8", timeout: 20_000 }
    );

    const results = parseDuckDuckGoResults(html, maxResults);
    if (results.length === 0) {
      if (html.length > 5000) {
        return {
          content: `Search for "${query}" returned results via curl fallback, but the parser could not extract them. Raw page length: ${html.length} chars.`,
          is_error: true,
        };
      }
      return { content: `No results found for: "${query}"` };
    }

    const formatted = results
      .map(
        (r, i) =>
          `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}`
      )
      .join("\n\n");

    return {
      content: `${searchType === "news" ? "News search" : "Search"} results for "${query}" (${results.length} results):\n\n${formatted}`,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: `Search failed: DuckDuckGo blocked the request (bot detection) and curl fallback also failed: ${msg}`,
      is_error: true,
    };
  }
}

// ── DuckDuckGo HTML result parser ────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

/**
 * Parse search results from DuckDuckGo's HTML search page.
 *
 * The HTML page contains result blocks with class "result" or "result results_links".
 * Each block has:
 *   - A link (<a class="result__a">) containing the title
 *   - The href on that link (often a DuckDuckGo redirect URL that encodes the real URL)
 *   - A snippet (<a class="result__snippet">) containing the description
 */
function parseDuckDuckGoResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];

  // Extract individual result links and snippets directly
  // DuckDuckGo uses <a rel="nofollow" class="result__a" href="...">title</a>
  // and <a class="result__snippet" href="...">snippet</a>
  const titleRe = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;
  // Also try <td class="result__snippet"> for some layouts
  const snippetTdRe = /<td[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/td>/gi;

  // Collect all titles/URLs
  const titles: Array<{ url: string; title: string }> = [];
  let match: RegExpExecArray | null;
  while ((match = titleRe.exec(html)) !== null) {
    const rawUrl = match[1];
    const rawTitle = match[2];
    const url = extractRealUrl(decodeHtmlEntities(rawUrl));
    const title = decodeHtmlEntities(rawTitle.replace(/<[^>]+>/g, "")).trim();
    if (url && title) {
      titles.push({ url, title });
    }
  }

  // Collect all snippets
  const snippets: string[] = [];
  while ((match = snippetRe.exec(html)) !== null) {
    snippets.push(
      decodeHtmlEntities(match[1].replace(/<[^>]+>/g, "")).trim()
    );
  }
  // If we didn't find snippets via <a>, try <td> variant
  if (snippets.length === 0) {
    while ((match = snippetTdRe.exec(html)) !== null) {
      snippets.push(
        decodeHtmlEntities(match[1].replace(/<[^>]+>/g, "")).trim()
      );
    }
  }

  // Pair titles with snippets
  const limit = Math.min(titles.length, maxResults);
  for (let i = 0; i < limit; i++) {
    results.push({
      title: titles[i].title,
      url: titles[i].url,
      snippet: snippets[i] ?? "",
    });
  }

  return results;
}

/**
 * DuckDuckGo often wraps URLs in a redirect like:
 *   //duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com&rut=...
 * This extracts the real destination URL.
 */
function extractRealUrl(rawUrl: string): string {
  // Handle DuckDuckGo redirect URLs
  if (rawUrl.includes("duckduckgo.com/l/?") || rawUrl.includes("duckduckgo.com/y.js?")) {
    try {
      // The URL might start with // so normalize it
      const fullUrl = rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl;
      const parsed = new URL(fullUrl);
      const uddg = parsed.searchParams.get("uddg");
      if (uddg) {
        return uddg;
      }
    } catch {
      // Fall through to return rawUrl
    }
  }

  // Handle protocol-relative URLs
  if (rawUrl.startsWith("//")) {
    return `https:${rawUrl}`;
  }

  return rawUrl;
}

// ── HTML Entity Decoding (shared) ────────────────────────────────────────────

/**
 * Named HTML entities to decode. Includes the most common entities
 * encountered in web content beyond the basic XML set.
 */
const HTML_ENTITIES: Record<string, string> = {
  // XML core entities
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&apos;": "'",
  "&nbsp;": " ",
  // Punctuation & typography
  "&mdash;": "—",
  "&ndash;": "–",
  "&lsquo;": "\u2018",
  "&rsquo;": "\u2019",
  "&ldquo;": "\u201C",
  "&rdquo;": "\u201D",
  "&hellip;": "…",
  "&bull;": "•",
  "&middot;": "·",
  "&laquo;": "«",
  "&raquo;": "»",
  "&trade;": "™",
  "&copy;": "©",
  "&reg;": "®",
  "&deg;": "°",
  "&plusmn;": "±",
  "&times;": "×",
  "&divide;": "÷",
  "&micro;": "µ",
  "&para;": "¶",
  "&sect;": "§",
  "&cent;": "¢",
  "&pound;": "£",
  "&yen;": "¥",
  "&euro;": "€",
  "&frac12;": "½",
  "&frac14;": "¼",
  "&frac34;": "¾",
  // Common arrows / symbols
  "&larr;": "←",
  "&rarr;": "→",
  "&uarr;": "↑",
  "&darr;": "↓",
};

/**
 * Check whether a numeric code point is valid for `String.fromCodePoint`.
 * Rejects zero, values above the Unicode max (U+10FFFF), and the UTF-16
 * surrogate range (U+D800–U+DFFF) which would cause `fromCodePoint` to
 * throw a `RangeError`.
 */
function isValidCodePoint(n: number): boolean {
  return n > 0 && n <= 0x10FFFF && (n < 0xD800 || n > 0xDFFF);
}

/**
 * Regex matching any `&...;` entity — named (e.g. `&amp;`, `&mdash;`),
 * decimal numeric (e.g. `&#123;`), and hex numeric (e.g. `&#x1F4A9;`).
 *
 * Uses a broad `&[a-zA-Z]+;` pattern for named entities instead of a
 * hardcoded alternation, so any named entity is captured and looked up
 * in the HTML_ENTITIES table. Unknown names pass through unchanged.
 */
const ALL_ENTITY_RE = /&(?:#\d+|#x[0-9a-fA-F]+|[a-zA-Z]\w*);/gi;

/**
 * Decode HTML entities — named, decimal numeric (`&#NNN;`), and hex
 * numeric (`&#xHHH;`). Named entities are looked up in the HTML_ENTITIES
 * table; unknown names pass through unchanged. Numeric entities are
 * decoded via `String.fromCodePoint`.
 */
function decodeHtmlEntities(text: string): string {
  return text.replace(ALL_ENTITY_RE, (entity) => {
    // Named entity (case-insensitive lookup via lowercased key)
    const named = HTML_ENTITIES[entity.toLowerCase()];
    if (named) return named;

    // Decimal numeric entity: &#NNN;
    if (entity.startsWith("&#") && !entity.startsWith("&#x") && !entity.startsWith("&#X")) {
      const n = parseInt(entity.slice(2, -1), 10);
      // Return the original entity unchanged for invalid code points instead
      // of returning "". Previously, invalid numeric entities like `&#0;`,
      // `&#xD800;`, or `&#x110000;` were silently removed from the output
      // (replaced with empty string), which could corrupt search result
      // titles and web page text — characters adjacent to the entity would
      // be unexpectedly joined. Returning the original entity text is
      // consistent with how unknown named entities are handled (also passed
      // through unchanged) and preserves the input string's length/structure.
      return isValidCodePoint(n) ? String.fromCodePoint(n) : entity;
    }

    // Hex numeric entity: &#xHHH;
    if (entity.startsWith("&#x") || entity.startsWith("&#X")) {
      const n = parseInt(entity.slice(3, -1), 16);
      return isValidCodePoint(n) ? String.fromCodePoint(n) : entity;
    }

    return entity;
  });
}

// ── HTML Stripping ───────────────────────────────────────────────────────────

/**
 * Pre-compiled regex patterns for HTML stripping.  Previously these were
 * literal regexes inside `stripHtml()`, causing the engine to recompile 8
 * patterns on every call.  Since the patterns are static, hoisting them to
 * module scope compiles them once at import time — the same approach used
 * for `ALL_ENTITY_RE` above.
 */
const RE_SCRIPT_BLOCK = /<script\b[^>]*>[\s\S]*?<\/script>/gi;
const RE_STYLE_BLOCK = /<style\b[^>]*>[\s\S]*?<\/style>/gi;
/**
 * Remove the entire `<head>` section. The `<head>` block contains metadata
 * (`<meta>`, `<link>`, `<title>`), CSS (`<style>`), tracking scripts, and
 * JSON-LD structured data (`<script type="application/ld+json">`). When we
 * strip tags, the *text content* inside these elements survives as noise —
 * meta descriptions appear as duplicate paragraphs, JSON-LD produces raw
 * schema.org property names and values, and `<title>` duplicates the visible
 * heading. Typical savings: 200–2000 noise characters per page. The `<head>`
 * block is always before `<body>` and never contains user-visible content,
 * so removing it entirely is safe and reduces token waste.
 */
const RE_HEAD_BLOCK = /<head\b[^>]*>[\s\S]*?<\/head>/gi;
/**
 * Remove `<noscript>` blocks entirely. These contain duplicate or fallback
 * content for browsers with JavaScript disabled.  When we strip tags, the
 * noscript content survives as plain text, producing duplicated paragraphs
 * and headings that waste tokens.  Common on news/docs sites that render
 * primary content with JS and replicate it inside `<noscript>` for SEO.
 */
const RE_NOSCRIPT_BLOCK = /<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi;
/**
 * Remove inline `<svg>` blocks entirely.  SVG markup contains coordinate
 * data, path definitions (`d="M10 80 C 40 10..."`), and presentational
 * attributes that are meaningless as text.  Without removal, a page with
 * icons, charts, or illustrations can add thousands of noise characters.
 */
const RE_SVG_BLOCK = /<svg\b[^>]*>[\s\S]*?<\/svg>/gi;
/**
 * Remove `<template>` blocks entirely. These contain shadow DOM fragments
 * used by Web Components and frameworks (Vue, Angular, Lit, Polymer). The
 * content inside `<template>` is not rendered by browsers but survives tag
 * stripping as plain text — producing duplicate boilerplate content (often
 * copies of the page's visible elements, placeholder text like `{{variable}}`,
 * or component slot markup). Common on documentation sites, component
 * libraries, and SPAs that embed templates for client-side rendering.
 */
const RE_TEMPLATE_BLOCK = /<template\b[^>]*>[\s\S]*?<\/template>/gi;
/**
 * Remove `<iframe>` blocks entirely. Iframes embed external pages or inline
 * HTML documents whose content is not useful as extracted text. After tag
 * stripping, iframe fallback content (e.g., "Your browser does not support
 * iframes") or inline srcdoc HTML survives as noise text. Iframes are also
 * commonly used for tracking pixels, ad containers, and social media embeds
 * whose text content is ads/tracking noise. Sites like documentation pages
 * and blog posts frequently embed iframes for code playgrounds, videos, and
 * third-party widgets — their fallback text wastes tokens without adding
 * useful information.
 */
const RE_IFRAME_BLOCK = /<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi;
/**
 * Remove `<form>` blocks entirely. Forms contain `<input>`, `<select>`,
 * `<option>`, `<label>`, `<textarea>`, and `<button>` elements whose text
 * content survives tag stripping as noise — producing fragments like
 * "Username Password Submit Remember me Sign up for newsletter Enter your
 * email". Login forms, search bars, comment boxes, and newsletter signups
 * are ubiquitous on web pages and collectively add hundreds of noise
 * characters. The form's functional purpose (accepting user input) is
 * meaningless in an extracted-text context, and any useful information
 * near the form (e.g., a heading like "Contact Us") is typically outside
 * the `<form>` element and preserved.
 */
const RE_FORM_BLOCK = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
/**
 * Remove `<nav>` blocks entirely. Navigation menus produce long runs of link
 * text like "Home About Products Services Blog Contact Pricing FAQ" that
 * waste tokens without contributing useful content to the extracted page.
 * On modern sites, `<nav>` is the standard semantic element for primary and
 * secondary navigation (MDN, W3C, Bootstrap, etc.), and its contents are
 * almost entirely duplicated across every page on the site — meaning the
 * token cost is per-fetch with zero marginal information gain.
 *
 * For pages where the model specifically needs to enumerate nav links (e.g.,
 * discovering available pages on a site), the user can instruct the model
 * to parse the raw HTML directly via Bash + curl, bypassing stripHtml.
 */
const RE_NAV_BLOCK = /<nav\b[^>]*>[\s\S]*?<\/nav>/gi;
/**
 * Remove `<footer>` blocks entirely. Page footers contain copyright notices
 * ("© 2024 Company Inc."), secondary navigation duplicating `<nav>`, social
 * media icon text ("Follow us on Twitter Facebook LinkedIn"), cookie consent
 * banners, legal disclaimers, and "powered by" attributions — all noise that
 * wastes tokens without contributing useful page content. The HTML5 `<footer>`
 * element is used consistently across modern sites for this purpose (MDN,
 * Bootstrap, WordPress themes, etc.). Unlike `<nav>`, footers also accumulate
 * address/phone/contact info that was already visible in the page body.
 *
 * Note: `<footer>` inside `<article>` is also stripped. Per the spec, article
 * footers contain author bio, published date, and related links — minor
 * metadata that rarely adds value to the extracted text. If needed, the model
 * can use Bash + curl to get the raw HTML.
 */
const RE_FOOTER_BLOCK = /<footer\b[^>]*>[\s\S]*?<\/footer>/gi;
/**
 * Remove `<aside>` blocks entirely. Sidebars and tangential content wrapped
 * in `<aside>` (per HTML5 spec: "content tangentially related to the content
 * around it") include: related article lists, social sharing widgets,
 * advertising containers, newsletter signup CTAs, author bios, tag clouds,
 * table-of-contents insets, and "trending now" sections. After tag stripping,
 * these produce runs of link text and promotional copy that push the actual
 * page content further into the token budget. On documentation and blog sites,
 * sidebars can add 500–2000 noise characters per page.
 */
const RE_ASIDE_BLOCK = /<aside\b[^>]*>[\s\S]*?<\/aside>/gi;
const RE_HTML_COMMENT = /<!--[\s\S]*?-->/g;
const RE_BLOCK_ELEMENT = /<\/?(p|div|br|h[1-6]|li|tr|blockquote|pre|hr)\b[^>]*\/?>/gi;
const RE_ANY_TAG = /<[^>]+>/g;
const RE_HORIZ_WHITESPACE = /[ \t]+/g;
const RE_BLANK_LINE = /\n[ \t]*\n/g;
const RE_EXCESS_NEWLINES = /\n{3,}/g;

/**
 * Basic HTML-to-text conversion. Removes head/script/style/noscript/svg/template/iframe/form/nav/footer/aside
 * blocks, strips tags, decodes entities (via the shared `decodeHtmlEntities`), and
 * collapses excessive whitespace.
 */
function stripHtml(html: string): string {
  let text = html;

  // Remove head, script, style, noscript, svg, template, and iframe blocks entirely
  // (including contents). Reset lastIndex before each use — these regexes use the `g`
  // flag, which makes them stateful: `lastIndex` persists between calls on
  // the same regex object.  Without resetting, a previous invocation that
  // ended mid-match (e.g., no more matches but lastIndex > 0) would cause
  // the next invocation to start scanning partway through the string,
  // silently skipping early blocks.
  //
  // <head> is removed first: it contains <style> and <script> blocks that
  // would otherwise be matched individually, plus <meta>/<link>/<title>
  // elements whose text content would survive as noise after tag stripping.
  RE_HEAD_BLOCK.lastIndex = 0;
  text = text.replace(RE_HEAD_BLOCK, "");
  RE_SCRIPT_BLOCK.lastIndex = 0;
  text = text.replace(RE_SCRIPT_BLOCK, "");
  RE_STYLE_BLOCK.lastIndex = 0;
  text = text.replace(RE_STYLE_BLOCK, "");
  RE_NOSCRIPT_BLOCK.lastIndex = 0;
  text = text.replace(RE_NOSCRIPT_BLOCK, "");
  RE_SVG_BLOCK.lastIndex = 0;
  text = text.replace(RE_SVG_BLOCK, "");
  RE_TEMPLATE_BLOCK.lastIndex = 0;
  text = text.replace(RE_TEMPLATE_BLOCK, "");
  RE_IFRAME_BLOCK.lastIndex = 0;
  text = text.replace(RE_IFRAME_BLOCK, "");
  RE_FORM_BLOCK.lastIndex = 0;
  text = text.replace(RE_FORM_BLOCK, "");
  RE_NAV_BLOCK.lastIndex = 0;
  text = text.replace(RE_NAV_BLOCK, "");
  RE_FOOTER_BLOCK.lastIndex = 0;
  text = text.replace(RE_FOOTER_BLOCK, "");
  RE_ASIDE_BLOCK.lastIndex = 0;
  text = text.replace(RE_ASIDE_BLOCK, "");

  // Remove HTML comments
  RE_HTML_COMMENT.lastIndex = 0;
  text = text.replace(RE_HTML_COMMENT, "");

  // Replace block-level elements with newlines for readability
  RE_BLOCK_ELEMENT.lastIndex = 0;
  text = text.replace(RE_BLOCK_ELEMENT, "\n");

  // Strip all remaining HTML tags
  RE_ANY_TAG.lastIndex = 0;
  text = text.replace(RE_ANY_TAG, "");

  // Decode all HTML entities (named + numeric) using the shared helper
  text = decodeHtmlEntities(text);

  // Collapse runs of whitespace/blank lines into at most two newlines
  RE_HORIZ_WHITESPACE.lastIndex = 0;
  text = text.replace(RE_HORIZ_WHITESPACE, " ");
  RE_BLANK_LINE.lastIndex = 0;
  text = text.replace(RE_BLANK_LINE, "\n\n");
  RE_EXCESS_NEWLINES.lastIndex = 0;
  text = text.replace(RE_EXCESS_NEWLINES, "\n\n");

  return text.trim();
}
