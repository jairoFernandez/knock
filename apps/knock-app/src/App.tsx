import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Tree } from "./Tree";
import { Editor } from "./Editor";
import { ResponseView } from "./ResponseView";
import { NewWorkspaceModal } from "./NewWorkspaceModal";
import { UrlBar } from "./UrlBar";
import { peekRequest } from "./parseRequest";
import type { ResponseDto, TreeEntry, WorkspaceInfo } from "./types";

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [envs, setEnvs] = useState<string[]>([]);
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [response, setResponse] = useState<ResponseDto | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);

  async function loadWorkspace(info: WorkspaceInfo) {
    setSelected(null);
    setContent("");
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
          // non-fatal
        }
      }
      setWorkspace({ ...info, activeEnv: active });
    } catch (e) {
      setError(String(e));
      setWorkspace(info);
    }
  }

  async function changeEnv(name: string) {
    if (!workspace) return;
    try {
      await invoke("set_env", { root: workspace.root, name });
      setWorkspace({ ...workspace, activeEnv: name });
    } catch (e) {
      setError(String(e));
    }
  }

  async function openWorkspace() {
    setError(null);
    const picked = await open({ directory: true, multiple: false });
    if (!picked || typeof picked !== "string") return;
    try {
      const info = await invoke<WorkspaceInfo>("open_workspace", { path: picked });
      await loadWorkspace(info);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    if (!workspace || !selected) return;
    invoke<string>("read_file", { root: workspace.root, rel: selected })
      .then(setContent)
      .catch((e) => setError(String(e)));
  }, [workspace, selected]);

  const isRequest = selected?.startsWith("requests/") ?? false;
  const peek = useMemo(() => peekRequest(content), [content]);

  async function runRequest() {
    if (!workspace || !selected) return;
    setRunning(true);
    setError(null);
    setResponse(null);
    try {
      await invoke("write_file", {
        root: workspace.root,
        rel: selected,
        content,
      });
      const result = await invoke<ResponseDto>("run_request", {
        root: workspace.root,
        rel: selected,
        env: workspace.activeEnv ?? null,
      });
      setResponse(result);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="app">
      <div className="topbar">
        <h1>KNOCK</h1>
        <button onClick={() => setShowNew(true)}>New…</button>
        <button onClick={openWorkspace}>Open…</button>
        {workspace && (
          <span className="path" title={workspace.root}>
            {workspace.root.split("/").pop() || workspace.root}
          </span>
        )}
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
      </div>

      <div className="panel sidebar">
        <div className="panel-header">Workspace</div>
        {!workspace && <div className="empty">Open or create a workspace.</div>}
        {workspace && <Tree entries={entries} selected={selected} onSelect={setSelected} />}
      </div>

      <div className="panel editor-panel">
        {isRequest && (
          <UrlBar
            method={peek.method}
            url={peek.url}
            running={running}
            canRun={!!selected}
            onRun={runRequest}
          />
        )}
        {!isRequest && selected && (
          <div className="panel-header">{selected}</div>
        )}
        {!selected && <div className="empty">Select a file from the tree.</div>}
        {selected && (
          <>
            <div className="section-header">{isRequest ? "Request" : "File"}</div>
            <Editor value={content} onChange={setContent} />
          </>
        )}
      </div>

      <div className="panel response-panel">
        <div className="section-header">Response</div>
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
