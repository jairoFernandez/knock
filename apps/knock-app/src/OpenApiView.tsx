import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Editor } from "./Editor";
import type {
  OpenApiHistoryEntry,
  OpenApiMeta,
  OpenApiPreview,
  TreeEntry,
} from "./types";

interface Props {
  root: string;
  rel: string;
  onSelectRequest: (rel: string) => void;
  onTreeChanged: (tree: TreeEntry[]) => void;
  onReimport: () => void;
}

type Tab = "overview" | "source";

interface OpRow {
  operationId: string;
  method: string;
  path: string;
  tag: string | null;
  summary: string | null;
  targetRel: string;
}

function methodColor(m: string): string {
  const u = m.toUpperCase();
  if (u === "GET") return "#22c55e";
  if (u === "POST") return "#eab308";
  if (u === "PUT" || u === "PATCH") return "#f97316";
  if (u === "DELETE") return "#ef4444";
  return "#64748b";
}

export function OpenApiView({
  root,
  rel,
  onSelectRequest,
  onTreeChanged,
  onReimport,
}: Props) {
  const [meta, setMeta] = useState<OpenApiMeta | null>(null);
  const [text, setText] = useState<string>("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<OpenApiPreview | null>(null);
  const [history, setHistory] = useState<OpenApiHistoryEntry[]>([]);
  const [tree, setTree] = useState<TreeEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>("overview");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [m, s, h, t] = await Promise.all([
          invoke<OpenApiMeta>("openapi_get_meta", { root }),
          invoke<string>("openapi_read_spec", { root }),
          invoke<OpenApiHistoryEntry[]>("openapi_list_history", { root }),
          invoke<TreeEntry[]>("list_tree", { root }),
        ]);
        if (cancelled) return;
        setMeta(m);
        setText(s);
        setHistory(h);
        setTree(t);
        setDirty(false);
        setPreview(null);
      } catch (e) {
        setError(String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [root, rel]);

  // Parse spec text to derive an overview without a backend round-trip.
  const ops: OpRow[] = useMemo(() => {
    if (!text) return [];
    let spec: any;
    try {
      spec = JSON.parse(text);
    } catch {
      return [];
    }
    const paths = spec?.paths;
    if (!paths || typeof paths !== "object") return [];
    const out: OpRow[] = [];
    const methods = ["get", "post", "put", "patch", "delete", "head", "options"];
    for (const [path, item] of Object.entries<any>(paths)) {
      if (!item || typeof item !== "object") continue;
      for (const m of methods) {
        const op = item[m];
        if (!op) continue;
        const operationId =
          op.operationId ??
          `${m}_${path.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
        const tag = Array.isArray(op.tags) && op.tags.length > 0 ? op.tags[0] : null;
        const targetRel = `requests/${sanitize(tag ?? "default")}/${sanitize(operationId)}.toml`;
        out.push({
          operationId,
          method: m.toUpperCase(),
          path,
          tag,
          summary: op.summary ?? null,
          targetRel,
        });
      }
    }
    return out;
  }, [text]);

  const groups = useMemo(() => {
    const g = new Map<string, OpRow[]>();
    const f = filter.trim().toLowerCase();
    for (const o of ops) {
      if (
        f &&
        !o.path.toLowerCase().includes(f) &&
        !o.operationId.toLowerCase().includes(f) &&
        !(o.summary ?? "").toLowerCase().includes(f)
      ) {
        continue;
      }
      const key = o.tag ?? "default";
      const arr = g.get(key) ?? [];
      arr.push(o);
      g.set(key, arr);
    }
    return [...g.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [ops, filter]);

  const treeByRel = useMemo(() => {
    const m = new Map<string, TreeEntry>();
    for (const t of tree) m.set(t.rel, t);
    return m;
  }, [tree]);

  async function validateAndPreview() {
    setError(null);
    setBusy(true);
    try {
      const pv = await invoke<OpenApiPreview>("openapi_save_spec", {
        root,
        content: text,
      });
      setPreview(pv);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  async function applyPreview() {
    if (!preview) return;
    setError(null);
    setBusy(true);
    try {
      const bytes = textToBytes(text);
      const selections = preview.operations
        .filter((op) => op.status !== "unchanged")
        .map((op) => ({
          operationId: op.operationId,
          action:
            op.status === "removed"
              ? "delete"
              : op.status === "new"
                ? "create"
                : "overwrite",
        }));
      const t = await invoke<TreeEntry[]>("openapi_apply_import", {
        root,
        bytes,
        source: { kind: "file", value: rel },
        selections,
      });
      onTreeChanged(t);
      setTree(t);
      setDirty(false);
      setPreview(null);
      const m = await invoke<OpenApiMeta>("openapi_get_meta", { root });
      setMeta(m);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, overflow: "hidden" }}>
      <div style={{ padding: 12, borderBottom: "1px solid var(--border)" }}>
        <div className="row" style={{ justifyContent: "space-between", alignItems: "baseline" }}>
          <div>
            <strong style={{ fontSize: 16 }}>OpenAPI Spec</strong>
            {meta && (
              <span style={{ marginLeft: 8, opacity: 0.7, fontSize: 12 }}>
                {meta.specFormat ?? "?"} · v{meta.specVersion ?? "?"} ·{" "}
                {meta.operationCount} operations
              </span>
            )}
          </div>
          <button onClick={onReimport}>Re-import…</button>
        </div>
        {meta?.sourceUrl && (
          <div style={{ opacity: 0.6, fontSize: 12, marginTop: 4 }}>
            Source: <code>{meta.sourceUrl}</code>
          </div>
        )}
        {meta?.lastImportedAt && (
          <div style={{ opacity: 0.6, fontSize: 12 }}>
            Last imported: {new Date(meta.lastImportedAt).toLocaleString()}
          </div>
        )}
      </div>

      <div className="tab-strip" style={{ borderBottom: "1px solid var(--border)" }}>
        <button
          className={tab === "overview" ? "tab active" : "tab"}
          onClick={() => setTab("overview")}
        >
          Overview
        </button>
        <button
          className={tab === "source" ? "tab active" : "tab"}
          onClick={() => setTab("source")}
        >
          Source {dirty && <span className="dirty-mark"> •</span>}
        </button>
      </div>

      {error && <div className="error" style={{ margin: 8 }}>{error}</div>}

      {tab === "overview" && (
        <div style={{ flex: 1, minHeight: 0, overflow: "auto", padding: 12 }}>
          <input
            type="text"
            placeholder="Filter operations…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ width: "100%", marginBottom: 12 }}
          />
          {groups.length === 0 && (
            <div className="empty">No operations to show.</div>
          )}
          {groups.map(([tagName, rows]) => {
            const open = !collapsed[tagName];
            return (
              <div key={tagName} style={{ marginBottom: 12 }}>
                <button
                  onClick={() =>
                    setCollapsed((c) => ({ ...c, [tagName]: !!open }))
                  }
                  style={{
                    background: "transparent",
                    border: 0,
                    padding: "4px 0",
                    width: "100%",
                    textAlign: "left",
                    color: "var(--text)",
                    fontWeight: 600,
                    fontSize: 13,
                    cursor: "pointer",
                  }}
                >
                  {open ? "▾" : "▸"} {tagName}{" "}
                  <span style={{ opacity: 0.5, fontWeight: 400 }}>
                    ({rows.length})
                  </span>
                </button>
                {open && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingLeft: 12 }}>
                    {rows.map((o) => {
                      const exists = treeByRel.has(o.targetRel);
                      return (
                        <button
                          key={o.operationId + o.path + o.method}
                          onClick={() => exists && onSelectRequest(o.targetRel)}
                          disabled={!exists}
                          title={exists ? o.targetRel : "not imported"}
                          style={{
                            display: "grid",
                            gridTemplateColumns: "64px 1fr",
                            gap: 8,
                            alignItems: "center",
                            background: "var(--panel-2, #1a1a1a)",
                            border: "1px solid var(--border, #2a2a2a)",
                            borderRadius: 4,
                            padding: "6px 10px",
                            cursor: exists ? "pointer" : "default",
                            opacity: exists ? 1 : 0.55,
                            textAlign: "left",
                          }}
                        >
                          <span
                            style={{
                              color: methodColor(o.method),
                              fontWeight: 700,
                              fontSize: 11,
                              fontFamily: "var(--mono)",
                            }}
                          >
                            {o.method}
                          </span>
                          <div style={{ minWidth: 0 }}>
                            <div
                              style={{
                                fontFamily: "var(--mono)",
                                fontSize: 12,
                                color: "var(--text)",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                              }}
                            >
                              {o.path}
                            </div>
                            {o.summary && (
                              <div
                                style={{
                                  fontSize: 11,
                                  color: "var(--text-dim)",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >
                                {o.summary}
                              </div>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}

          {history.length > 0 && (
            <div style={{ marginTop: 24 }}>
              <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 12, color: "var(--text-dim)" }}>
                Import history
              </div>
              {history.map((h) => (
                <div key={h.rel} style={{ fontSize: 12, opacity: 0.7 }}>
                  {h.name}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {tab === "source" && (
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div style={{ padding: 8, display: "flex", gap: 8, alignItems: "center" }}>
            <button onClick={validateAndPreview} disabled={busy || !dirty}>
              Validate changes
            </button>
            {preview && (
              <button className="primary" onClick={applyPreview} disabled={busy}>
                Apply changes
              </button>
            )}
            {dirty && (
              <span style={{ opacity: 0.7, fontSize: 12 }}>unsaved edits</span>
            )}
            {preview && (
              <span style={{ opacity: 0.7, fontSize: 12 }}>
                {preview.operations.filter((o) => o.status !== "unchanged").length}{" "}
                pending changes
              </span>
            )}
          </div>
          <Editor
            value={text}
            onChange={(v) => {
              setText(v);
              setDirty(true);
              setPreview(null);
            }}
            onSave={validateAndPreview}
          />
        </div>
      )}
    </div>
  );
}

function sanitize(s: string): string {
  let out = "";
  for (const c of s) {
    if (/[A-Za-z0-9_-]/.test(c)) out += c;
    else out += "_";
  }
  return out || "_";
}

function textToBytes(text: string): number[] {
  const enc = new TextEncoder().encode(text);
  return Array.from(enc);
}
