import { useMemo } from "react";
import { CopyButton, HistoryList, useHistory, usePersistedField } from "./shared";

type Mode = "curl-to-toml" | "toml-to-curl";

export function CurlTool() {
  const [mode, setMode] = usePersistedField<Mode>("knock.tools.curl.mode", "curl-to-toml");
  const [input, setInput] = usePersistedField<string>("knock.tools.curl.input", "");
  const history = useHistory("knock.tools.curl.history");

  const output = useMemo(() => {
    if (!input.trim()) return "";
    try {
      if (mode === "curl-to-toml") return curlToToml(input);
      return tomlToCurl(input);
    } catch (e) {
      return `Error: ${String(e)}`;
    }
  }, [input, mode]);

  return (
    <>
      <div className="tools-tabs">
        {(["curl-to-toml", "toml-to-curl"] as Mode[]).map((m) => (
          <button key={m} className={mode === m ? "active" : ""} onClick={() => setMode(m)}>
            {m}
          </button>
        ))}
      </div>
      <label className="tools-label">Input</label>
      <textarea
        className="tools-textarea tools-textarea-tall"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onBlur={() => history.push(mode, input)}
        placeholder={mode === "curl-to-toml" ? "curl https://api.example.com ..." : "[request]\nmethod = \"GET\"\nurl = \"...\""}
        spellCheck={false}
      />
      <div className="tools-output-header">
        <span>Knock request (TOML)</span>
        <CopyButton text={output} />
      </div>
      <textarea className="tools-textarea tools-output tools-textarea-tall" value={output} readOnly spellCheck={false} />
      <HistoryList history={history} onPick={setInput} />
    </>
  );
}

function tokenize(s: string): string[] {
  // Collapse line continuations and quote-aware split
  const cleaned = s.replace(/\\\r?\n/g, " ").trim();
  const out: string[] = [];
  let i = 0;
  while (i < cleaned.length) {
    const c = cleaned[i];
    if (c === " " || c === "\t" || c === "\n") {
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      const quote = c;
      i++;
      let buf = "";
      while (i < cleaned.length && cleaned[i] !== quote) {
        if (cleaned[i] === "\\" && quote === '"' && i + 1 < cleaned.length) {
          buf += cleaned[i + 1];
          i += 2;
        } else {
          buf += cleaned[i++];
        }
      }
      i++;
      out.push(buf);
    } else {
      let buf = "";
      while (i < cleaned.length && !/\s/.test(cleaned[i])) {
        if (cleaned[i] === "\\" && i + 1 < cleaned.length) {
          buf += cleaned[i + 1];
          i += 2;
        } else {
          buf += cleaned[i++];
        }
      }
      out.push(buf);
    }
  }
  return out;
}

function curlToToml(curl: string): string {
  const tokens = tokenize(curl);
  if (tokens[0] !== "curl") tokens.unshift("curl"); // tolerate missing prefix
  let url = "";
  let method = "GET";
  const headers: Record<string, string> = {};
  const queries: { key: string; value: string }[] = [];
  let body: string | null = null;
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === "-X" || t === "--request") {
      method = tokens[++i] ?? "GET";
    } else if (t === "-H" || t === "--header") {
      const h = tokens[++i] ?? "";
      const idx = h.indexOf(":");
      if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
    } else if (t === "-d" || t === "--data" || t === "--data-raw" || t === "--data-binary") {
      body = tokens[++i] ?? "";
      if (method === "GET") method = "POST";
    } else if (t === "--data-urlencode") {
      const v = tokens[++i] ?? "";
      const idx = v.indexOf("=");
      if (idx > 0) queries.push({ key: v.slice(0, idx), value: v.slice(idx + 1) });
      else body = (body ?? "") + v;
    } else if (t === "-u" || t === "--user") {
      const v = tokens[++i] ?? "";
      headers["Authorization"] = "Basic " + btoa(v);
    } else if (t === "-A" || t === "--user-agent") {
      headers["User-Agent"] = tokens[++i] ?? "";
    } else if (t === "-e" || t === "--referer") {
      headers["Referer"] = tokens[++i] ?? "";
    } else if (t === "-b" || t === "--cookie") {
      headers["Cookie"] = tokens[++i] ?? "";
    } else if (t.startsWith("--")) {
      // skip unknown long flags with value if next looks like value
      if (i + 1 < tokens.length && !tokens[i + 1].startsWith("-")) i++;
    } else if (t.startsWith("-") && t.length > 1) {
      // single-letter flag; consume value if needed
    } else if (!url) {
      url = t;
    }
    i++;
  }

  const lines: string[] = [];
  lines.push("[request]");
  lines.push(`method = "${method}"`);
  lines.push(`url = ${JSON.stringify(url)}`);
  if (Object.keys(headers).length) {
    lines.push("");
    lines.push("[headers]");
    for (const [k, v] of Object.entries(headers)) {
      lines.push(`${tomlKey(k)} = ${JSON.stringify(v)}`);
    }
  }
  if (queries.length) {
    lines.push("");
    lines.push("[query]");
    for (const q of queries) {
      lines.push(`${tomlKey(q.key)} = ${JSON.stringify(q.value)}`);
    }
  }
  if (body !== null) {
    lines.push("");
    lines.push("[body]");
    // try JSON
    try {
      const obj = JSON.parse(body);
      lines.push("type = \"json\"");
      lines.push(`value = '''${JSON.stringify(obj, null, 2)}'''`);
    } catch {
      lines.push("type = \"raw\"");
      lines.push(`value = ${JSON.stringify(body)}`);
    }
  }
  return lines.join("\n");
}

function tomlKey(k: string): string {
  if (/^[A-Za-z0-9_-]+$/.test(k)) return k;
  return JSON.stringify(k);
}

function tomlToCurl(toml: string): string {
  // Very simple TOML parse (request + headers + query + body sections)
  const sections: Record<string, Record<string, string>> = {};
  let cur = "";
  const lines = toml.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) {
      i++;
      continue;
    }
    const sec = line.match(/^\[([^\]]+)\]$/);
    if (sec) {
      cur = sec[1];
      sections[cur] = sections[cur] ?? {};
      i++;
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_-]+|"[^"]+")\s*=\s*(.+)$/);
    if (kv) {
      const key = kv[1].replace(/^"|"$/g, "");
      let val = kv[2];
      if (val.startsWith("'''")) {
        let buf = val.slice(3);
        while (!buf.endsWith("'''") && i + 1 < lines.length) {
          i++;
          buf += "\n" + lines[i];
        }
        val = buf.slice(0, -3);
      } else if (val.startsWith('"')) {
        try {
          val = JSON.parse(val);
        } catch {
          /* keep */
        }
      }
      sections[cur][key] = val;
    }
    i++;
  }
  const req = sections["request"] ?? {};
  const method = (req.method ?? "GET").toUpperCase();
  const url = req.url ?? "";
  const parts = [`curl -X ${method} ${shellQuote(url)}`];
  for (const [k, v] of Object.entries(sections["headers"] ?? {})) {
    parts.push(`-H ${shellQuote(`${k}: ${v}`)}`);
  }
  const body = sections["body"]?.value;
  if (body) parts.push(`--data ${shellQuote(body)}`);
  return parts.join(" \\\n  ");
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
