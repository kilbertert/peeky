/*
 * Tiny, dependency-free, XSS-safe Markdown renderer for the mascot bubble.
 *
 * Why hand-rolled: the bubble shows short model output and we don't want to pull
 * a markdown + sanitizer dependency into an open-source, offline-friendly app.
 *
 * Safety model: EVERY piece of source text is HTML-escaped FIRST, and the only
 * tags ever emitted are a fixed, safe set (p / strong / em / code / pre / ul /
 * ol / li / del / blockquote / span). The model's text can therefore never
 * inject markup or scripts. Links are rendered as styled text WITHOUT an href so
 * a stray link can't navigate the privileged webview.
 *
 * It is intentionally lenient with partial input (it runs every typewriter tick
 * on a half-streamed string), so it never throws — worst case it under-formats.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** Inline spans. Input is ALREADY html-escaped; we only add safe tags. */
function inline(s: string): string {
  // `code` first so other rules don't touch its contents.
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => `<code>${c}</code>`);
  // **bold** / __bold__
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  // *italic* / _italic_ (guard the preceding char so we don't eat bold markers)
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[^_\w])_([^_\s][^_]*?)_/g, "$1<em>$2</em>");
  // ~~strikethrough~~
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // [label](url) -> styled, non-navigating text
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<span class="md-link">$1</span>');
  return s;
}

/** Render a (possibly partial) markdown string to a safe HTML string. */
export function renderMarkdown(src: string): string {
  if (!src) return "";
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let inCode = false;
  let codeBuf: string[] = [];
  let listType: "ul" | "ol" | null = null;

  const closeList = (): void => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };
  const flushCode = (): void => {
    out.push(`<pre><code>${escapeHtml(codeBuf.join("\n"))}</code></pre>`);
    codeBuf = [];
  };

  for (const line of lines) {
    const fence = /^\s*```/.test(line);
    if (fence) {
      if (!inCode) {
        closeList();
        inCode = true;
        codeBuf = [];
      } else {
        flushCode();
        inCode = false;
      }
      continue;
    }
    if (inCode) {
      codeBuf.push(line);
      continue;
    }

    if (/^\s*$/.test(line)) {
      closeList();
      continue;
    }

    const h = line.match(/^\s*(#{1,4})\s+(.*)$/);
    if (h) {
      closeList();
      out.push(`<div class="md-h md-h${h[1].length}">${inline(escapeHtml(h[2]))}</div>`);
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      closeList();
      out.push(`<blockquote>${inline(escapeHtml(quote[1]))}</blockquote>`);
      continue;
    }

    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const want: "ul" | "ol" = ul ? "ul" : "ol";
      if (listType !== want) {
        closeList();
        listType = want;
        out.push(`<${want}>`);
      }
      out.push(`<li>${inline(escapeHtml((ul ? ul[1] : (ol as RegExpMatchArray)[1])))}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${inline(escapeHtml(line))}</p>`);
  }

  if (inCode) flushCode();
  closeList();
  return out.join("");
}
