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

interface Props {
  workspaceRoot: string;
}

const MAX_LOGS = 500;

export function MockView({ workspaceRoot }: Props) {
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
  const [editorSaving, setEditorSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);
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
    try {
      const r = await invoke<MockResponseRead>("mock_read_response", {
        workspaceRoot,
        requestRel: rel,
      });
      setEditorOrigin(r.origin);
      setEditorStatus(r.edit.status ? String(r.edit.status) : "200");
      setEditorAuth(r.edit.auth ?? "");
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
      const edit: MockResponseEdit = {
        status: Number.isNaN(statusNum) ? 200 : statusNum,
        headers,
        auth: editorAuth.trim() || null,
        delay_ms: null,
        body_json: editorBodyKind === "json" ? editorBody : null,
        body_text: editorBodyKind === "text" ? editorBody : null,
      };
      await invoke("mock_save_response", {
        workspaceRoot,
        requestRel: selectedRel,
        edit,
      });
      await refreshPreview();
      setEditorOrigin("sibling");
      // hot-reload: if the server is running for this workspace, restart
      // so the new response takes effect on the next request.
      if (sameWorkspace) {
        try {
          await invoke("mock_stop");
          const portNum = port.trim() ? parseInt(port, 10) : null;
          const s = await invoke<MockStatus>("mock_start", {
            workspaceRoot,
            bind: bind.trim() || null,
            port: portNum && !Number.isNaN(portNum) ? portNum : null,
          });
          setStatus(s);
        } catch (e) {
          setEditorError(`saved, but reload failed: ${e}`);
        }
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
          <div className="mock-section-header">
            Routes {preview ? `(${preview.routes.length})` : ""}
          </div>
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
                Auth scheme
                <input
                  type="text"
                  value={editorAuth}
                  onChange={(e) => setEditorAuth(e.target.value)}
                  placeholder="(none)"
                />
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
              </div>
              <textarea
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
              {editorError && <div className="mock-error">{editorError}</div>}
              <div className="mock-editor-actions">
                <button
                  className="primary"
                  onClick={saveEditor}
                  disabled={editorSaving}
                >
                  {editorSaving ? "Saving…" : "Save"}
                </button>
                {editorOrigin === "sibling" && (
                  <button onClick={clearEditor} disabled={editorSaving}>
                    Delete mocks file
                  </button>
                )}
                <span className="mock-editor-hint">
                  Saves to <code>mocks/{selectedRel}</code>. Server auto-reloads
                  if running.
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
