import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Tree } from "./Tree";
import { Editor } from "./Editor";
import { ResponseView } from "./ResponseView";
import { NewWorkspaceModal } from "./NewWorkspaceModal";
import { RequestEditor } from "./RequestEditor";
import { Dashboard } from "./Dashboard";
import type {
  KV,
  RequestForm,
  ResponseDto,
  TreeEntry,
  WorkspaceInfo,
} from "./types";

const win = getCurrentWindow();

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [envs, setEnvs] = useState<string[]>([]);
  const [envVars, setEnvVars] = useState<KV[]>([]);
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<RequestForm | null>(null);
  const [rawContent, setRawContent] = useState<string>("");
  const [response, setResponse] = useState<ResponseDto | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  const varsRecord = useMemo(() => {
    const r: Record<string, string> = {};
    for (const kv of envVars) r[kv.key] = kv.value;
    return r;
  }, [envVars]);

  async function loadWorkspace(info: WorkspaceInfo) {
    setSelected(null);
    setForm(null);
    setRawContent("");
    setResponse(null);
    setError(null);
    try {
      const [list, envList] = await Promise.all([
        invoke<TreeEntry[]>("list_tree", { root: info.root }),
        invoke<string[]>("list_envs", { root: info.root }),
      ]);
      setEntries(list);
      setEnvs(envList);
      let active = info.activeEnv;
      if (!active && envList.length > 0) {
        const preferred = envList.includes("local") ? "local" : envList[0];
        try {
          await invoke("set_env", { root: info.root, name: preferred });
          active = preferred;
        } catch {
          /* non-fatal */
        }
      }
      const next = { ...info, activeEnv: active };
      setWorkspace(next);
      if (active) await refreshEnvVars(info.root, active);
    } catch (e) {
      setError(String(e));
      setWorkspace(info);
    }
  }

  async function refreshEnvVars(root: string, envName: string) {
    try {
      const vars = await invoke<KV[]>("get_env_vars", { root, name: envName });
      setEnvVars(vars);
    } catch {
      setEnvVars([]);
    }
  }

  async function changeEnv(name: string) {
    if (!workspace) return;
    try {
      await invoke("set_env", { root: workspace.root, name });
      setWorkspace({ ...workspace, activeEnv: name });
      await refreshEnvVars(workspace.root, name);
    } catch (e) {
      setError(String(e));
    }
  }

  async function openWorkspace() {
    setError(null);
    const picked = await open({ directory: true, multiple: false });
    if (!picked || typeof picked !== "string") return;
    await openWorkspaceAt(picked);
  }

  async function openWorkspaceAt(path: string) {
    setError(null);
    try {
      const info = await invoke<WorkspaceInfo>("open_workspace", { path });
      await loadWorkspace(info);
    } catch (e) {
      setError(String(e));
    }
  }

  const isRequest = selected?.startsWith("requests/") ?? false;

  useEffect(() => {
    if (!workspace || !selected) return;
    setError(null);
    if (isRequest) {
      invoke<RequestForm>("parse_request_form", { root: workspace.root, rel: selected })
        .then(setForm)
        .catch((e) => setError(String(e)));
      setRawContent("");
    } else {
      invoke<string>("read_file", { root: workspace.root, rel: selected })
        .then(setRawContent)
        .catch((e) => setError(String(e)));
      setForm(null);
    }
  }, [workspace, selected, isRequest]);

  async function runRequest() {
    if (!workspace || !selected || !form) return;
    setRunning(true);
    setError(null);
    setResponse(null);
    try {
      await invoke("save_request_form", {
        root: workspace.root,
        rel: selected,
        form,
      });
      const result = await invoke<ResponseDto>("run_request", {
        root: workspace.root,
        rel: selected,
        env: workspace.activeEnv ?? null,
      });
      setResponse(result);
      // refresh tree in case method/name changed
      const list = await invoke<TreeEntry[]>("list_tree", { root: workspace.root });
      setEntries(list);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  if (!workspace) {
    return (
      <div className="app app-dashboard">
        <div className="topbar" data-tauri-drag-region>
          <h1 data-tauri-drag-region>KNOCK</h1>
          <div className="topbar-spacer" data-tauri-drag-region />
          <div className="win-controls">
            <button className="win-btn" onClick={() => win.minimize()} title="Minimize">
              <svg width="10" height="10" viewBox="0 0 10 10"><rect y="4.5" width="10" height="1" fill="currentColor"/></svg>
            </button>
            <button className="win-btn" onClick={() => win.toggleMaximize()} title="Maximize">
              <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor"/></svg>
            </button>
            <button className="win-btn close" onClick={() => win.close()} title="Close">
              <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1,1 L9,9 M9,1 L1,9" stroke="currentColor" strokeWidth="1.2"/></svg>
            </button>
          </div>
        </div>
        <Dashboard
          onOpen={openWorkspaceAt}
          onPickDirectory={openWorkspace}
          onCreate={() => setShowNew(true)}
        />
        {showNew && (
          <NewWorkspaceModal
            onCancel={() => setShowNew(false)}
            onCreated={async (info) => {
              setShowNew(false);
              await loadWorkspace(info);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="app">
      <div className="topbar" data-tauri-drag-region>
        <button
          className="back-btn"
          onClick={() => {
            setWorkspace(null);
            setSelected(null);
            setForm(null);
            setResponse(null);
            setError(null);
          }}
          title="Back to dashboard"
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M9 3 L5 7 L9 11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        </button>
        <h1 data-tauri-drag-region>KNOCK</h1>
        <button onClick={() => setShowNew(true)}>New…</button>
        <button onClick={openWorkspace}>Open…</button>
        {workspace && (
          <span className="workspace-name" title={workspace.root} data-tauri-drag-region>
            {workspace.name || workspace.root.split("/").pop() || workspace.root}
          </span>
        )}
        <div className="topbar-spacer" data-tauri-drag-region />
        {workspace && envs.length > 0 && (
          <select
            className="env-select"
            value={workspace.activeEnv ?? ""}
            onChange={(e) => changeEnv(e.target.value)}
            title="Active environment"
          >
            {!workspace.activeEnv && <option value="">— env —</option>}
            {envs.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        )}
        <div className="win-controls">
          <button className="win-btn" onClick={() => win.minimize()} title="Minimize">
            <svg width="10" height="10" viewBox="0 0 10 10"><rect y="4.5" width="10" height="1" fill="currentColor"/></svg>
          </button>
          <button className="win-btn" onClick={() => win.toggleMaximize()} title="Maximize">
            <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" fill="none" stroke="currentColor"/></svg>
          </button>
          <button className="win-btn close" onClick={() => win.close()} title="Close">
            <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1,1 L9,9 M9,1 L1,9" stroke="currentColor" strokeWidth="1.2"/></svg>
          </button>
        </div>
      </div>

      <div className="panel sidebar">
        <div className="panel-header">Workspace</div>
        {!workspace && <div className="empty">Open or create a workspace.</div>}
        {workspace && <Tree entries={entries} selected={selected} onSelect={setSelected} />}
      </div>

      <div className="panel editor-panel">
        {!selected && <div className="empty">Select a request from the tree.</div>}
        {selected && isRequest && form && (
          <RequestEditor
            form={form}
            vars={varsRecord}
            running={running}
            onChange={setForm}
            onSend={runRequest}
          />
        )}
        {selected && !isRequest && (
          <>
            <div className="panel-header">{selected}</div>
            <Editor value={rawContent} onChange={setRawContent} />
          </>
        )}
      </div>

      <div className="panel response-panel">
        <div className="panel-header">Response</div>
        {error && <div className="error">{error}</div>}
        {!error && !response && (
          <div className="empty">
            {isRequest ? "Hit Send to fire the request." : "Open a request to send it."}
          </div>
        )}
        {response && <ResponseView response={response} />}
      </div>

      {showNew && (
        <NewWorkspaceModal
          onCancel={() => setShowNew(false)}
          onCreated={async (info) => {
            setShowNew(false);
            await loadWorkspace(info);
          }}
        />
      )}
    </div>
  );
}
