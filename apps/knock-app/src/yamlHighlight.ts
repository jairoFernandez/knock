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
  return `<span class="yml-${cls}">${escapeHtml(text)}</span>`;
}

export function highlightYaml(src: string): string {
  return src.split("\n").map(highlightLine).join("\n");
}

const BOOL_RE = /^(true|false|yes|no|on|off|null|~)$/i;
const NUM_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

function highlightLine(line: string): string {
  const trimmed = line.trimStart();
  const indent = line.slice(0, line.length - trimmed.length);
  const indentHtml = escapeHtml(indent);

  // Document marker
  if (trimmed === "---" || trimmed === "...") {
    return indentHtml + span("doc", trimmed);
  }

  // Comment line
  if (trimmed.startsWith("#")) {
    return indentHtml + span("comment", trimmed);
  }

  // List bullet
  let rest = trimmed;
  let bullet = "";
  if (rest.startsWith("- ") || rest === "-") {
    bullet = span("punct", "-");
    rest = rest.slice(1).trimStart();
    if (rest.length === 0) return indentHtml + bullet;
    // recurse-ish: re-call key/scalar logic below on rest, prefixing bullet+space
    const sub = highlightAfterBullet(rest);
    return indentHtml + bullet + " " + sub;
  }

  return indentHtml + highlightAfterBullet(rest);
}

function highlightAfterBullet(rest: string): string {
  // try key: value
  const m = matchKey(rest);
  if (m) {
    const { key, sep, value, trailing } = m;
    return (
      span("key", key) +
      span("punct", sep) +
      (value.length ? " " + highlightValue(value) : "") +
      highlightTrailing(trailing)
    );
  }
  return highlightValue(rest);
}

interface KeyMatch {
  key: string;
  sep: string;
  value: string;
  trailing: string;
}

function matchKey(line: string): KeyMatch | null {
  // key is unquoted [^:#]+ or "quoted" / 'quoted'
  let i = 0;
  let key = "";
  if (line[0] === '"' || line[0] === "'") {
    const q = line[0];
    i = 1;
    while (i < line.length && line[i] !== q) i++;
    if (line[i] !== q) return null;
    key = line.slice(0, i + 1);
    i++;
  } else {
    while (i < line.length) {
      const c = line[i];
      if (c === ":" && (i + 1 >= line.length || line[i + 1] === " " || line[i + 1] === "\t")) {
        break;
      }
      if (c === "#") return null;
      i++;
    }
    if (i === 0 || line[i] !== ":") return null;
    key = line.slice(0, i);
  }
  if (line[i] !== ":") return null;
  const sep = ":";
  let j = i + 1;
  while (j < line.length && (line[j] === " " || line[j] === "\t")) j++;
  // value runs until trailing comment
  const hash = findUnquotedHash(line, j);
  const valueEnd = hash === -1 ? line.length : hash;
  const value = line.slice(j, valueEnd).trimEnd();
  const trailing = hash === -1 ? "" : line.slice(hash);
  return { key, sep, value, trailing };
}

function findUnquotedHash(line: string, from: number): number {
  let quoted: '"' | "'" | null = null;
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === quoted) quoted = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quoted = c;
      continue;
    }
    if (c === "#" && (i === 0 || line[i - 1] === " " || line[i - 1] === "\t")) return i;
  }
  return -1;
}

function highlightTrailing(rest: string): string {
  if (!rest) return "";
  // leading whitespace + #comment
  const ws = rest.match(/^\s*/)?.[0] ?? "";
  const tail = rest.slice(ws.length);
  if (tail.startsWith("#")) return escapeHtml(ws) + span("comment", tail);
  return escapeHtml(rest);
}

function highlightValue(v: string): string {
  if (!v) return "";
  // flow collections rough pass: [a, b] / {a: b}
  if (v.startsWith("&") || v.startsWith("*")) {
    const m = v.match(/^([&*])([A-Za-z0-9_\-]+)(.*)$/);
    if (m) return span("anchor", m[1] + m[2]) + (m[3] ? " " + highlightValue(m[3].trimStart()) : "");
  }
  if (v.startsWith("!")) {
    const m = v.match(/^(![^\s]*)(.*)$/);
    if (m) return span("tag", m[1]) + (m[2] ? " " + highlightValue(m[2].trimStart()) : "");
  }
  if (v[0] === '"' || v[0] === "'") {
    // crude string match to closing quote (may include escapes)
    const q = v[0];
    let i = 1;
    while (i < v.length) {
      if (v[i] === "\\" && q === '"') {
        i += 2;
        continue;
      }
      if (v[i] === q) {
        i++;
        break;
      }
      i++;
    }
    return span("string", v.slice(0, i)) + escapeHtml(v.slice(i));
  }
  if (v === "|" || v === ">" || v.startsWith("|") || v.startsWith(">")) {
    return span("block", v);
  }
  if (BOOL_RE.test(v)) {
    if (/^(null|~)$/i.test(v)) return span("null", v);
    return span("bool", v);
  }
  if (NUM_RE.test(v)) return span("number", v);
  return span("scalar", v);
}
