import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { KubeconfigEditor } from "./KubeconfigEditor";
import { highlightYaml } from "./yamlHighlight";
import { lazy, Suspense } from "react";
const KubeTerminalsPane = lazy(() =>
  import("./KubeTerminalsPane").then((m) => ({ default: m.KubeTerminalsPane })),
);

const DEFAULT_PROJECT = "default";

interface KubeEntry {
  name: string;
  project: string;
  encrypted: boolean;
  createdAt: number;
  sizeBytes: number;
}

type Status = { kind: "idle" } | { kind: "info"; text: string } | { kind: "error"; text: string };
type Mode =
  | { kind: "idle" }
  | { kind: "use"; name: string; project: string }
  | { kind: "add" }
  | { kind: "edit"; name: string; project: string };

interface TerminalInfo {
  id: string;
  label: string;
  available: boolean;
}

export function KubeconfigsView() {
  const [storeDir, setStoreDir] = useState<string>("");
  const [entries, setEntries] = useState<KubeEntry[]>([]);
  const [projects, setProjects] = useState<string[]>([DEFAULT_PROJECT]);
  const [mode, setMode] = useState<Mode>({ kind: "idle" });
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem("knock.kube.sidebar.collapsed") === "1";
    } catch {
      return false;
    }
  });
  function toggleSidebar() {
    setSidebarCollapsed((v) => {
      const next = !v;
      try {
        localStorage.setItem("knock.kube.sidebar.collapsed", next ? "1" : "0");
      } catch {
        /* non-fatal */
      }
      return next;
    });
  }
  const [preferredTerminal, setPreferredTerminal] = useState<string>("auto");
  const [terminals, setTerminals] = useState<TerminalInfo[]>([]);
  const [showSettings, setShowSettings] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const list = await invoke<KubeEntry[]>("kubeconfig_list");
      setEntries(list);
      const dir = await invoke<string>("kubeconfig_store_dir");
      setStoreDir(dir);
      const projs = await invoke<string[]>("kubeconfig_list_projects");
      setProjects(projs.length ? projs : [DEFAULT_PROJECT]);
    } catch (e) {
      setStatus({ kind: "error", text: String(e) });
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const s = await invoke<{ preferredTerminal: string }>("kubeconfig_settings_get");
      setPreferredTerminal(s.preferredTerminal || "auto");
      const t = await invoke<TerminalInfo[]>("kubeconfig_list_terminals");
      setTerminals(t);
    } catch (e) {
      // non-fatal — settings file may not exist yet
      console.warn("kubeconfig settings load:", e);
    }
  }, []);

  useEffect(() => {
    refresh();
    loadSettings();
  }, [refresh, loadSettings]);

  async function changePreferredTerminal(id: string) {
    setPreferredTerminal(id);
    try {
      await invoke("kubeconfig_settings_set", { preferredTerminal: id });
    } catch (e) {
      setStatus({ kind: "error", text: String(e) });
    }
  }

  async function doRemove(name: string, project: string) {
    if (!confirm(`Delete kubeconfig '${name}' from project '${project}'?`)) return;
    setBusy(true);
    try {
      await invoke("kubeconfig_remove", { name, project });
      if (
        (mode.kind === "use" || mode.kind === "edit") &&
        mode.name === name &&
        mode.project === project
      ) {
        setMode({ kind: "idle" });
      }
      setStatus({ kind: "info", text: `Removed '${name}'` });
      await refresh();
    } catch (e) {
      setStatus({ kind: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  const grouped = useMemo(() => {
    const byProj = new Map<string, KubeEntry[]>();
    for (const p of projects) byProj.set(p, []);
    for (const e of entries) {
      if (!byProj.has(e.project)) byProj.set(e.project, []);
      byProj.get(e.project)!.push(e);
    }
    return Array.from(byProj.entries()).sort(([a], [b]) => {
      if (a === DEFAULT_PROJECT) return -1;
      if (b === DEFAULT_PROJECT) return 1;
      return a.localeCompare(b);
    });
  }, [entries, projects]);

  function isSelected(name: string, project: string): boolean {
    if (mode.kind === "use" || mode.kind === "edit") {
      return mode.name === name && mode.project === project;
    }
    return false;
  }

  return (
    <div className="kube-view">
      <div className="kube-toolbar">
        <div className="kube-toolbar-title">
          <span className="kube-toolbar-h">Kubeconfigs</span>
          <span className="kube-toolbar-sub">
            {entries.length} stored across {projects.length} project{projects.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="kube-toolbar-actions">
          <button
            className="kube-gear"
            onClick={toggleSidebar}
            title={sidebarCollapsed ? "Show list" : "Hide list"}
          >
            {sidebarCollapsed ? "›" : "‹"}
          </button>
          <div className="kube-settings-wrap">
            <button
              className="kube-gear"
              onClick={() => setShowSettings((v) => !v)}
              title="Settings"
            >
              ⚙
            </button>
            {showSettings && (
              <div className="kube-settings-popover">
                <div className="kube-settings-row">
                  <label className="kube-label">Preferred terminal</label>
                  <select
                    className="kube-input"
                    value={preferredTerminal}
                    onChange={(e) => changePreferredTerminal(e.target.value)}
                  >
                    {terminals.map((t) => (
                      <option key={t.id} value={t.id} disabled={!t.available}>
                        {t.label}
                        {!t.available ? " (not found)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="kube-settings-actions">
                  <button onClick={() => setShowSettings(false)}>Close</button>
                </div>
              </div>
            )}
          </div>
          <button
            className="primary"
            onClick={() => {
              setStatus({ kind: "idle" });
              setMode({ kind: "add" });
            }}
            disabled={busy}
          >
            + New
          </button>
        </div>
      </div>

      {status.kind !== "idle" && (
        <div className={`kube-status kube-status-${status.kind}`}>
          <span>{status.text}</span>
          <button className="kube-status-dismiss" onClick={() => setStatus({ kind: "idle" })}>
            ×
          </button>
        </div>
      )}

      <div className={`kube-body ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
        <aside className="kube-list">
          {grouped.map(([project, items]) => {
            const open = !collapsed[project];
            return (
              <div key={project} className="kube-group">
                <button
                  className="kube-group-header"
                  onClick={() => setCollapsed((c) => ({ ...c, [project]: !c[project] }))}
                >
                  <span className="kube-group-caret">{open ? "▾" : "▸"}</span>
                  <span className="kube-group-name">{project}</span>
                  <span className="kube-group-count">{items.length}</span>
                </button>
                {open && (
                  <ul>
                    {items.length === 0 && (
                      <li className="kube-empty kube-empty-row">empty</li>
                    )}
                    {items.map((e) => (
                      <li
                        key={`${e.project}/${e.name}`}
                        className={`kube-item ${isSelected(e.name, e.project) ? "selected" : ""}`}
                        onClick={() => setMode({ kind: "use", name: e.name, project: e.project })}
                      >
                        <div className="kube-item-name">
                          <span className="kube-item-icon" title={e.encrypted ? "Encrypted" : "Plaintext"}>
                            {e.encrypted ? "🔒" : "📄"}
                          </span>
                          {e.name}
                        </div>
                        <div className="kube-item-meta">
                          {formatSize(e.sizeBytes)} · {formatDate(e.createdAt)}
                        </div>
                        <button
                          className="kube-remove"
                          onClick={(ev) => {
                            ev.stopPropagation();
                            doRemove(e.name, e.project);
                          }}
                          title="Delete"
                        >
                          ×
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
          <div className="kube-store-dir" title={storeDir}>
            {storeDir}
          </div>
        </aside>

        <main className="kube-detail">
          {mode.kind === "idle" && (
            <div className="kube-placeholder">
              <div className="kube-placeholder-h">Select a kubeconfig</div>
              <div className="kube-placeholder-sub">
                Pick one from the list to view/decrypt, or click <strong>+ New</strong> to add one.
              </div>
            </div>
          )}
          {mode.kind === "use" && (
            <UsePanel
              key={`${mode.project}/${mode.name}`}
              name={mode.name}
              project={mode.project}
              entry={entries.find((e) => e.name === mode.name && e.project === mode.project)}
              busy={busy}
              setBusy={setBusy}
              setStatus={setStatus}
              onClose={() => setMode({ kind: "idle" })}
              onDelete={() => doRemove(mode.name, mode.project)}
              onEdit={() =>
                setMode({ kind: "edit", name: mode.name, project: mode.project })
              }
            />
          )}
          {mode.kind === "add" && (
            <AddPanel
              projects={projects}
              busy={busy}
              setBusy={setBusy}
              setStatus={setStatus}
              onCancel={() => setMode({ kind: "idle" })}
              onSaved={async (name, project) => {
                await refresh();
                setMode({ kind: "use", name, project });
              }}
            />
          )}
          {mode.kind === "edit" && (
            <EditPanel
              key={`${mode.project}/${mode.name}`}
              name={mode.name}
              project={mode.project}
              entry={entries.find((e) => e.name === mode.name && e.project === mode.project)}
              busy={busy}
              setBusy={setBusy}
              setStatus={setStatus}
              onCancel={() => setMode({ kind: "use", name: mode.name, project: mode.project })}
              onSaved={async (name, project) => {
                await refresh();
                setMode({ kind: "use", name, project });
              }}
            />
          )}
        </main>
      </div>
    </div>
  );
}

interface UsePanelProps {
  name: string;
  project: string;
  entry?: KubeEntry;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setStatus: (s: Status) => void;
  onClose: () => void;
  onDelete: () => void;
  onEdit: () => void;
}

function UsePanel({
  name,
  project,
  entry,
  busy,
  setBusy,
  setStatus,
  onClose,
  onDelete,
  onEdit,
}: UsePanelProps) {
  const encrypted = entry?.encrypted ?? true;
  const [pass, setPass] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);

  const [termsExpanded, setTermsExpanded] = useState(false);

  useEffect(() => {
    setPass("");
    setRevealed(null);
  }, [name, project]);

  const canEmbed = !encrypted || !!pass;
  const spawnArgs = canEmbed
    ? { name, project, encrypted, passphrase: encrypted ? pass : null }
    : null;

  async function callWith<T>(fn: (passphrase: string | undefined) => Promise<T>): Promise<T | null> {
    if (encrypted && !pass) {
      setStatus({ kind: "error", text: "Passphrase required" });
      return null;
    }
    setBusy(true);
    try {
      return await fn(encrypted ? pass : undefined);
    } catch (e) {
      setStatus({ kind: "error", text: String(e) });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function doReveal() {
    const out = await callWith((p) =>
      invoke<string>("kubeconfig_get", { name, project, passphrase: p }),
    );
    if (out !== null) {
      setRevealed(out);
      setStatus({ kind: "info", text: encrypted ? "Decrypted in memory." : "Loaded." });
    }
  }
  async function doExport() {
    const path = await callWith((p) =>
      invoke<string>("kubeconfig_export_temp", { name, project, passphrase: p }),
    );
    if (path) {
      await navigator.clipboard.writeText(path).catch(() => undefined);
      setStatus({ kind: "info", text: `Wrote temp file (path copied): ${path}` });
    }
  }
  async function doShell() {
    const path = await callWith((p) =>
      invoke<string>("kubeconfig_export_temp", { name, project, passphrase: p }),
    );
    if (path) {
      const cmd = `export KUBECONFIG=${shellQuote(path)}`;
      await navigator.clipboard.writeText(cmd).catch(() => undefined);
      setStatus({ kind: "info", text: `Copied: ${cmd}` });
    }
  }
  async function doOpenTerminal() {
    const term = await callWith((p) =>
      invoke<string>("kubeconfig_open_terminal", {
        name,
        project,
        passphrase: p,
        terminal: null,
      }),
    );
    if (term) {
      setStatus({ kind: "info", text: `Opened ${term} with KUBECONFIG loaded.` });
    }
  }

  return (
    <section className={`kube-panel ${termsExpanded ? "terms-expanded" : ""}`}>
      <header className="kube-panel-header">
        <div>
          <div className="kube-panel-title">
            {name} <span className="kube-panel-tag">{project}</span>
            {!encrypted && <span className="kube-panel-tag kube-panel-tag-warn">plaintext</span>}
            {encrypted && <span className="kube-panel-tag">encrypted</span>}
          </div>
          {entry && (
            <div className="kube-panel-sub">
              {formatSize(entry.sizeBytes)} · stored {formatDate(entry.createdAt)}
            </div>
          )}
        </div>
        <div className="kube-actions">
          <button onClick={onClose}>Close</button>
          <button onClick={onEdit} disabled={busy}>
            Edit
          </button>
          <button className="danger" onClick={onDelete} disabled={busy}>
            Delete
          </button>
        </div>
      </header>

      <div className="kube-section">
        <div className="kube-section-title">{encrypted ? "Unlock" : "View"}</div>
        {encrypted && (
          <div className="kube-unlock-row">
            <input
              className="kube-input"
              type="password"
              value={pass}
              onChange={(e) => setPass(e.target.value)}
              placeholder="Passphrase"
              autoComplete="off"
              onKeyDown={(e) => {
                if (e.key === "Enter") doReveal();
              }}
            />
            <button className="primary" onClick={doReveal} disabled={busy}>
              Decrypt
            </button>
          </div>
        )}
        {!encrypted && (
          <div className="kube-actions">
            <button className="primary" onClick={doReveal} disabled={busy}>
              Show contents
            </button>
          </div>
        )}
        <div className="kube-actions kube-actions-spaced">
          <button className="primary" onClick={doOpenTerminal} disabled={busy}>
            Open in terminal
          </button>
          <button onClick={doShell} disabled={busy}>
            Copy <code>export KUBECONFIG=…</code>
          </button>
          <button onClick={doExport} disabled={busy}>
            Save as temp file
          </button>
        </div>
      </div>

      {revealed !== null && (
        <div className="kube-section">
          <div className="kube-section-header">
            <div className="kube-section-title">Contents</div>
            <div className="kube-actions">
              <button
                onClick={() => navigator.clipboard.writeText(revealed).catch(() => undefined)}
              >
                Copy
              </button>
              <button onClick={() => setRevealed(null)}>Hide</button>
            </div>
          </div>
          <pre
            className="kube-revealed"
            dangerouslySetInnerHTML={{ __html: highlightYaml(revealed) + "\n" }}
          />
        </div>
      )}

      <div className="kube-section kube-section-grow kube-terms-section">
        <div className="kube-section-header">
          <div className="kube-section-title">Embedded terminals</div>
          <div className="kube-actions">
            {encrypted && !pass && (
              <span className="kube-subtle">Enter passphrase above to start new sessions.</span>
            )}
            <button
              className="kube-gear"
              onClick={() => setTermsExpanded((v) => !v)}
              title={termsExpanded ? "Restore" : "Expand"}
            >
              {termsExpanded ? "⤡" : "⤢"}
            </button>
          </div>
        </div>
        <Suspense fallback={<div className="kube-empty">Loading terminals…</div>}>
          <KubeTerminalsPane spawnArgs={spawnArgs} />
        </Suspense>
      </div>
    </section>
  );
}

interface AddPanelProps {
  projects: string[];
  busy: boolean;
  setBusy: (b: boolean) => void;
  setStatus: (s: Status) => void;
  onCancel: () => void;
  onSaved: (name: string, project: string) => void | Promise<void>;
}

function AddPanel({ projects, busy, setBusy, setStatus, onCancel, onSaved }: AddPanelProps) {
  const [name, setName] = useState("");
  const [content, setContent] = useState("");
  const [project, setProject] = useState<string>(projects[0] ?? DEFAULT_PROJECT);
  const [newProject, setNewProject] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [encrypt, setEncrypt] = useState(true);
  const [pass, setPass] = useState("");
  const [pass2, setPass2] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [showPass, setShowPass] = useState(false);

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
        setContent(text);
        if (!name) {
          const base = picked.split(/[\\/]/).pop() ?? "";
          const stem = base.replace(/\.(ya?ml|config|conf)$/i, "");
          if (stem) setName(sanitizeName(stem));
        }
      } catch (e) {
        setStatus({ kind: "error", text: `Read file failed: ${e}` });
      }
    }
  }

  async function doSave() {
    setStatus({ kind: "idle" });
    if (!name) return setStatus({ kind: "error", text: "Name required" });
    if (!content) return setStatus({ kind: "error", text: "Content required" });
    const targetProject = creatingProject ? sanitizeName(newProject) : project;
    if (!targetProject) return setStatus({ kind: "error", text: "Project required" });
    if (encrypt) {
      if (!pass) return setStatus({ kind: "error", text: "Passphrase required" });
      if (pass !== pass2) return setStatus({ kind: "error", text: "Passphrases do not match" });
    }
    setBusy(true);
    try {
      await invoke<KubeEntry>("kubeconfig_add", {
        name,
        project: targetProject,
        content,
        passphrase: encrypt ? pass : null,
        overwrite,
      });
      setStatus({ kind: "info", text: `Saved '${name}' in '${targetProject}'` });
      await onSaved(name, targetProject);
    } catch (e) {
      setStatus({ kind: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="kube-panel">
      <header className="kube-panel-header">
        <div>
          <div className="kube-panel-title">New kubeconfig</div>
          <div className="kube-panel-sub">
            {encrypt
              ? "Encrypted with your passphrase before leaving memory."
              : "Stored as plaintext on disk (no passphrase)."}
          </div>
        </div>
        <div className="kube-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={doSave} disabled={busy}>
            Save
          </button>
        </div>
      </header>

      <div className="kube-section">
        <div className="kube-field-row">
          <div className="kube-field">
            <label className="kube-label">Name</label>
            <input
              className="kube-input"
              value={name}
              onChange={(e) => setName(sanitizeName(e.target.value))}
              placeholder="prod-cluster"
              autoComplete="off"
            />
          </div>
          <div className="kube-field">
            <label className="kube-label">Project</label>
            {!creatingProject ? (
              <select
                className="kube-input"
                value={project}
                onChange={(e) => {
                  if (e.target.value === "__new__") {
                    setCreatingProject(true);
                    setNewProject("");
                  } else {
                    setProject(e.target.value);
                  }
                }}
              >
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
                <option disabled>──────────</option>
                <option value="__new__">+ New project…</option>
              </select>
            ) : (
              <div className="kube-field-inline">
                <input
                  className="kube-input"
                  value={newProject}
                  onChange={(e) => setNewProject(sanitizeName(e.target.value))}
                  placeholder="client-x"
                  autoFocus
                />
                <button
                  onClick={() => {
                    setCreatingProject(false);
                    setNewProject("");
                  }}
                  title="Cancel"
                >
                  ×
                </button>
              </div>
            )}
          </div>
        </div>
        <div className="kube-field">
          <label className="kube-label">Source file (optional)</label>
          <div className="kube-actions">
            <button onClick={pickFile} disabled={busy}>
              Pick file…
            </button>
            <span className="kube-subtle">
              {content ? `${content.length} chars loaded` : "or paste/type below"}
            </span>
          </div>
        </div>
      </div>

      <div className="kube-section kube-section-grow">
        <div className="kube-section-header">
          <div className="kube-section-title">Content</div>
          <div className="kube-subtle">Ctrl/Cmd+Space for suggestions</div>
        </div>
        <KubeconfigEditor
          value={content}
          onChange={setContent}
          placeholder={"apiVersion: v1\nkind: Config\nclusters: []\ncontexts: []\nusers: []\n"}
        />
      </div>

      <div className="kube-section">
        <div className="kube-section-title">Storage</div>
        <label className="kube-checkbox">
          <input
            type="checkbox"
            checked={encrypt}
            onChange={(e) => setEncrypt(e.target.checked)}
          />
          <span>Encrypt with passphrase (Argon2id + AES-256-GCM)</span>
        </label>
        {encrypt && (
          <>
            <div className="kube-field-row">
              <div className="kube-field">
                <label className="kube-label">Set passphrase</label>
                <input
                  className="kube-input"
                  type={showPass ? "text" : "password"}
                  value={pass}
                  onChange={(e) => setPass(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <div className="kube-field">
                <label className="kube-label">Confirm</label>
                <input
                  className="kube-input"
                  type={showPass ? "text" : "password"}
                  value={pass2}
                  onChange={(e) => setPass2(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
            </div>
            <label className="kube-checkbox">
              <input
                type="checkbox"
                checked={showPass}
                onChange={(e) => setShowPass(e.target.checked)}
              />
              <span>Show passphrase</span>
            </label>
          </>
        )}
        <label className="kube-checkbox">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
          />
          <span>Overwrite if name exists in this project</span>
        </label>
      </div>
    </section>
  );
}

interface EditPanelProps {
  name: string;
  project: string;
  entry?: KubeEntry;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setStatus: (s: Status) => void;
  onCancel: () => void;
  onSaved: (name: string, project: string) => void | Promise<void>;
}

function EditPanel({
  name,
  project,
  entry,
  busy,
  setBusy,
  setStatus,
  onCancel,
  onSaved,
}: EditPanelProps) {
  const encrypted = entry?.encrypted ?? true;
  const [unlockPass, setUnlockPass] = useState("");
  const [unlocked, setUnlocked] = useState(false);
  const [content, setContent] = useState("");
  const [originalContent, setOriginalContent] = useState("");
  const [keepEncrypted, setKeepEncrypted] = useState(encrypted);
  const [changePass, setChangePass] = useState(false);
  const [newPass, setNewPass] = useState("");
  const [newPass2, setNewPass2] = useState("");
  const [showPass, setShowPass] = useState(false);

  useEffect(() => {
    setUnlocked(false);
    setUnlockPass("");
    setContent("");
    setOriginalContent("");
    setKeepEncrypted(encrypted);
    setChangePass(false);
    setNewPass("");
    setNewPass2("");
  }, [name, project, encrypted]);

  // Auto-unlock for plaintext entries
  useEffect(() => {
    if (!encrypted && !unlocked) {
      (async () => {
        setBusy(true);
        try {
          const text = await invoke<string>("kubeconfig_get", { name, project, passphrase: null });
          setContent(text);
          setOriginalContent(text);
          setUnlocked(true);
        } catch (e) {
          setStatus({ kind: "error", text: String(e) });
        } finally {
          setBusy(false);
        }
      })();
    }
    // intentionally not depending on busy/setStatus
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encrypted, name, project]);

  async function doUnlock() {
    if (!unlockPass) {
      setStatus({ kind: "error", text: "Passphrase required" });
      return;
    }
    setBusy(true);
    try {
      const text = await invoke<string>("kubeconfig_get", {
        name,
        project,
        passphrase: unlockPass,
      });
      setContent(text);
      setOriginalContent(text);
      setUnlocked(true);
      setStatus({ kind: "info", text: "Unlocked for editing." });
    } catch (e) {
      setStatus({ kind: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  async function doSave() {
    setStatus({ kind: "idle" });
    if (!content) {
      setStatus({ kind: "error", text: "Content required" });
      return;
    }
    let savePass: string | null = null;
    if (keepEncrypted) {
      if (changePass || !encrypted) {
        if (!newPass) {
          setStatus({ kind: "error", text: "New passphrase required" });
          return;
        }
        if (newPass !== newPass2) {
          setStatus({ kind: "error", text: "Passphrases do not match" });
          return;
        }
        savePass = newPass;
      } else {
        savePass = unlockPass;
      }
    }
    setBusy(true);
    try {
      await invoke<KubeEntry>("kubeconfig_add", {
        name,
        project,
        content,
        passphrase: savePass,
        overwrite: true,
      });
      setStatus({ kind: "info", text: `Saved '${name}'` });
      await onSaved(name, project);
    } catch (e) {
      setStatus({ kind: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  }

  const dirty =
    unlocked &&
    (content !== originalContent ||
      keepEncrypted !== encrypted ||
      (keepEncrypted && (changePass || !encrypted)));

  if (encrypted && !unlocked) {
    return (
      <section className="kube-panel">
        <header className="kube-panel-header">
          <div>
            <div className="kube-panel-title">
              Edit {name} <span className="kube-panel-tag">{project}</span>
            </div>
            <div className="kube-panel-sub">Unlock with current passphrase.</div>
          </div>
          <div className="kube-actions">
            <button onClick={onCancel}>Cancel</button>
          </div>
        </header>
        <div className="kube-section">
          <div className="kube-section-title">Unlock</div>
          <div className="kube-unlock-row">
            <input
              className="kube-input"
              type="password"
              value={unlockPass}
              onChange={(e) => setUnlockPass(e.target.value)}
              placeholder="Current passphrase"
              autoComplete="off"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") doUnlock();
              }}
            />
            <button className="primary" onClick={doUnlock} disabled={busy}>
              Unlock
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="kube-panel">
      <header className="kube-panel-header">
        <div>
          <div className="kube-panel-title">
            Edit {name} <span className="kube-panel-tag">{project}</span>
            {!encrypted && <span className="kube-panel-tag kube-panel-tag-warn">plaintext</span>}
          </div>
          <div className="kube-panel-sub">{dirty ? "Unsaved changes." : "No changes."}</div>
        </div>
        <div className="kube-actions">
          <button onClick={onCancel}>Cancel</button>
          <button className="primary" onClick={doSave} disabled={busy || !dirty}>
            Save
          </button>
        </div>
      </header>

      <div className="kube-section kube-section-grow">
        <div className="kube-section-header">
          <div className="kube-section-title">Content</div>
          <div className="kube-subtle">Ctrl/Cmd+Space for suggestions</div>
        </div>
        <KubeconfigEditor value={content} onChange={setContent} />
      </div>

      <div className="kube-section">
        <div className="kube-section-title">Storage</div>
        <label className="kube-checkbox">
          <input
            type="checkbox"
            checked={keepEncrypted}
            onChange={(e) => setKeepEncrypted(e.target.checked)}
          />
          <span>Encrypt with passphrase</span>
        </label>
        {keepEncrypted && encrypted && (
          <label className="kube-checkbox">
            <input
              type="checkbox"
              checked={changePass}
              onChange={(e) => setChangePass(e.target.checked)}
            />
            <span>Change passphrase</span>
          </label>
        )}
        {keepEncrypted && (changePass || !encrypted) && (
          <>
            <div className="kube-field-row">
              <div className="kube-field">
                <label className="kube-label">New passphrase</label>
                <input
                  className="kube-input"
                  type={showPass ? "text" : "password"}
                  value={newPass}
                  onChange={(e) => setNewPass(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
              <div className="kube-field">
                <label className="kube-label">Confirm</label>
                <input
                  className="kube-input"
                  type={showPass ? "text" : "password"}
                  value={newPass2}
                  onChange={(e) => setNewPass2(e.target.value)}
                  autoComplete="new-password"
                />
              </div>
            </div>
            <label className="kube-checkbox">
              <input
                type="checkbox"
                checked={showPass}
                onChange={(e) => setShowPass(e.target.checked)}
              />
              <span>Show passphrase</span>
            </label>
          </>
        )}
      </div>
    </section>
  );
}

function sanitizeName(s: string): string {
  return s.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
}

function shellQuote(s: string): string {
  if (/^[A-Za-z0-9_\-./:=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function formatSize(b: number): string {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(2)} MB`;
}

function formatDate(secs: number): string {
  if (!secs) return "—";
  const d = new Date(secs * 1000);
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
