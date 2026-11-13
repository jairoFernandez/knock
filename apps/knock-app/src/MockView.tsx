import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Splitter } from "./Splitter";
import { usePersistedNumber } from "./hooks";

const clamp = (v: number, min: number, max: number) =>
  Math.max(min, Math.min(max, v));

interface MockStatus {
  running: boolean;
  workspace_root: string | null;
  addr: string | null;
  route_count: number | null;
  started_at: number | null;
}

interface MockRouteSummary {
  method: string;
  path: string;
  auth: string | null;
  status: number;
  request_rel: string;
  source: "inline" | "sibling" | "openapi" | "stub" | "empty";
}

interface MockResponseEdit {
  status: number | null;
  headers: Record<string, string>;
  auth: string | null;
  delay_ms: number | null;
  body_json: string | null;
  body_text: string | null;
}

interface MockResponseRead {
  origin: "inline" | "sibling" | "none";
  edit: MockResponseEdit;
}

interface MockSpecPreview {
  routes: MockRouteSummary[];
  auth_schemes: string[];
  default_delay_ms: number | null;
}

interface LogEntry {
  ts_ms: number;
  method: string;
  path: string;
  status: number;
  elapsed_ms: number;
  remote: string | null;
  req_headers?: Record<string, string>;
  req_body?: string | null;
  req_body_truncated?: boolean;
  resp_headers?: Record<string, string>;
  resp_body?: string | null;
  resp_body_truncated?: boolean;
}

interface MockToken {
  token: string;
  description: string;
  group: string;
  snippet: string | null;
}

interface Props {
  workspaceRoot: string;
  onTreeChanged?: () => void;
}

const MAX_LOGS = 500;
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

/** Starter body: echoes path params so the user sees request tokens in action. */
function starterBody(method: string, path: string): string {
  const params = Array.from(path.matchAll(/[{:]([A-Za-z_][\w]*)\}?/g), (m) => m[1]);
  const lines: string[] = [];
  if (params.length) params.forEach((p) => lines.push(`"${p}": "{{params.${p}}}"`));
  else lines.push(`"id": "{{uuid}}"`);
  if (method === "GET" && !params.length) {
    return `{\n  "page": "{{query.page|1}}",\n  "items": ["{{repeat(3)}}", {\n    "id": "{{index}}",\n    "name": "{{name.full}}",\n    "email": "{{internet.email}}"\n  }]\n}`;
  }
  if (method === "POST" || method === "PUT" || method === "PATCH") {
    lines.push(`"received": "{{body}}"`);
    lines.push(`"updatedAt": "{{date.iso}}"`);
  } else {
    lines.push(`"name": "{{name.full}}"`, `"createdAt": "{{date.iso}}"`);
  }
  return `{\n  ${lines.join(",\n  ")}\n}`;
}

export function MockView({ workspaceRoot, onTreeChanged }: Props) {
  const [status, setStatus] = useState<MockStatus>({
    running: false,
    workspace_root: null,
    addr: null,
    route_count: null,
    started_at: null,
  });
  const [preview, setPreview] = useState<MockSpecPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [port, setPort] = useState<string>("3000");
  const [bind, setBind] = useState<string>("127.0.0.1");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState("");
  const [selectedRel, setSelectedRel] = useState<string | null>(null);
  const [editorOrigin, setEditorOrigin] =
    useState<MockResponseRead["origin"]>("none");
  const [editorStatus, setEditorStatus] = useState<string>("200");
  const [editorBody, setEditorBody] = useState<string>("");
  const [editorBodyKind, setEditorBodyKind] = useState<"json" | "text">("json");
  const [editorAuth, setEditorAuth] = useState<string>("");
  const [editorHeaders, setEditorHeaders] = useState<string>("");
  const [editorDelay, setEditorDelay] = useState<string>("");
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
  const [editorPreview, setEditorPreview] = useState<string | null>(null);
  const [tokens, setTokens] = useState<MockToken[]>([]);
  const bodyRef = useRef<HTMLTextAreaElement | null>(null);
  const [creating, setCreating] = useState(false);
  const [newMethod, setNewMethod] = useState("GET");
  const [newPath, setNewPath] = useState("");
  const [newStatus, setNewStatus] = useState("200");
  const [newError, setNewError] = useState<string | null>(null);
  const [newSaving, setNewSaving] = useState(false);
  const logsRef = useRef<HTMLDivElement | null>(null);
  const autoscrollRef = useRef(true);
  const [expandedLog, setExpandedLog] = useState<number | null>(null);
  const [routesWidth, setRoutesWidth] = usePersistedNumber(
    "knock.mock.routesWidth",
    520,
  );
  const [editorWidth, setEditorWidth] = usePersistedNumber(
    "knock.mock.editorWidth",
    420,
  );

  const refreshStatus = async () => {
    try {
      const s = await invoke<MockStatus>("mock_status");
      setStatus(s);
    } catch {
      // ignore
    }
  };

  const refreshPreview = async () => {
    setPreviewError(null);
    try {
      const p = await invoke<MockSpecPreview>("mock_preview", {
        workspaceRoot,
      });
      setPreview(p);
    } catch (e) {
      setPreview(null);
      setPreviewError(String(e));
    }
  };

  useEffect(() => {
    refreshStatus();
    refreshPreview();
  }, [workspaceRoot]);

  useEffect(() => {
    invoke<MockToken[]>("mock_token_catalog")
      .then(setTokens)
      .catch(() => setTokens([]));
  }, []);

  const currentPort = () => {
    const n = port.trim() ? parseInt(port, 10) : NaN;
    return Number.isNaN(n) ? null : n;
  };

  // Routes are built at start, so a running server must restart to pick up changes.
  const reloadIfRunning = async () => {
    if (!sameWorkspace) return;
    await invoke("mock_stop");
    const s = await invoke<MockStatus>("mock_start", {
      workspaceRoot,
      bind: bind.trim() || null,
      port: currentPort(),
    });
    setStatus(s);
  };

  const createEndpoint = async () => {
    setNewSaving(true);
    setNewError(null);
    try {
      const statusNum = parseInt(newStatus, 10);
      const rel = await invoke<string>("mock_create_endpoint", {
        workspaceRoot,
        method: newMethod,
        path: newPath,
        name: null,
        edit: {
          status: Number.isNaN(statusNum) ? 200 : statusNum,
          headers: {},
          auth: null,
          delay_ms: null,
          body_json: starterBody(newMethod, newPath),
          body_text: null,
        } satisfies MockResponseEdit,
      });
      setCreating(false);
      setNewPath("");
      setNewStatus("200");
      await refreshPreview();
      onTreeChanged?.();
      await openEditor(rel);
      try {
        await reloadIfRunning();
      } catch (e) {
        setEditorError(`created, but reload failed: ${e}`);
      }
    } catch (e) {
      setNewError(String(e));
    } finally {
      setNewSaving(false);
    }
  };

  const insertToken = (t: MockToken) => {
    const el = bodyRef.current;
    const start = el?.selectionStart ?? editorBody.length;
    const end = el?.selectionEnd ?? editorBody.length;
    // Inside a JSON body, bare tokens need quotes to stay valid JSON.
    const before = editorBody.slice(0, start);
    const quotes = (before.match(/(?<!\\)"/g) ?? []).length;
    const insideString = quotes % 2 === 1;
    const text =
      t.snippet && editorBodyKind === "json" && !insideString
        ? t.snippet
        : editorBodyKind === "json" && !insideString
          ? `"${t.token}"`
          : t.token;
    setEditorBody(before + text + editorBody.slice(end));
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + text.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const renderPreview = async () => {
    setEditorError(null);
    try {
      const out = await invoke<string>("mock_render_preview", {
        body: editorBody,
        kind: editorBodyKind,
      });
      setEditorPreview(out);
    } catch (e) {
      setEditorPreview(null);
      setEditorError(String(e));
    }
  };

  useEffect(() => {
    let cancelled = false;
    const pending: Promise<UnlistenFn>[] = [
      listen<MockStatus>("mock://status", (e) => setStatus(e.payload)),
      listen<LogEntry>("mock://log", (e) => {
        if (paused) return;
        setLogs((cur) => {
          const next = [...cur, e.payload];
          if (next.length > MAX_LOGS) next.splice(0, next.length - MAX_LOGS);
          return next;
        });
      }),
    ];
    return () => {
      cancelled = true;
      pending.forEach((p) =>
        p.then((un) => {
          if (cancelled) un();
        }),
      );
    };
  }, [paused]);

  useEffect(() => {
    if (!autoscrollRef.current) return;
    const el = logsRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logs]);

  const onScroll = () => {
    const el = logsRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoscrollRef.current = atBottom;
  };

  const start = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const portNum = port.trim() ? parseInt(port, 10) : null;
      const s = await invoke<MockStatus>("mock_start", {
        workspaceRoot,
        bind: bind.trim() || null,
        port: portNum && !Number.isNaN(portNum) ? portNum : null,
      });
      setStatus(s);
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    setActionError(null);
    try {
      const s = await invoke<MockStatus>("mock_stop");
      setStatus(s);
    } catch (e) {
      setActionError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const openEditor = async (rel: string) => {
    setSelectedRel(rel);
    setEditorError(null);
    setEditorPreview(null);
    try {
      const r = await invoke<MockResponseRead>("mock_read_response", {
        workspaceRoot,
        requestRel: rel,
      });
      setEditorOrigin(r.origin);
      setEditorStatus(r.edit.status ? String(r.edit.status) : "200");
      setEditorAuth(r.edit.auth ?? "");
      setEditorDelay(r.edit.delay_ms != null ? String(r.edit.delay_ms) : "");
      setEditorHeaders(
        Object.entries(r.edit.headers ?? {})
          .map(([k, v]) => `${k}: ${v}`)
          .join("\n"),
      );
      if (r.edit.body_json) {
        setEditorBodyKind("json");
        setEditorBody(r.edit.body_json);
      } else if (r.edit.body_text) {
        setEditorBodyKind("text");
        setEditorBody(r.edit.body_text);
      } else {
        setEditorBodyKind("json");
        setEditorBody("");
      }
    } catch (e) {
      setEditorError(String(e));
    }
  };

  const closeEditor = () => {
    setSelectedRel(null);
    setEditorError(null);
  };

  const saveEditor = async () => {
    if (!selectedRel) return;
    setEditorSaving(true);
    setEditorError(null);
    try {
      const headers: Record<string, string> = {};
      editorHeaders
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .forEach((l) => {
          const idx = l.indexOf(":");
          if (idx > 0) {
            const k = l.slice(0, idx).trim();
            const v = l.slice(idx + 1).trim();
            if (k) headers[k] = v;
          }
        });
      const statusNum = parseInt(editorStatus, 10);
      const delayNum = parseInt(editorDelay, 10);
      const edit: MockResponseEdit = {
        status: Number.isNaN(statusNum) ? 200 : statusNum,
        headers,
        auth: editorAuth.trim() || null,
        delay_ms: Number.isNaN(delayNum) || delayNum <= 0 ? null : delayNum,
        body_json: editorBodyKind === "json" ? editorBody : null,
        body_text: editorBodyKind === "text" ? editorBody : null,
      };
      await invoke("mock_save_response", {
        workspaceRoot,
        requestRel: selectedRel,
        edit,
      });
      await refreshPreview();
      if (editorOrigin === "none") setEditorOrigin("sibling");
      // hot-reload: if the server is running for this workspace, restart
      // so the new response takes effect on the next request.
      try {
        await reloadIfRunning();
      } catch (e) {
        setEditorError(`saved, but reload failed: ${e}`);
      }
    } catch (e) {
      setEditorError(String(e));
    } finally {
      setEditorSaving(false);
    }
  };

  const clearEditor = async () => {
    if (!selectedRel) return;
    setEditorSaving(true);
    setEditorError(null);
    try {
      await invoke("mock_clear_response", {
        workspaceRoot,
        requestRel: selectedRel,
      });
      await refreshPreview();
      setEditorOrigin("none");
      setEditorStatus("200");
      setEditorBody("");
      setEditorAuth("");
      setEditorHeaders("");
      setEditorDelay("");
      setEditorPreview(null);
      try {
        await reloadIfRunning();
      } catch (e) {
        setEditorError(`cleared, but reload failed: ${e}`);
      }
    } catch (e) {
      setEditorError(String(e));
    } finally {
      setEditorSaving(false);
    }
  };

  const filteredLogs = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return logs;
    return logs.filter(
      (l) =>
        l.path.toLowerCase().includes(f) ||
        l.method.toLowerCase().includes(f) ||
        String(l.status).includes(f),
    );
  }, [logs, filter]);

  const sameWorkspace =
    status.running && status.workspace_root === workspaceRoot;
  const runningElsewhere =
    status.running && status.workspace_root !== workspaceRoot;

  return (
    <div className="mock-view">
      <div className="panel-header mock-header">
        <span>Mock server</span>
        <span className={`mock-dot ${status.running ? "on" : "off"}`} />
        {status.running && status.addr && (
          <a
            href={`http://${status.addr}`}
            target="_blank"
            rel="noreferrer"
            className="mock-addr"
          >
            http://{status.addr}
          </a>
        )}
      </div>

      <div className="mock-controls">
        <label>
          Bind
          <input
            type="text"
            value={bind}
            onChange={(e) => setBind(e.target.value)}
            disabled={status.running || busy}
            placeholder="127.0.0.1"
          />
        </label>
        <label>
          Port
          <input
            type="text"
            value={port}
            onChange={(e) => setPort(e.target.value)}
            disabled={status.running || busy}
            placeholder="3000"
          />
        </label>
        {!status.running && (
          <button className="primary" onClick={start} disabled={busy}>
            {busy ? "Starting…" : "Start"}
          </button>
        )}
        {sameWorkspace && (
          <button onClick={stop} disabled={busy}>
            {busy ? "Stopping…" : "Stop"}
          </button>
        )}
        {runningElsewhere && (
          <span className="mock-warn">
            Running for another workspace ({status.workspace_root}). Stop it
            first.
          </span>
        )}
        <button onClick={refreshPreview} disabled={busy} title="Reload spec from disk">
          Reload spec
        </button>
      </div>

      {actionError && <div className="mock-error">{actionError}</div>}
      {previewError && <div className="mock-error">spec: {previewError}</div>}

      <div className="mock-body">
        <div
          className="mock-routes"
          style={{ width: routesWidth, flex: "0 0 auto" }}
        >
          <div className="mock-section-header mock-routes-header">
            <span>Routes {preview ? `(${preview.routes.length})` : ""}</span>
            {!creating && (
              <button
                className="primary"
                onClick={() => {
                  setCreating(true);
                  setNewError(null);
                }}
              >
                + New endpoint
              </button>
            )}
          </div>
          {creating && (
            <form
              className="mock-new-endpoint"
              onSubmit={(e) => {
                e.preventDefault();
                createEndpoint();
              }}
            >
              <select
                value={newMethod}
                onChange={(e) => setNewMethod(e.target.value)}
              >
                {METHODS.map((m) => (
                  <option key={m}>{m}</option>
                ))}
              </select>
              <input
                type="text"
                value={newPath}
                onChange={(e) => setNewPath(e.target.value)}
                placeholder="/users/{id}"
                autoFocus
                className="mock-new-path"
              />
              <input
                type="text"
                value={newStatus}
                onChange={(e) => setNewStatus(e.target.value)}
                className="mock-editor-status-input"
                title="Status"
              />
              <button
                type="submit"
                className="primary"
                disabled={newSaving || !newPath.trim()}
              >
                {newSaving ? "Creating…" : "Create"}
              </button>
              <button type="button" onClick={() => setCreating(false)}>
                Cancel
              </button>
              {newError && <div className="mock-error full">{newError}</div>}
              <div className="mock-editor-hint full">
                Creates <code>requests/mock/…</code> pointing at this server
                plus its response in <code>mocks/</code>. Use{" "}
                <code>{"{id}"}</code> for path params.
              </div>
            </form>
          )}
          {!preview && !previewError && <div className="empty">Loading…</div>}
          {preview && preview.routes.length === 0 && (
            <div className="empty">
              No routes detected. Add requests under <code>requests/</code> and{" "}
              optional <code>[mock]</code> blocks or files under{" "}
              <code>mocks/</code>.
            </div>
          )}
          {preview && (
            <table className="mock-route-table">
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Path</th>
                  <th>Status</th>
                  <th>Auth</th>
                  <th>Source</th>
                </tr>
              </thead>
              <tbody>
                {preview.routes.map((r, i) => (
                  <tr
                    key={`${r.method}-${r.path}-${i}`}
                    className={`mock-route-row ${selectedRel === r.request_rel ? "selected" : ""}`}
                    onClick={() => openEditor(r.request_rel)}
                    title={r.request_rel}
                  >
                    <td className={`method method-${r.method.toLowerCase()}`}>
                      {r.method}
                    </td>
                    <td className="mock-path">{r.path}</td>
                    <td>{r.status}</td>
                    <td>{r.auth ?? "—"}</td>
                    <td>
                      <span className={`mock-src mock-src-${r.source}`}>
                        {r.source}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {preview && preview.auth_schemes.length > 0 && (
            <div className="mock-auth-list">
              Auth schemes: {preview.auth_schemes.join(", ")}
            </div>
          )}
        </div>

        <Splitter
          onDelta={(d) => setRoutesWidth(clamp(routesWidth + d, 280, 900))}
        />

        {selectedRel && (
          <div
            className="mock-editor-pane"
            style={{ width: editorWidth, flex: "0 0 auto" }}
          >
            <div className="mock-section-header mock-editor-header">
              <span>Response · {selectedRel}</span>
              <span className={`mock-editor-origin origin-${editorOrigin}`}>
                {editorOrigin === "inline"
                  ? "from request file"
                  : editorOrigin === "sibling"
                    ? `mocks/${selectedRel}`
                    : "not defined"}
              </span>
              <button onClick={closeEditor} title="Close">
                ×
              </button>
            </div>
            <div className="mock-editor-body">
              <label>
                Status
                <input
                  type="text"
                  value={editorStatus}
                  onChange={(e) => setEditorStatus(e.target.value)}
                  className="mock-editor-status-input"
                />
              </label>
              <label>
                Delay (ms)
                <input
                  type="text"
                  inputMode="numeric"
                  value={editorDelay}
                  onChange={(e) => setEditorDelay(e.target.value.replace(/\D/g, ""))}
                  placeholder={preview?.default_delay_ms ? `${preview.default_delay_ms} (default)` : "0"}
                  className="mock-editor-status-input"
                />
              </label>
              <label>
                Auth scheme
                {preview && preview.auth_schemes.length > 0 ? (
                  <select value={editorAuth} onChange={(e) => setEditorAuth(e.target.value)}>
                    <option value="">(none)</option>
                    {preview.auth_schemes.map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                    {editorAuth && !preview.auth_schemes.includes(editorAuth) && (
                      <option value={editorAuth}>{editorAuth} (undefined)</option>
                    )}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={editorAuth}
                    onChange={(e) => setEditorAuth(e.target.value)}
                    placeholder="(none — define schemes in knock.toml)"
                  />
                )}
              </label>
              <label className="full">
                Headers (one per line: <code>Name: value</code>)
                <textarea
                  value={editorHeaders}
                  onChange={(e) => setEditorHeaders(e.target.value)}
                  rows={3}
                />
              </label>
              <div className="mock-editor-body-tabs">
                <button
                  className={editorBodyKind === "json" ? "active" : ""}
                  onClick={() => setEditorBodyKind("json")}
                >
                  JSON
                </button>
                <button
                  className={editorBodyKind === "text" ? "active" : ""}
                  onClick={() => setEditorBodyKind("text")}
                >
                  Text
                </button>
                <select
                  className="mock-token-select"
                  value=""
                  onChange={(e) => {
                    const t = tokens.find((x) => x.token === e.target.value);
                    if (t) insertToken(t);
                  }}
                  title="Insert a token at the cursor"
                >
                  <option value="">Insert token…</option>
                  {groupTokens(tokens).map(([group, items]) => (
                    <optgroup key={group} label={group}>
                      {items.map((t) => (
                        <option key={t.token} value={t.token}>
                          {t.token} — {t.description}
                        </option>
                      ))}
                    </optgroup>
                  ))}
                </select>
                <button onClick={renderPreview} title="Render tokens as the server would">
                  Preview
                </button>
              </div>
              <textarea
                ref={bodyRef}
                value={editorBody}
                onChange={(e) => setEditorBody(e.target.value)}
                rows={12}
                placeholder={
                  editorBodyKind === "json"
                    ? '{\n  "id": 1,\n  "name": "Ada"\n}'
                    : "raw text body"
                }
                className="mock-editor-body-input"
                spellCheck={false}
              />
              {editorPreview != null && (
                <div className="mock-editor-preview">
                  <div className="mock-editor-preview-header">
                    <span>
                      Preview — new values on every request; request tokens
                      (params, query…) fill in on real calls
                    </span>
                    <button onClick={renderPreview}>↻</button>
                    <button onClick={() => setEditorPreview(null)}>×</button>
                  </div>
                  <pre>{editorPreview}</pre>
                </div>
              )}
              {editorError && <div className="mock-error">{editorError}</div>}
              <div className="mock-editor-actions">
                <button
                  className="primary"
                  onClick={saveEditor}
                  disabled={editorSaving}
                >
                  {editorSaving ? "Saving…" : "Save"}
                </button>
                {editorOrigin !== "none" && (
                  <button onClick={clearEditor} disabled={editorSaving}>
                    {editorOrigin === "inline" ? "Remove [mock] block" : "Delete mocks file"}
                  </button>
                )}
                <span className="mock-editor-hint">
                  Saves to{" "}
                  <code>
                    {editorOrigin === "inline"
                      ? `requests/${selectedRel} [mock]`
                      : `mocks/${selectedRel}`}
                  </code>
                  . Server auto-reloads if running.
                </span>
              </div>
            </div>
          </div>
        )}

        {selectedRel && (
          <Splitter
            onDelta={(d) =>
              setEditorWidth(clamp(editorWidth + d, 300, 700))
            }
          />
        )}

        <div className="mock-logs-pane" style={{ flex: "1 1 auto", minWidth: 0 }}>
          <div className="mock-section-header mock-logs-header">
            <span>Live requests ({filteredLogs.length})</span>
            <input
              type="text"
              placeholder="filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="mock-filter"
            />
            <button
              onClick={() => setPaused((p) => !p)}
              className={paused ? "primary" : ""}
              title={paused ? "Resume" : "Pause"}
            >
              {paused ? "Resume" : "Pause"}
            </button>
            <button onClick={() => setLogs([])} title="Clear">
              Clear
            </button>
          </div>
          <div className="mock-logs" ref={logsRef} onScroll={onScroll}>
            {filteredLogs.length === 0 ? (
              <div className="empty">
                {status.running
                  ? "Waiting for requests…"
                  : "Start the server to capture requests."}
              </div>
            ) : (
              filteredLogs.map((l, i) => {
                const key = `${l.ts_ms}-${i}`;
                const isOpen = expandedLog === l.ts_ms + i;
                return (
                  <div key={key} className={`mock-log-entry${isOpen ? " open" : ""}`}>
                    <div
                      className="mock-log-row"
                      onClick={() =>
                        setExpandedLog(isOpen ? null : l.ts_ms + i)
                      }
                    >
                      <span className="mock-log-chevron">{isOpen ? "▾" : "▸"}</span>
                      <span className="mock-log-ts">{fmtTs(l.ts_ms)}</span>
                      <span className={`method method-${l.method.toLowerCase()}`}>
                        {l.method}
                      </span>
                      <span className="mock-log-path">{l.path}</span>
                      <span className={`mock-log-status status-${Math.floor(l.status / 100)}xx`}>
                        {l.status}
                      </span>
                      <span className="mock-log-elapsed">{l.elapsed_ms}ms</span>
                    </div>
                    {isOpen && <LogDetail entry={l} />}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function groupTokens(tokens: MockToken[]): [string, MockToken[]][] {
  const groups = new Map<string, MockToken[]>();
  for (const t of tokens) {
    const list = groups.get(t.group) ?? [];
    list.push(t);
    groups.set(t.group, list);
  }
  return Array.from(groups);
}

function LogDetail({ entry }: { entry: LogEntry }) {
  const reqCt = headerValue(entry.req_headers, "content-type");
  const respCt = headerValue(entry.resp_headers, "content-type");
  return (
    <div className="mock-log-detail">
      <div className="mock-log-detail-cols">
        <section>
          <h4>Request headers</h4>
          {renderHeaders(entry.req_headers)}
          {entry.req_body != null && (
            <>
              <h4>
                Request body
                {entry.req_body_truncated ? " (truncated)" : ""}
              </h4>
              <pre className="mock-log-body">
                {formatBody(entry.req_body, reqCt)}
              </pre>
            </>
          )}
        </section>
        <section>
          <h4>Response headers</h4>
          {renderHeaders(entry.resp_headers)}
          {entry.resp_body != null && (
            <>
              <h4>
                Response body
                {entry.resp_body_truncated ? " (truncated)" : ""}
              </h4>
              <pre className="mock-log-body">
                {formatBody(entry.resp_body, respCt)}
              </pre>
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function renderHeaders(h?: Record<string, string>) {
  const entries = Object.entries(h ?? {});
  if (entries.length === 0) return <div className="mock-log-empty">(none)</div>;
  return (
    <table className="mock-log-headers">
      <tbody>
        {entries.map(([k, v]) => (
          <tr key={k}>
            <td>{k}</td>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function headerValue(h?: Record<string, string>, name?: string): string {
  if (!h || !name) return "";
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(h)) {
    if (k.toLowerCase() === target) return v;
  }
  return "";
}

function formatBody(body: string, contentType: string): string {
  if (contentType.includes("application/json")) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      // fall through
    }
  }
  return body;
}

function fmtTs(ms: number): string {
  const d = new Date(ms);
  return d.toLocaleTimeString(undefined, { hour12: false }) + "." +
    String(d.getMilliseconds()).padStart(3, "0");
}
