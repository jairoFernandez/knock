// Markdown → HTML for the notes preview: GFM, highlighted code blocks and
// masked secrets. The output still has to go through DOMPurify (the view does
// it; this module stays DOM-free so it can be unit-tested in node).
//
// Secrets: `||value||` inline, or a ```secret fenced block. They render masked
// with Show / Copy buttons, so the value can be copied without ever being on
// screen (screen sharing).

import hljs from "highlight.js/lib/common";
import { Marked, type Tokens } from "marked";

const MASK = "••••••••";

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function secretButtons(): string {
  return (
    '<button type="button" class="note-secret-btn" data-secret-action="reveal">Show</button>' +
    '<button type="button" class="note-secret-btn" data-secret-action="copy">Copy</button>'
  );
}

function inlineSecret(value: string): string {
  return (
    '<span class="note-secret">' +
    `<span class="note-secret-mask">${MASK}</span>` +
    `<span class="note-secret-value">${escapeHtml(value)}</span>` +
    secretButtons() +
    "</span>"
  );
}

function blockSecret(value: string): string {
  const lines = value.split("\n").length;
  return (
    '<div class="note-secret note-secret-block">' +
    `<span class="note-secret-mask">${MASK}${lines > 1 ? ` <em>${lines} lines</em>` : ""}</span>` +
    secretButtons() +
    `<pre class="note-secret-value"><code>${escapeHtml(value)}</code></pre>` +
    "</div>"
  );
}

/** Highlighted HTML for `code`, escaped plain text when the language is unknown. */
export function highlightCode(code: string, lang: string): string {
  if (lang && hljs.getLanguage(lang)) {
    try {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      // fall through to plain text
    }
  }
  return escapeHtml(code);
}

function codeBlock({ text, lang }: Tokens.Code): string {
  const language = (lang ?? "").trim().split(/\s+/)[0].toLowerCase();
  if (language === "secret") return blockSecret(text);
  const safeLang = language.replace(/[^\w+#-]/g, "");
  const label = safeLang ? `<span class="note-code-lang">${escapeHtml(safeLang)}</span>` : "<span></span>";
  return (
    '<div class="note-code">' +
    `<div class="note-code-head">${label}` +
    '<button type="button" class="note-code-copy" data-code-action="copy">Copy</button></div>' +
    `<pre><code class="hljs${safeLang ? ` language-${safeLang}` : ""}">${highlightCode(text, safeLang)}</code></pre>` +
    "</div>\n"
  );
}

const notesMarked = new Marked(
  { gfm: true },
  {
    renderer: { code: codeBlock },
    extensions: [
      {
        name: "secret",
        level: "inline",
        start(src: string) {
          const i = src.indexOf("||");
          return i < 0 ? undefined : i;
        },
        tokenizer(src: string) {
          const m = /^\|\|([^|\n]+?)\|\|/.exec(src);
          if (m) return { type: "secret", raw: m[0], text: m[1] };
          return undefined;
        },
        renderer(token) {
          return inlineSecret(String(token.text ?? ""));
        },
      },
    ],
  },
);

export function markdownToHtml(src: string): string {
  return notesMarked.parse(src, { async: false }) as string;
}
