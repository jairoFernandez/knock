// Minimal JSON path selector.
// Supports tokens separated by '.':
//   foo        -> property
//   *          -> any property (object) or any index (array)
//   **         -> recursive descent (zero or more levels)
//   foo[2]     -> index access (also bare [2])
//   foo[*]     -> any index
// Pattern is matched against the *whole* path from the root.
// Returns array of { path, value }.

export type JsonMatch = { path: string; value: unknown };

type Token = { kind: "key"; name: string } | { kind: "wild" } | { kind: "recurse" } | { kind: "index"; idx: number } | { kind: "indexWild" };

function tokenize(pattern: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const s = pattern.trim();
  if (s === "" || s === "$" || s === ".") return out;
  let cur = s.startsWith("$.") ? s.slice(2) : s.startsWith("$") ? s.slice(1) : s;
  while (i < cur.length) {
    const ch = cur[i];
    if (ch === ".") {
      i++;
      if (cur[i] === ".") {
        out.push({ kind: "recurse" });
        i++;
      }
      continue;
    }
    if (ch === "[") {
      const end = cur.indexOf("]", i);
      if (end === -1) throw new Error("unclosed [");
      const inner = cur.slice(i + 1, end).trim();
      if (inner === "*") out.push({ kind: "indexWild" });
      else if (/^-?\d+$/.test(inner)) out.push({ kind: "index", idx: parseInt(inner, 10) });
      else out.push({ kind: "key", name: inner.replace(/^['"]|['"]$/g, "") });
      i = end + 1;
      continue;
    }
    if (ch === "*") {
      if (cur[i + 1] === "*") {
        out.push({ kind: "recurse" });
        i += 2;
      } else {
        out.push({ kind: "wild" });
        i++;
      }
      continue;
    }
    let j = i;
    while (j < cur.length && cur[j] !== "." && cur[j] !== "[" && cur[j] !== "*") j++;
    const name = cur.slice(i, j);
    if (name) out.push({ kind: "key", name });
    i = j;
  }
  return out;
}

function match(tokens: Token[], ti: number, value: unknown, path: string, out: JsonMatch[]): void {
  if (ti >= tokens.length) {
    out.push({ path: path || "$", value });
    return;
  }
  const tok = tokens[ti];
  if (tok.kind === "recurse") {
    // Match zero or more steps. Try advancing without consuming.
    match(tokens, ti + 1, value, path, out);
    if (Array.isArray(value)) {
      value.forEach((v, idx) => match(tokens, ti, v, `${path}[${idx}]`, out));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        match(tokens, ti, v, path ? `${path}.${k}` : k, out);
      }
    }
    return;
  }
  if (tok.kind === "wild") {
    if (Array.isArray(value)) {
      value.forEach((v, idx) => match(tokens, ti + 1, v, `${path}[${idx}]`, out));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        match(tokens, ti + 1, v, path ? `${path}.${k}` : k, out);
      }
    }
    return;
  }
  if (tok.kind === "indexWild") {
    if (Array.isArray(value)) {
      value.forEach((v, idx) => match(tokens, ti + 1, v, `${path}[${idx}]`, out));
    }
    return;
  }
  if (tok.kind === "index") {
    if (Array.isArray(value) && tok.idx >= 0 && tok.idx < value.length) {
      match(tokens, ti + 1, value[tok.idx], `${path}[${tok.idx}]`, out);
    }
    return;
  }
  // key
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (tok.name in obj) {
      match(tokens, ti + 1, obj[tok.name], path ? `${path}.${tok.name}` : tok.name, out);
    }
  }
}

export function selectJson(root: unknown, pattern: string): JsonMatch[] {
  const tokens = tokenize(pattern);
  if (tokens.length === 0) return [{ path: "$", value: root }];
  const out: JsonMatch[] = [];
  match(tokens, 0, root, "", out);
  return out;
}
