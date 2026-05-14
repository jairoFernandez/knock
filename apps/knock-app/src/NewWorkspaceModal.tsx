import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import type { WorkspaceInfo } from "./types";

interface Props {
  onCreated: (info: WorkspaceInfo) => void;
  onCancel: () => void;
}

export function NewWorkspaceModal({ onCreated, onCancel }: Props) {
  const [parent, setParent] = useState<string>("");
  const [name, setName] = useState<string>("");
  const [git, setGit] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pickParent() {
    const picked = await open({ directory: true, multiple: false });
    if (picked && typeof picked === "string") setParent(picked);
  }

  async function create() {
    setError(null);
    if (!parent) return setError("Choose a parent directory.");
    if (!name.trim()) return setError("Enter a workspace name.");
    setBusy(true);
    try {
      const info = await invoke<WorkspaceInfo>("init_workspace", {
        parent,
        name: name.trim(),
        git,
      });
      onCreated(info);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New workspace</h2>
        <label>
          Parent directory
          <div className="row">
            <input
              type="text"
              value={parent}
              onChange={(e) => setParent(e.target.value)}
              placeholder="/path/to/parent"
            />
            <button onClick={pickParent}>Browse…</button>
          </div>
        </label>
        <label>
          Workspace name
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-api"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") create();
            }}
          />
        </label>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={git}
            onChange={(e) => setGit(e.target.checked)}
          />
          Initialize a git repo
        </label>
        {error && <div className="error">{error}</div>}
        <div className="row right">
          <button onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button className="primary" onClick={create} disabled={busy}>
            {busy ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
