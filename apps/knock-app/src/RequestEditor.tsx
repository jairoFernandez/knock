import { useMemo, useState } from "react";
import { TemplatedInput } from "./TemplatedInput";
import { KVTable } from "./KVTable";
import { BodyTab } from "./BodyTab";
import { hasUnresolvedVars, interpolate } from "./interpolate";
import type { RequestForm } from "./types";

interface Props {
  form: RequestForm;
  vars: Record<string, string>;
  running: boolean;
  onChange: (next: RequestForm) => void;
  onSend: () => void;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

type Tab = "params" | "body" | "headers" | "use";

function methodClass(method: string): string {
  const m = method.toUpperCase();
  if (m === "GET") return "method-get";
  if (m === "POST") return "method-post";
  if (m === "PUT") return "method-put";
  if (m === "PATCH") return "method-patch";
  if (m === "DELETE") return "method-delete";
  if (m === "HEAD" || m === "OPTIONS") return "method-head";
  return "method-any";
}

export function RequestEditor({ form, vars, running, onChange, onSend }: Props) {
  const [tab, setTab] = useState<Tab>("params");

  const fullUrl = useMemo(() => {
    let base = interpolate(form.url, vars);
    const params = form.query.filter((q) => q.key.trim() !== "");
    if (params.length === 0) return base;
    const qs = params
      .map(
        (q) =>
          `${encodeURIComponent(interpolate(q.key, vars))}=${encodeURIComponent(interpolate(q.value, vars))}`,
      )
      .join("&");
    base += base.includes("?") ? `&${qs}` : `?${qs}`;
    return base;
  }, [form.url, form.query, vars]);

  const urlUnresolved = useMemo(
    () =>
      hasUnresolvedVars(form.url, vars) ||
      form.query.some(
        (q) => hasUnresolvedVars(q.key, vars) || hasUnresolvedVars(q.value, vars),
      ),
    [form.url, form.query, vars],
  );

  return (
    <div className="request-editor">
      {form.openapi && (
        <div
          style={{
            padding: "4px 10px",
            fontSize: 11,
            background: "rgba(99, 102, 241, 0.12)",
            color: "#a5b4fc",
            borderBottom: "1px solid #2a2a2a",
          }}
          title={`OpenAPI ${form.openapi.path}`}
        >
          ❖ Generated from OpenAPI v{form.openapi.specVersion} ·{" "}
          <code>{form.openapi.operationId}</code>
        </div>
      )}
      <div className="urlbar">
        <select
          className={`method-select ${methodClass(form.method)}`}
          value={METHODS.includes(form.method.toUpperCase()) ? form.method.toUpperCase() : METHODS[0]}
          onChange={(e) => onChange({ ...form, method: e.target.value })}
        >
          {METHODS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <div className="url-wrap">
          <TemplatedInput
            value={form.url}
            onChange={(url) => onChange({ ...form, url })}
            vars={vars}
            placeholder="https://api.example.com/users  (or {{base_url}}/users)"
            monospace
          />
        </div>
        <button className="send" disabled={running} onClick={onSend}>
          {running ? "Sending…" : "Send"}
        </button>
      </div>

      <div className={`url-resolved ${urlUnresolved ? "unresolved" : ""}`} title="URL that will be hit">
        <span className="url-resolved-arrow">→</span>
        <span className="url-resolved-value">{fullUrl || <em>(empty)</em>}</span>
      </div>

      <div className="tab-strip">
        <button
          className={tab === "params" ? "tab active" : "tab"}
          onClick={() => setTab("params")}
        >
          Params {form.query.length > 0 && <span className="badge">{form.query.length}</span>}
        </button>
        <button
          className={tab === "body" ? "tab active" : "tab"}
          onClick={() => setTab("body")}
        >
          Body {form.body.kind !== "none" && <span className="dot" />}
        </button>
        <button
          className={tab === "headers" ? "tab active" : "tab"}
          onClick={() => setTab("headers")}
        >
          Headers {form.headers.length > 0 && <span className="badge">{form.headers.length}</span>}
        </button>
        <button
          className={tab === "use" ? "tab active" : "tab"}
          onClick={() => setTab("use")}
        >
          Use {form.uses.length > 0 && <span className="badge">{form.uses.length}</span>}
        </button>
      </div>

      <div className="tab-body">
        {tab === "params" && (
          <KVTable
            rows={form.query}
            vars={vars}
            keyPlaceholder="parameter"
            onChange={(query) => onChange({ ...form, query })}
          />
        )}
        {tab === "body" && (
          <BodyTab
            body={form.body}
            vars={vars}
            onChange={(body) => onChange({ ...form, body })}
          />
        )}
        {tab === "headers" && (
          <KVTable
            rows={form.headers}
            vars={vars}
            keyPlaceholder="header"
            onChange={(headers) => onChange({ ...form, headers })}
          />
        )}
        {tab === "use" && (
          <UseList
            uses={form.uses}
            onChange={(uses) => onChange({ ...form, uses })}
          />
        )}
      </div>
    </div>
  );
}

interface UseListProps {
  uses: string[];
  onChange: (next: string[]) => void;
}

function UseList({ uses, onChange }: UseListProps) {
  return (
    <div className="use-list">
      <div className="kv-header"><div>Fragment path</div><div></div></div>
      {uses.length === 0 && <div className="kv-empty">No fragments referenced.</div>}
      {uses.map((u, i) => (
        <div className="kv-row" key={i}>
          <input
            className="kv-key full"
            value={u}
            placeholder="auth/bearer"
            onChange={(e) => onChange(uses.map((x, j) => (j === i ? e.target.value : x)))}
            spellCheck={false}
          />
          <button className="kv-remove" onClick={() => onChange(uses.filter((_, j) => j !== i))}>
            ×
          </button>
        </div>
      ))}
      <button className="kv-add" onClick={() => onChange([...uses, ""])}>
        + Add fragment
      </button>
    </div>
  );
}
