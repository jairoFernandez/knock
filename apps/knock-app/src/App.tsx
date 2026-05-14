import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Tree } from "./Tree";
import { Editor } from "./Editor";
import { ResponseView } from "./ResponseView";
import type { ResponseDto, WorkspaceInfo } from "./types";

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [tree, setTree] = useState<string[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [response, setResponse] = useState<ResponseDto | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function openWorkspace() {
    setError(null);
    const picked = await open({ directory: true, multiple: false });
    if (!picked || typeof picked !== "string") return;
    try {
      const info = await invoke<WorkspaceInfo>("open_workspace", { path: picked });
      setWorkspace(info);
      const files = await invoke<string[]>("list_tree", { root: info.root });
      setTree(files);
      setSelected(null);
      setContent("");
      setResponse(null);
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

  async function runRequest() {
    if (!workspace || !selected) return;
    setRunning(true);
    setError(null);
    setResponse(null);
    try {
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

  const isRequest = selected?.startsWith("requests/") ?? false;

  return (
    <div className="app">
      <div className="topbar">
        <h1>KNOCK</h1>
        <button onClick={openWorkspace}>Open workspace…</button>
        {workspace && <span className="path">{workspace.root}</span>}
        {workspace && (
          <span className="env">
            env: <code>{workspace.activeEnv ?? "(none)"}</code>
          </span>
        )}
      </div>

      <div className="panel">
        <div className="panel-header">Workspace</div>
        {!workspace && <div className="empty">Open a workspace to begin.</div>}
        {workspace && (
          <Tree files={tree} selected={selected} onSelect={setSelected} />
        )}
      </div>

      <div className="panel editor">
        <div className="panel-header">{selected ?? "Request"}</div>
        {!selected && <div className="empty">Select a file from the tree.</div>}
        {selected && (
          <>
            <Editor value={content} onChange={setContent} />
            <div className="row">
              <button
                className="primary"
                disabled={!isRequest || running}
                onClick={runRequest}
              >
                {running ? "Running…" : "Run request"}
              </button>
              {!isRequest && selected && (
                <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
                  Only files under requests/ can be run.
                </span>
              )}
            </div>
          </>
        )}
      </div>

      <div className="panel response">
        <div className="panel-header">Response</div>
        {error && <div className="error">{error}</div>}
        {!error && !response && <div className="empty">Run a request to see its response.</div>}
        {response && <ResponseView response={response} />}
      </div>
    </div>
  );
}
