import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";

interface KubeEntry {
  name: string;
  createdAt: number;
  sizeBytes: number;
}

type Status = { kind: "idle" } | { kind: "info"; text: string } | { kind: "error"; text: string };

export function KubeconfigsView() {
  const [storeDir, setStoreDir] = useState<string>("");
  const [entries, setEntries] = useState<KubeEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [busy, setBusy] = useState(false);

  // add form
  const [addName, setAddName] = useState("");
  const [addContent, setAddContent] = useState("");
  const [addPass, setAddPass] = useState("");
  const [addPass2, setAddPass2] = useState("");
  const [addOverwrite, setAddOverwrite] = useState(false);

  // reveal form
  const [revealPass, setRevealPass] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await invoke<KubeEntry[]>("kubeconfig_list");
      setEntries(list);
      const dir = await invoke<string>("kubeconfig_store_dir");
      setStoreDir(dir);
    } catch (e) {
      setStatus({ kind: "error", text: String(e) });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    setRevealed(null);
    setRevealPass("");
  }, [selected]);

  async function pickFile() {
    const picked = await open({
      multiple: false,
      filters: [
        { name: "kubeconfig", extensions: ["yaml", "yml", "config", "conf"] },
        { name: "All", extensions: ["*"] },
      ],
    });
    if (picked && typeof picked === "string") {
      try {
        const text = await invoke<string>("kubeconfig_read_path", { path: picked });
        setAddContent(text);
        if (!addName) {
          const base = picked.split(/[\\/]/).pop() ?? "";
          const stem = base.replace(/\.(ya?ml|config|conf)$/i, "");
          if (stem) setAddName(sanitizeName(stem));
        }
      } catch (e) {
        setStatus({ kind: "error", text: `Read file failed: ${e}` });
      }
    }
  }

  async function doAdd() {
    setStatus({ kind: "idle" });
    if (!addName) return setStatus({ kind: "error", text: "Name required" });
    if (!addContent) return setStatus({ kind: "error", text: "Content required" });
    if (!addPass) return setStatus({ kind: "error", text: "Passphrase required" });
    if (addPass !== addPass2) return setStatus({ kind: "error", text: "Passphrases do not match" });
    setBusy(true);
    try {
      await invoke<KubeEntry>("kubeconfig_add", {
        name: addName,
        content: addContent,
        passphrase: addPass,
        overwrite: addOverwrite,
      });
      setStatus({ kind: "info", text: `Saved '${addName}'` });
      setAddName("");
      setAddContent("");
      setAddPass("");
      setAddPass2("");
      setAddOverwrite(false);
      await refresh();
    } catch (e) {
      setStatus({ kind: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function doRemove(name: string) {
    if (!confirm(`Delete kubeconfig '${name}'? Encrypted file will be erased.`)) return;
    setBusy(true);
    try {
      await invoke("kubeconfig_remove", { name });
      if (selected === name) setSelected(null);
      setStatus({ kind: "info", text: `Removed '${name}'` });
      await refresh();
    } catch (e) {
      setStatus({ kind: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function doReveal() {
    if (!selected) return;
    if (!revealPass) return setStatus({ kind: "error", text: "Passphrase required" });
    setBusy(true);
    try {
      const text = await invoke<string>("kubeconfig_get", {
        name: selected,
        passphrase: revealPass,
      });
      setRevealed(text);
      setStatus({ kind: "info", text: "Decrypted" });
    } catch (e) {
      setRevealed(null);
      setStatus({ kind: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function doExportTemp() {
    if (!selected) return;
    if (!revealPass) return setStatus({ kind: "error", text: "Passphrase required" });
    setBusy(true);
    try {
      const path = await invoke<string>("kubeconfig_export_temp", {
        name: selected,
        passphrase: revealPass,
      });
      await navigator.clipboard.writeText(path).catch(() => undefined);
      setStatus({ kind: "info", text: `Wrote temp file (path copied): ${path}` });
    } catch (e) {
      setStatus({ kind: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function copyShellExport() {
    if (!selected) return;
    if (!revealPass) return setStatus({ kind: "error", text: "Passphrase required" });
    setBusy(true);
    try {
      const path = await invoke<string>("kubeconfig_export_temp", {
        name: selected,
        passphrase: revealPass,
      });
      const cmd = `export KUBECONFIG=${shellQuote(path)}`;
      await navigator.clipboard.writeText(cmd).catch(() => undefined);
      setStatus({ kind: "info", text: `Copied: ${cmd}` });
    } catch (e) {
      setStatus({ kind: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="kube-view">
      <div className="kube-header">
        <span>Kubeconfigs</span>
        <span className="kube-subtle" title={storeDir}>
          {storeDir}
        </span>
      </div>

      {status.kind !== "idle" && (
        <div className={`kube-status kube-status-${status.kind}`}>{status.text}</div>
      )}

      <div className="kube-body">
        <div className="kube-list">
          <div className="kube-section-title">Stored ({entries.length})</div>
          {entries.length === 0 && <div className="kube-empty">(none yet — add one →)</div>}
          <ul>
            {entries.map((e) => (
              <li
                key={e.name}
                className={`kube-item ${selected === e.name ? "selected" : ""}`}
                onClick={() => setSelected(e.name)}
              >
                <div className="kube-item-name">{e.name}</div>
                <div className="kube-item-meta">
                  {e.sizeBytes} B · {formatDate(e.createdAt)}
                </div>
                <button
                  className="kube-remove"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    doRemove(e.name);
                  }}
                  title="Delete"
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="kube-detail">
          {selected ? (
            <>
              <div className="kube-section-title">Use '{selected}'</div>
              <label className="kube-label">Passphrase</label>
              <input
                type="password"
                value={revealPass}
                onChange={(e) => setRevealPass(e.target.value)}
                placeholder="Passphrase to decrypt"
                autoComplete="off"
              />
              <div className="kube-actions">
                <button className="primary" onClick={doReveal} disabled={busy}>
                  Decrypt
                </button>
                <button onClick={doExportTemp} disabled={busy}>
                  Export to temp file
                </button>
                <button onClick={copyShellExport} disabled={busy}>
                  Copy `export KUBECONFIG=…`
                </button>
              </div>
              {revealed !== null && (
                <>
                  <div className="kube-section-title">Decrypted</div>
                  <div className="kube-actions">
                    <button
                      onClick={() => navigator.clipboard.writeText(revealed).catch(() => undefined)}
                    >
                      Copy
                    </button>
                    <button onClick={() => setRevealed(null)}>Hide</button>
                  </div>
                  <textarea className="kube-textarea" readOnly value={revealed} />
                </>
              )}
            </>
          ) : (
            <div className="kube-empty">Select a kubeconfig on the left, or add one below.</div>
          )}

          <div className="kube-section-title">Add new</div>
          <div className="kube-grid">
            <label className="kube-label">Name</label>
            <input
              value={addName}
              onChange={(e) => setAddName(sanitizeName(e.target.value))}
              placeholder="prod-cluster"
              autoComplete="off"
            />
            <label className="kube-label">Source</label>
            <div className="kube-actions">
              <button onClick={pickFile} disabled={busy}>
                Pick file…
              </button>
              <span className="kube-subtle">
                {addContent ? `${addContent.length} chars loaded` : "or paste below"}
              </span>
            </div>
            <label className="kube-label">Content</label>
            <textarea
              className="kube-textarea"
              value={addContent}
              onChange={(e) => setAddContent(e.target.value)}
              placeholder="apiVersion: v1\nkind: Config\n..."
            />
            <label className="kube-label">Passphrase</label>
            <input
              type="password"
              value={addPass}
              onChange={(e) => setAddPass(e.target.value)}
              autoComplete="new-password"
            />
            <label className="kube-label">Confirm</label>
            <input
              type="password"
              value={addPass2}
              onChange={(e) => setAddPass2(e.target.value)}
              autoComplete="new-password"
            />
            <label className="kube-label">Overwrite</label>
            <label className="kube-checkbox">
              <input
                type="checkbox"
                checked={addOverwrite}
                onChange={(e) => setAddOverwrite(e.target.checked)}
              />
              <span>Replace if name exists</span>
            </label>
          </div>
          <div className="kube-actions">
            <button className="primary" onClick={doAdd} disabled={busy}>
              Encrypt & save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function sanitizeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./:=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function formatDate(secs: number): string {
  if (!secs) return "—";
  const d = new Date(secs * 1000);
  return d.toLocaleString();
}
