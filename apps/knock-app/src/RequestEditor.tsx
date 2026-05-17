import { useMemo, useState } from "react";
import { TemplatedInput } from "./TemplatedInput";
import { KVTable } from "./KVTable";
import { BodyTab } from "./BodyTab";
import { hasUnresolvedVars, interpolate } from "./interpolate";
import type { KV, OpenApiParamSpec, RequestForm } from "./types";

interface Props {
  form: RequestForm;
  vars: Record<string, string>;
  running: boolean;
  onChange: (next: RequestForm) => void;
  onSend: () => void;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

type Tab = "params" | "path" | "body" | "headers" | "use" | "responses" | "curl";

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

  const pathParams = form.path ?? [];
  const responses = form.openapi?.responses ?? {};
  const responseEntries = Object.entries(responses);

  // Path params merge into the effective vars used for the URL preview.
  const effectiveVars = useMemo(() => {
    const merged: Record<string, string> = { ...vars };
    for (const kv of pathParams) {
      if (kv.key) merged[kv.key] = kv.value;
    }
    return merged;
  }, [vars, pathParams]);

  const fullUrl = useMemo(() => {
    let base = interpolate(form.url, effectiveVars);
    const params = form.query.filter((q) => q.key.trim() !== "");
    if (params.length === 0) return base;
    const qs = params
      .map(
        (q) =>
          `${encodeURIComponent(interpolate(q.key, effectiveVars))}=${encodeURIComponent(interpolate(q.value, effectiveVars))}`,
      )
      .join("&");
    base += base.includes("?") ? `&${qs}` : `?${qs}`;
    return base;
  }, [form.url, form.query, effectiveVars]);

  const urlUnresolved = useMemo(
    () =>
      hasUnresolvedVars(form.url, effectiveVars) ||
      form.query.some(
        (q) =>
          hasUnresolvedVars(q.key, effectiveVars) ||
          hasUnresolvedVars(q.value, effectiveVars),
      ),
    [form.url, form.query, effectiveVars],
  );

  const paramSpecs = form.openapi?.paramSpecs ?? [];
  const querySpecs = paramSpecs.filter((p) => p.location === "query");
  const pathSpecs = paramSpecs.filter((p) => p.location === "path");
  const headerSpecs = paramSpecs.filter((p) => p.location === "header");

  return (
    <div className="request-editor">
      {form.openapi && <OpInfoBlock mark={form.openapi} />}
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
        {pathParams.length > 0 && (
          <button
            className={tab === "path" ? "tab active" : "tab"}
            onClick={() => setTab("path")}
          >
            Path <span className="badge">{pathParams.length}</span>
          </button>
        )}
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
        {responseEntries.length > 0 && (
          <button
            className={tab === "responses" ? "tab active" : "tab"}
            onClick={() => setTab("responses")}
          >
            Responses <span className="badge">{responseEntries.length}</span>
          </button>
        )}
        <button
          className={tab === "curl" ? "tab active" : "tab"}
          onClick={() => setTab("curl")}
        >
          cURL
        </button>
      </div>

      <div className="tab-body">
        {tab === "params" && (
          querySpecs.length > 0 ? (
            <ParamList
              rows={form.query}
              specs={querySpecs}
              vars={effectiveVars}
              keyPlaceholder="parameter"
              onChange={(query) => onChange({ ...form, query })}
            />
          ) : (
            <KVTable
              rows={form.query}
              vars={effectiveVars}
              keyPlaceholder="parameter"
              onChange={(query) => onChange({ ...form, query })}
            />
          )
        )}
        {tab === "path" && (
          pathSpecs.length > 0 ? (
            <ParamList
              rows={pathParams}
              specs={pathSpecs}
              vars={effectiveVars}
              keyPlaceholder="path variable"
              onChange={(next) => onChange({ ...form, path: next })}
            />
          ) : (
            <KVTable
              rows={pathParams}
              vars={effectiveVars}
              keyPlaceholder="path variable"
              onChange={(next) => onChange({ ...form, path: next })}
            />
          )
        )}
        {tab === "body" && (
          <BodyTab
            body={form.body}
            vars={effectiveVars}
            onChange={(body) => onChange({ ...form, body })}
          />
        )}
        {tab === "headers" && (
          headerSpecs.length > 0 ? (
            <ParamList
              rows={form.headers}
              specs={headerSpecs}
              vars={effectiveVars}
              keyPlaceholder="header"
              onChange={(headers) => onChange({ ...form, headers })}
            />
          ) : (
            <KVTable
              rows={form.headers}
              vars={effectiveVars}
              keyPlaceholder="header"
              onChange={(headers) => onChange({ ...form, headers })}
            />
          )
        )}
        {tab === "use" && (
          <UseList
            uses={form.uses}
            onChange={(uses) => onChange({ ...form, uses })}
          />
        )}
        {tab === "responses" && <ResponsesPanel entries={responseEntries} />}
        {tab === "curl" && (
          <CurlTab form={form} vars={effectiveVars} />
        )}
      </div>
    </div>
  );
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function buildCurl(
  form: RequestForm,
  vars: Record<string, string>,
  interpolated: boolean,
): string {
  const apply = (s: string): string =>
    interpolated ? interpolate(s, vars) : s;

  const url = apply(form.url);
  const params = (form.query ?? []).filter((q) => q.key.trim() !== "");
  let fullUrl = url;
  if (params.length > 0) {
    const qs = params
      .map(
        (q) =>
          `${encodeURIComponent(apply(q.key))}=${encodeURIComponent(apply(q.value))}`,
      )
      .join("&");
    fullUrl += fullUrl.includes("?") ? `&${qs}` : `?${qs}`;
  }

  const parts: string[] = [`curl -X ${form.method.toUpperCase()} ${shellQuote(fullUrl)}`];
  for (const h of form.headers ?? []) {
    if (!h.key.trim()) continue;
    parts.push(`-H ${shellQuote(`${apply(h.key)}: ${apply(h.value)}`)}`);
  }

  const body = form.body;
  switch (body.kind) {
    case "json": {
      const text = apply(body.json);
      parts.push(`-H ${shellQuote("Content-Type: application/json")}`);
      parts.push(`--data ${shellQuote(text)}`);
      break;
    }
    case "text": {
      parts.push(`--data ${shellQuote(apply(body.text))}`);
      break;
    }
    case "form": {
      for (const kv of body.form) {
        if (!kv.key.trim()) continue;
        parts.push(`--data-urlencode ${shellQuote(`${apply(kv.key)}=${apply(kv.value)}`)}`);
      }
      break;
    }
    case "file": {
      parts.push(`--data-binary ${shellQuote(`@${apply(body.path)}`)}`);
      break;
    }
    case "multipart": {
      for (const f of body.multipart) {
        if (!f.name.trim()) continue;
        if (f.kind === "file") {
          parts.push(`-F ${shellQuote(`${apply(f.name)}=@${apply(f.value)}`)}`);
        } else {
          parts.push(`-F ${shellQuote(`${apply(f.name)}=${apply(f.value)}`)}`);
        }
      }
      break;
    }
    case "none":
    default:
      break;
  }

  return parts.join(" \\\n  ");
}

function CurlTab({
  form,
  vars,
}: {
  form: RequestForm;
  vars: Record<string, string>;
}) {
  const [interpolated, setInterpolated] = useState(true);
  const [copied, setCopied] = useState(false);

  const curl = useMemo(
    () => buildCurl(form, vars, interpolated),
    [form, vars, interpolated],
  );

  const unresolved = useMemo(
    () => interpolated && /\{\{\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\}\}/.test(curl),
    [curl, interpolated],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(curl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked */
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", padding: 8, gap: 8 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <div style={{ display: "flex", border: "1px solid var(--border)", borderRadius: 4 }}>
          <button
            onClick={() => setInterpolated(true)}
            style={{
              padding: "4px 10px",
              background: interpolated ? "var(--accent, #6366f1)" : "transparent",
              color: interpolated ? "#fff" : "var(--text-dim)",
              border: 0,
              borderRadius: "3px 0 0 3px",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            Interpolated
          </button>
          <button
            onClick={() => setInterpolated(false)}
            style={{
              padding: "4px 10px",
              background: !interpolated ? "var(--accent, #6366f1)" : "transparent",
              color: !interpolated ? "#fff" : "var(--text-dim)",
              border: 0,
              borderRadius: "0 3px 3px 0",
              fontSize: 11,
              cursor: "pointer",
            }}
          >
            Templated
          </button>
        </div>
        {unresolved && (
          <span style={{ color: "#eab308", fontSize: 11 }}>
            ⚠ contains unresolved {`{{vars}}`}
          </span>
        )}
        <button onClick={copy} style={{ marginLeft: "auto" }}>
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
      <pre
        style={{
          margin: 0,
          flex: 1,
          minHeight: 0,
          overflow: "auto",
          padding: 12,
          background: "var(--panel-2, #1a1a1a)",
          border: "1px solid var(--border)",
          borderRadius: 4,
          fontFamily: "var(--mono)",
          fontSize: 12.5,
          lineHeight: 1.5,
          whiteSpace: "pre",
        }}
      >
        {curl}
      </pre>
    </div>
  );
}

function ResponsesPanel({
  entries,
}: {
  entries: [string, { description?: string | null; contentType?: string | null; example?: string | null }][];
}) {
  return (
    <div style={{ padding: 8, display: "flex", flexDirection: "column", gap: 12 }}>
      {entries.map(([code, info]) => (
        <div
          key={code}
          style={{
            border: "1px solid var(--border)",
            borderRadius: 4,
            background: "var(--panel-2, #1a1a1a)",
          }}
        >
          <div
            style={{
              padding: "6px 10px",
              borderBottom: info.example ? "1px solid var(--border)" : "none",
              display: "flex",
              gap: 8,
              alignItems: "baseline",
            }}
          >
            <span
              style={{
                fontFamily: "var(--mono)",
                fontWeight: 700,
                color: code.startsWith("2")
                  ? "#22c55e"
                  : code.startsWith("4")
                    ? "#eab308"
                    : code.startsWith("5")
                      ? "#ef4444"
                      : "#64748b",
              }}
            >
              {code}
            </span>
            <span style={{ opacity: 0.8 }}>{info.description ?? ""}</span>
            {info.contentType && (
              <span style={{ marginLeft: "auto", opacity: 0.5, fontSize: 11 }}>
                {info.contentType}
              </span>
            )}
          </div>
          {info.example && (
            <pre
              style={{
                margin: 0,
                padding: 10,
                fontFamily: "var(--mono)",
                fontSize: 12,
                whiteSpace: "pre-wrap",
                overflow: "auto",
                maxHeight: 260,
              }}
            >
              {info.example}
            </pre>
          )}
        </div>
      ))}
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

function OpInfoBlock({ mark }: { mark: NonNullable<RequestForm["openapi"]> }) {
  const [open, setOpen] = useState(false);
  const responseCodes = Object.keys(mark.responses ?? {});
  const hasDetails = !!(mark.description || mark.bodyDescription);

  function codeColor(c: string): string {
    if (c.startsWith("2")) return "#22c55e";
    if (c.startsWith("3")) return "#06b6d4";
    if (c.startsWith("4")) return "#eab308";
    if (c.startsWith("5")) return "#ef4444";
    return "#64748b";
  }

  return (
    <div
      style={{
        padding: "6px 10px",
        fontSize: 11,
        background: "rgba(99, 102, 241, 0.08)",
        color: "var(--text)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "wrap",
        }}
      >
        <span style={{ color: "#a5b4fc" }}>❖</span>
        {mark.tag && (
          <span
            style={{
              background: "rgba(99, 102, 241, 0.25)",
              color: "#a5b4fc",
              padding: "1px 6px",
              borderRadius: 3,
              fontSize: 10,
              fontWeight: 600,
              textTransform: "uppercase",
            }}
          >
            {mark.tag}
          </span>
        )}
        <span style={{ fontWeight: 600 }}>
          {mark.summary ?? mark.operationId}
        </span>
        <code style={{ opacity: 0.6, fontSize: 11 }}>{mark.operationId}</code>
        {mark.deprecated && (
          <span
            style={{
              background: "#7f1d1d",
              color: "#fecaca",
              padding: "1px 6px",
              borderRadius: 3,
              fontSize: 10,
              fontWeight: 600,
            }}
          >
            DEPRECATED
          </span>
        )}
        {mark.security && mark.security.length > 0 && (
          <span style={{ opacity: 0.7 }} title="Security schemes">
            🔒 {mark.security.join(", ")}
          </span>
        )}
        {hasDetails && (
          <button
            onClick={() => setOpen((v) => !v)}
            style={{
              marginLeft: "auto",
              background: "transparent",
              border: 0,
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            {open ? "▾ Hide details" : "▸ Show details"}
          </button>
        )}
      </div>
      <div
        style={{
          display: "flex",
          gap: 10,
          marginTop: 4,
          flexWrap: "wrap",
          fontSize: 10,
          color: "var(--text-dim)",
          alignItems: "center",
        }}
      >
        {mark.bodyContentType && (
          <span>
            <span style={{ opacity: 0.6 }}>body:</span>{" "}
            <code>{mark.bodyContentType}</code>
            {mark.bodyRequired && (
              <span style={{ color: "#ef4444", marginLeft: 2 }} title="required">
                *
              </span>
            )}
          </span>
        )}
        {mark.accepts && mark.accepts.length > 0 && !mark.bodyContentType && (
          <span>
            <span style={{ opacity: 0.6 }}>accepts:</span>{" "}
            <code>{mark.accepts.join(", ")}</code>
          </span>
        )}
        {mark.produces && mark.produces.length > 0 && (
          <span>
            <span style={{ opacity: 0.6 }}>produces:</span>{" "}
            <code>{mark.produces.join(", ")}</code>
          </span>
        )}
        {responseCodes.length > 0 && (
          <span style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <span style={{ opacity: 0.6 }}>responses:</span>
            {responseCodes.map((c) => (
              <span
                key={c}
                title={mark.responses?.[c]?.description ?? c}
                style={{
                  background: "var(--panel-2, #1a1a1a)",
                  color: codeColor(c),
                  padding: "1px 5px",
                  borderRadius: 3,
                  fontFamily: "var(--mono)",
                  fontWeight: 600,
                }}
              >
                {c}
              </span>
            ))}
          </span>
        )}
        <span style={{ marginLeft: "auto", opacity: 0.5 }}>
          v{mark.specVersion}
        </span>
      </div>
      {open && (
        <div
          style={{
            marginTop: 8,
            padding: "8px 4px 4px",
            borderTop: "1px solid var(--border)",
            color: "var(--text-dim)",
            fontSize: 12,
            lineHeight: 1.5,
          }}
        >
          {mark.description && (
            <div style={{ whiteSpace: "pre-wrap" }}>{mark.description}</div>
          )}
          {mark.bodyDescription && (
            <div style={{ marginTop: 6 }}>
              <span style={{ opacity: 0.6 }}>Body:</span> {mark.bodyDescription}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

interface ParamListProps {
  rows: KV[];
  specs: OpenApiParamSpec[];
  vars: Record<string, string>;
  keyPlaceholder: string;
  onChange: (rows: KV[]) => void;
}

function ParamList({ rows, specs, vars, keyPlaceholder, onChange }: ParamListProps) {
  const byName = useMemo(() => {
    const m = new Map<string, OpenApiParamSpec>();
    for (const s of specs) m.set(s.name, s);
    return m;
  }, [specs]);

  const rowsByName = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of rows) if (r.key) m.set(r.key, r.value);
    return m;
  }, [rows]);

  const specNames = specs.map((s) => s.name);
  const extras = rows.filter((r) => !byName.has(r.key));

  function setValue(name: string, value: string) {
    const idx = rows.findIndex((r) => r.key === name);
    const next = [...rows];
    if (idx >= 0) {
      next[idx] = { key: name, value };
    } else {
      next.push({ key: name, value });
    }
    onChange(next);
  }

  function setExtra(target: KV, kv: KV) {
    onChange(rows.map((r) => (r === target ? kv : r)));
  }

  function addExtra() {
    onChange([...rows, { key: "", value: "" }]);
  }

  function removeExtra(target: KV) {
    onChange(rows.filter((r) => r !== target));
  }

  return (
    <div style={{ padding: 4, display: "flex", flexDirection: "column" }}>
      {specNames.map((name) => {
        const spec = byName.get(name)!;
        const value = rowsByName.get(name) ?? spec.default ?? spec.example ?? "";
        const unresolved = hasUnresolvedVars(value, vars);
        const hasEnum = (spec.enumValues?.length ?? 0) > 0;
        const constraintsBits: string[] = [];
        if (spec.min != null) constraintsBits.push(`min ${spec.min}`);
        if (spec.max != null) constraintsBits.push(`max ${spec.max}`);
        if (spec.minLength != null) constraintsBits.push(`minLen ${spec.minLength}`);
        if (spec.maxLength != null) constraintsBits.push(`maxLen ${spec.maxLength}`);
        if (spec.pattern) constraintsBits.push(`pattern ${spec.pattern}`);
        const numericValid = (() => {
          if (spec.ty !== "integer" && spec.ty !== "number") return true;
          if (!value) return true;
          const n = Number(value);
          if (Number.isNaN(n)) return false;
          if (spec.min != null && n < spec.min) return false;
          if (spec.max != null && n > spec.max) return false;
          return true;
        })();
        const lengthValid = (() => {
          if (!value) return true;
          if (spec.minLength != null && value.length < spec.minLength) return false;
          if (spec.maxLength != null && value.length > spec.maxLength) return false;
          return true;
        })();
        const patternValid = (() => {
          if (!value || !spec.pattern) return true;
          try {
            return new RegExp(spec.pattern).test(value);
          } catch {
            return true;
          }
        })();
        const invalid = !numericValid || !lengthValid || !patternValid;
        return (
          <div
            key={name}
            style={{
              display: "grid",
              gridTemplateColumns: "200px 1fr",
              gap: 12,
              padding: "8px 8px",
              borderBottom: "1px solid var(--border)",
              alignItems: "start",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <div
                style={{
                  fontFamily: "var(--mono)",
                  fontSize: 12,
                  fontWeight: 600,
                  textDecoration: spec.deprecated ? "line-through" : "none",
                  color: spec.deprecated ? "var(--text-dim)" : "var(--text)",
                }}
              >
                {spec.name}
                {spec.required && (
                  <span style={{ color: "#ef4444", marginLeft: 2 }} title="required">
                    *
                  </span>
                )}
              </div>
              <div
                style={{
                  fontSize: 10,
                  color: "var(--text-dim)",
                  display: "flex",
                  gap: 4,
                  flexWrap: "wrap",
                }}
              >
                {spec.ty && (
                  <span
                    style={{
                      padding: "1px 4px",
                      background: "var(--panel-2, #1a1a1a)",
                      borderRadius: 2,
                    }}
                  >
                    {spec.ty}
                    {spec.format ? `:${spec.format}` : ""}
                  </span>
                )}
                <span style={{ opacity: 0.6 }}>({spec.location})</span>
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              {hasEnum ? (
                <select
                  value={value}
                  onChange={(e) => setValue(name, e.target.value)}
                  style={{ fontFamily: "var(--mono)", fontSize: 12 }}
                >
                  <option value="">(unset)</option>
                  {spec.enumValues!.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type="text"
                  value={value}
                  placeholder={spec.example ?? spec.default ?? ""}
                  onChange={(e) => setValue(name, e.target.value)}
                  spellCheck={false}
                  style={{
                    fontFamily: "var(--mono)",
                    fontSize: 12,
                    borderColor: invalid ? "#ef4444" : undefined,
                  }}
                />
              )}
              {spec.description && (
                <div style={{ fontSize: 11, color: "var(--text-dim)", lineHeight: 1.4 }}>
                  {spec.description}
                </div>
              )}
              {constraintsBits.length > 0 && (
                <div style={{ fontSize: 10, color: invalid ? "#ef4444" : "var(--text-dim)" }}>
                  {constraintsBits.join(" · ")}
                </div>
              )}
              {unresolved && (
                <div style={{ fontSize: 10, color: "#eab308" }}>
                  ⚠ unresolved {`{{var}}`}
                </div>
              )}
            </div>
          </div>
        );
      })}

      {extras.length > 0 && (
        <div
          style={{
            padding: "6px 8px",
            fontSize: 11,
            color: "var(--text-dim)",
            borderBottom: "1px solid var(--border)",
          }}
        >
          Extra (not in spec)
        </div>
      )}
      {extras.map((kv, i) => (
        <div
          key={`extra-${i}`}
          style={{
            display: "grid",
            gridTemplateColumns: "200px 1fr 24px",
            gap: 12,
            padding: "6px 8px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          <input
            type="text"
            value={kv.key}
            placeholder={keyPlaceholder}
            onChange={(e) => setExtra(kv, { ...kv, key: e.target.value })}
            spellCheck={false}
            style={{ fontFamily: "var(--mono)", fontSize: 12 }}
          />
          <input
            type="text"
            value={kv.value}
            onChange={(e) => setExtra(kv, { ...kv, value: e.target.value })}
            spellCheck={false}
            style={{ fontFamily: "var(--mono)", fontSize: 12 }}
          />
          <button onClick={() => removeExtra(kv)}>×</button>
        </div>
      ))}
      <div style={{ padding: 6 }}>
        <button onClick={addExtra}>+ Add custom</button>
      </div>
    </div>
  );
}
