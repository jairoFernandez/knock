const ESC: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESC[c]);
}

function span(cls: string, text: string): string {
  return `<span class="tok-${cls}">${escapeHtml(text)}</span>`;
}

export function highlightToml(src: string): string {
  const lines = src.split("\n");
  return lines.map(highlightLine).join("\n");
}

function highlightLine(line: string): string {
  const trimmed = line.trimStart();
  const indent = line.slice(0, line.length - trimmed.length);

  if (trimmed.startsWith("#")) {
    return escapeHtml(indent) + span("comment", trimmed);
  }

  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end > 0) {
      const header = trimmed.slice(0, end + 1);
      const rest = trimmed.slice(end + 1);
      return escapeHtml(indent) + span("header", header) + highlightTrailing(rest);
    }
  }

  const eq = findEquals(trimmed);
  if (eq >= 0) {
    const key = trimmed.slice(0, eq).trimEnd();
    const keyTrail = trimmed.slice(key.length, eq);
    const value = trimmed.slice(eq + 1);
    return (
      escapeHtml(indent) +
      highlightKey(key) +
      escapeHtml(keyTrail) +
      span("punct", "=") +
      highlightValue(value)
    );
  }

  return escapeHtml(line);
}

function highlightKey(key: string): string {
  // dotted key support
  const parts = key.split(/(\.)/);
  return parts
    .map((p) => (p === "." ? span("punct", ".") : span("key", p)))
    .join("");
}

function findEquals(s: string): number {
  let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "#") return -1;
    if (c === "=") return i;
  }
  return -1;
}

function highlightValue(raw: string): string {
  // split off trailing comment
  let body = raw;
  let comment = "";
  let inStr: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (inStr) {
      if (c === "\\") { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "#") {
      body = raw.slice(0, i);
      comment = raw.slice(i);
      break;
    }
  }

  return highlightValueBody(body) + (comment ? span("comment", comment) : "");
}

function highlightValueBody(raw: string): string {
  let out = "";
  let i = 0;
  // leading whitespace
  while (i < raw.length && (raw[i] === " " || raw[i] === "\t")) {
    out += raw[i++];
  }
  while (i < raw.length) {
    const c = raw[i];
    if (c === '"' || c === "'") {
      const start = i;
      const quote = c;
      i++;
      while (i < raw.length) {
        if (raw[i] === "\\" && quote === '"') { i += 2; continue; }
        if (raw[i] === quote) { i++; break; }
        i++;
      }
      out += span("string", raw.slice(start, i));
      continue;
    }
    if (c === "{" || c === "}" || c === "[" || c === "]" || c === "," || c === ":") {
      out += span("punct", c);
      i++;
      continue;
    }
    // number / bool / date / bareword
    const rest = raw.slice(i);
    const m = rest.match(/^[A-Za-z0-9_\-+.:]+/);
    if (m) {
      const tok = m[0];
      let cls = "ident";
      if (/^(true|false)$/.test(tok)) cls = "bool";
      else if (/^[+-]?(\d[\d_]*)(\.\d[\d_]*)?([eE][+-]?\d+)?$/.test(tok)) cls = "number";
      else if (/^\d{4}-\d{2}-\d{2}/.test(tok)) cls = "number";
      else if (/^(nan|inf|[+-]inf|[+-]nan)$/.test(tok)) cls = "number";
      out += span(cls, tok);
      i += tok.length;
      continue;
    }
    out += escapeHtml(c);
    i++;
  }
  return out;
}

function highlightTrailing(rest: string): string {
  const idx = rest.indexOf("#");
  if (idx >= 0) {
    return escapeHtml(rest.slice(0, idx)) + span("comment", rest.slice(idx));
  }
  return escapeHtml(rest);
}
