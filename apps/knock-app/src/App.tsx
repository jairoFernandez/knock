import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Tree } from "./Tree";
import { Editor } from "./Editor";
import { ResponseView } from "./ResponseView";
import { NewWorkspaceModal } from "./NewWorkspaceModal";
import { NewEntryModal } from "./NewEntryModal";
import { RequestEditor } from "./RequestEditor";
import { Dashboard } from "./Dashboard";
import { Rail, type RailMode } from "./Rail";
import { FileBrowser } from "./FileBrowser";
import { GitPanel } from "./GitPanel";
import { Splitter } from "./Splitter";
import { usePersistedNumber, usePersistedString, useConfirm } from "./hooks";
import { ToolsRail } from "./ToolsRail";
import { ToolsPanel, type ToolKey } from "./ToolsPanel";
import { ConfirmDialog } from "./ConfirmDialog";
import { ColorPicker } from "./ColorPicker";
import { WorkspaceAppearanceModal } from "./WorkspaceAppearanceModal";
import { Statusbar } from "./Statusbar";
import type { DirEntryDto, RecentEntry } from "./types";
import type {
  KV,
  RequestForm,
  ResponseDto,
  TreeEntry,
  WorkspaceInfo,
} from "./types";

const win = getCurrentWindow();

function collectChildBases(
  entries: TreeEntry[],
  directories: string[],
  dirRel: string,
  folderOrders: Record<string, string[]>,
): string[] {
  const prefix = dirRel ? `${dirRel}/` : "";
  const names = new Set<string>();
  for (const e of entries) {
    if (!e.rel.startsWith(prefix)) continue;
    const rest = e.rel.slice(prefix.length);
    if (!rest) continue;
    const first = rest.split("/")[0];
    if (rest === first) names.add(first);
  }
  for (const d of directories) {
    if (!d.startsWith(prefix)) continue;
    const rest = d.slice(prefix.length);
    if (!rest) continue;
    const first = rest.split("/")[0];
    if (rest === first) names.add(first);
  }
  const order = folderOrders[dirRel] ?? [];
  const ordered: string[] = [];
  const used = new Set<string>();
  for (const n of order) {
    if (names.has(n)) {
      ordered.push(n);
      used.add(n);
    }
  }
  const rest = Array.from(names)
    .filter((n) => !used.has(n))
    .sort();
  return [...ordered, ...rest];
}

export function App() {
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  const [envs, setEnvs] = useState<string[]>([]);
  const [envVars, setEnvVars] = useState<KV[]>([]);
  const [entries, setEntries] = useState<TreeEntry[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [form, setForm] = useState<RequestForm | null>(null);
  const [rawContent, setRawContent] = useState<string>("");
  const [rawDirty, setRawDirty] = useState(false);
  const [rawSavedAt, setRawSavedAt] = useState<number | null>(null);
  const [runs, setRuns] = useState<Record<string, { response: ResponseDto; at: number }[]>>({});
  const [viewIdx, setViewIdx] = useState<Record<string, number>>({});
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showNewEntry, setShowNewEntry] = useState<false | "request" | "fragment" | "flow" | "environment" | "folder">(false);
  const [newEntryPath, setNewEntryPath] = useState<string>("");
  const [railMode, setRailMode] = useState<RailMode>("workspace");
  const [filesRefreshToken, setFilesRefreshToken] = useState(0);
  const [directories, setDirectories] = useState<string[]>([]);
  const [colors, setColors] = useState<Record<string, string>>({});
  const [folderOrders, setFolderOrders] = useState<Record<string, string[]>>({});
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [tabMeta, setTabMeta] = useState<Record<string, { name: string | null; color?: string | null; icon?: string | null }>>({});
  const [showTabPicker, setShowTabPicker] = useState(false);
  const [tabRecents, setTabRecents] = useState<RecentEntry[]>([]);
  interface TabState {
    workspace: WorkspaceInfo;
    entries: TreeEntry[];
    directories: string[];
    colors: Record<string, string>;
    folderOrders: Record<string, string[]>;
    envs: string[];
    envVars: KV[];
    selected: string | null;
    form: RequestForm | null;
    rawContent: string;
    runs: Record<string, { response: ResponseDto; at: number }[]>;
    viewIdx: Record<string, number>;
  }
  const tabStatesRef = useRef<Record<string, TabState>>({});
  const [colorTarget, setColorTarget] = useState<string | null>(null);
  const [showAppearance, setShowAppearance] = useState(false);
  const [sidebarWidth, setSidebarWidth] = usePersistedNumber("knock.layout.sidebar", 260);
  const [responseWidth, setResponseWidth] = usePersistedNumber("knock.layout.response", 480);
  const [toolsWidth, setToolsWidth] = usePersistedNumber("knock.layout.tools", 320);
  const [activeTool, setActiveTool] = usePersistedString<ToolKey>("knock.layout.toolsTab", null);
  const { pending: confirmPending, confirm, resolve: resolveConfirm } = useConfirm();

  function clampWidth(v: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, v));
  }

  const varsRecord = useMemo(() => {
    const r: Record<string, string> = {};
    for (const kv of envVars) r[kv.key] = kv.value;
    return r;
  }, [envVars]);

  async function loadWorkspace(info: WorkspaceInfo) {
    setSelected(null);
    setForm(null);
    setRawContent("");
    setRuns({});
    setViewIdx({});
    setError(null);
    try {
      const [list, envList, dirList, colorMap, orderMap] = await Promise.all([
        invoke<TreeEntry[]>("list_tree", { root: info.root }),
        invoke<string[]>("list_envs", { root: info.root }),
        invoke<DirEntryDto[]>("list_directories", { root: info.root }),
        invoke<Record<string, string>>("get_colors", { root: info.root }),
        invoke<Record<string, string[]>>("list_folder_orders", { root: info.root }),
      ]);
      setEntries(list);
      setEnvs(envList);
      setDirectories(dirList.map((d) => d.rel));
      setColors(colorMap);
      setFolderOrders(orderMap);
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
      setTabMeta((prev) => ({
        ...prev,
        [info.root]: { name: info.name, color: info.color, icon: info.icon },
      }));
      // Auto-add to tabs only when there are already other tabs (multi-tab session).
      setOpenTabs((prev) => {
        if (prev.length === 0) return prev;
        return prev.includes(info.root) ? prev : [...prev, info.root];
      });
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

  async function refreshTree(root: string) {
    try {
      const [list, dirList, colorMap, orderMap] = await Promise.all([
        invoke<TreeEntry[]>("list_tree", { root }),
        invoke<DirEntryDto[]>("list_directories", { root }),
        invoke<Record<string, string>>("get_colors", { root }),
        invoke<Record<string, string[]>>("list_folder_orders", { root }),
      ]);
      setEntries(list);
      setDirectories(dirList.map((d) => d.rel));
      setColors(colorMap);
      setFolderOrders(orderMap);
      setFilesRefreshToken((t) => t + 1);
    } catch (e) {
      setError(String(e));
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

  // Snapshot active tab state every render so switching restores instantly.
  useEffect(() => {
    if (!workspace) return;
    tabStatesRef.current[workspace.root] = {
      workspace,
      entries,
      directories,
      colors,
      folderOrders,
      envs,
      envVars,
      selected,
      form,
      rawContent,
      runs,
      viewIdx,
    };
  });

  function switchToTab(root: string) {
    const cached = tabStatesRef.current[root];
    if (!cached) return false;
    setWorkspace(cached.workspace);
    setEntries(cached.entries);
    setDirectories(cached.directories);
    setColors(cached.colors);
    setFolderOrders(cached.folderOrders);
    setEnvs(cached.envs);
    setEnvVars(cached.envVars);
    setSelected(cached.selected);
    setForm(cached.form);
    setRawContent(cached.rawContent);
    setRuns(cached.runs);
    setViewIdx(cached.viewIdx);
    setError(null);
    return true;
  }

  async function openWorkspace() {
    setError(null);
    const picked = await open({ directory: true, multiple: false });
    if (!picked || typeof picked !== "string") return;
    await openWorkspaceAt(picked);
  }

  async function openWorkspaceAt(path: string) {
    if (switchToTab(path)) return;
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
      if (!runs[selected]) {
        invoke<{ at: number; response: ResponseDto }[]>("load_history", {
          root: workspace.root,
          rel: selected,
        })
          .then((entries) => {
            if (entries.length === 0) return;
            setRuns((r) => (r[selected] ? r : { ...r, [selected]: entries }));
          })
          .catch(() => {
            /* non-fatal */
          });
      }
    } else {
      invoke<string>("read_file", { root: workspace.root, rel: selected })
        .then((content) => {
          setRawContent(content);
          setRawDirty(false);
          setRawSavedAt(null);
        })
        .catch((e) => setError(String(e)));
      setForm(null);
    }
  }, [workspace, selected, isRequest]);

  async function saveRaw() {
    if (!workspace || !selected) return;
    try {
      await invoke("write_file", {
        root: workspace.root,
        rel: selected,
        content: rawContent,
      });
      setRawDirty(false);
      setRawSavedAt(Date.now());
      // if we just saved the active env, refresh its vars
      if (
        workspace.activeEnv &&
        (selected === `environments/${workspace.activeEnv}.toml` ||
          selected === `environments/${workspace.activeEnv}.local.toml`)
      ) {
        await refreshEnvVars(workspace.root, workspace.activeEnv);
      }
    } catch (e) {
      setError(String(e));
    }
  }

  async function runRequest() {
    if (!workspace || !selected || !form) return;
    setRunning(true);
    setError(null);
    try {
      await invoke("save_request_form", {
        root: workspace.root,
        rel: selected,
        form,
      });
      if (workspace.activeEnv) {
        await refreshEnvVars(workspace.root, workspace.activeEnv);
      }
      const result = await invoke<ResponseDto>("run_request", {
        root: workspace.root,
        rel: selected,
        env: workspace.activeEnv ?? null,
      });
      const key = selected;
      setRuns((r) => {
        const next = [...(r[key] ?? []), { response: result, at: Date.now() }].slice(-20);
        return { ...r, [key]: next };
      });
      setViewIdx((v) => {
        const next = { ...v };
        delete next[key];
        return next;
      });
      await refreshTree(workspace.root);
    } catch (e) {
      setError(String(e));
    } finally {
      setRunning(false);
    }
  }

  const currentRuns = selected ? runs[selected] ?? [] : [];
  const currentIdx = selected
    ? viewIdx[selected] ?? Math.max(currentRuns.length - 1, 0)
    : 0;
  const currentResponse = currentRuns[currentIdx]?.response ?? null;
  const currentRunAt = currentRuns[currentIdx]?.at ?? null;

  if (!workspace) {
    const dashCols = activeTool ? `1fr 4px ${toolsWidth}px 36px` : `1fr 36px`;
    return (
      <div
        className="app app-dashboard"
        style={{ gridTemplateColumns: dashCols }}
      >
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
          onLoadInfo={loadWorkspace}
          confirm={confirm}
        />
        {activeTool && (
          <>
            <Splitter
              onDelta={(d) => setToolsWidth(clampWidth(toolsWidth - d, 240, 800))}
            />
            <ToolsPanel
              tool={activeTool}
              onClose={() => setActiveTool(null)}
              onNavigate={(next) => setActiveTool(next)}
            />
          </>
        )}
        <ToolsRail
          active={activeTool}
          onToggle={(t) => setActiveTool(activeTool === t ? null : t)}
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
        {confirmPending && (
          <ConfirmDialog
            {...confirmPending}
            onConfirm={() => resolveConfirm(true)}
            onCancel={() => resolveConfirm(false)}
          />
        )}
        <Statusbar />
      </div>
    );
  }

  const toolsCols = activeTool ? ` 4px ${toolsWidth}px 36px` : ` 36px`;
  const appStyle: React.CSSProperties = {
    gridTemplateColumns: `44px ${sidebarWidth}px 4px 1fr 4px ${responseWidth}px${toolsCols}`,
  };
  if (workspace.color) {
    (appStyle as Record<string, string>)["--ws-color"] = workspace.color;
  }

  return (
    <div
      className={`app${workspace.color ? " has-ws-color" : ""}`}
      style={appStyle}
    >
      <div className="topbar" data-tauri-drag-region>
        <button
          className="back-btn"
          onClick={() => {
            setWorkspace(null);
            setSelected(null);
            setForm(null);
            setRuns({});
            setViewIdx({});
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
        <div className="ws-tabs">
          {openTabs.map((root) => {
            const isActive = workspace?.root === root;
            const meta = tabMeta[root];
            const label = meta?.name || root.split("/").pop() || root;
            return (
              <div
                key={root}
                className={`ws-tab${isActive ? " active" : ""}`}
                title={root}
                style={
                  isActive && meta?.color
                    ? { background: meta.color, color: "#fff", borderColor: meta.color }
                    : undefined
                }
                onClick={async () => {
                  if (isActive) return;
                  await openWorkspaceAt(root);
                }}
              >
                {meta?.icon && <span className="workspace-icon">{meta.icon}</span>}
                <span className="ws-tab-label">{label}</span>
                <button
                  className="ws-tab-close"
                  title="Close tab"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    setOpenTabs((prev) => prev.filter((r) => r !== root));
                    delete tabStatesRef.current[root];
                    setTabMeta((prev) => {
                      const next = { ...prev };
                      delete next[root];
                      return next;
                    });
                    if (isActive) {
                      const remaining = openTabs.filter((r) => r !== root);
                      if (remaining.length > 0) {
                        openWorkspaceAt(remaining[remaining.length - 1]);
                      } else {
                        setWorkspace(null);
                        setSelected(null);
                        setForm(null);
                      }
                    }
                  }}
                >
                  ×
                </button>
              </div>
            );
          })}
          <div className="ws-tab-add-wrap" data-tauri-drag-region="false">
            <button
              className="ws-tab-add"
              data-tauri-drag-region="false"
              title="Open another workspace"
              onClick={async () => {
                if (showTabPicker) {
                  setShowTabPicker(false);
                  return;
                }
                try {
                  const r = await invoke<import("./types").RecentEntry[]>("list_recents");
                  setTabRecents(r);
                } catch {
                  setTabRecents([]);
                }
                setShowTabPicker(true);
              }}
            >
              +
            </button>
            {showTabPicker && (
              <>
                <div
                  className="tab-picker-backdrop"
                  onClick={() => setShowTabPicker(false)}
                />
                <div className="tab-picker">
                  <div className="tab-picker-section">
                    <div className="tab-picker-label">Recent workspaces</div>
                    {tabRecents.filter((r) => r.root !== workspace?.root && !openTabs.includes(r.root)).length === 0 && (
                      <div className="tab-picker-empty">No more recents</div>
                    )}
                    {tabRecents
                      .filter((r) => r.root !== workspace?.root && !openTabs.includes(r.root))
                      .map((r) => (
                        <button
                          key={r.root}
                          className="tab-picker-item"
                          title={r.root}
                          onClick={async () => {
                            setShowTabPicker(false);
                            const activeRoot = workspace?.root;
                            setOpenTabs((prev) => {
                              const next = [...prev];
                              if (activeRoot && !next.includes(activeRoot)) next.push(activeRoot);
                              if (!next.includes(r.root)) next.push(r.root);
                              return next;
                            });
                            await openWorkspaceAt(r.root);
                          }}
                        >
                          {r.icon && <span className="workspace-icon">{r.icon}</span>}
                          <span className="tab-picker-name">
                            {r.name || r.root.split("/").pop()}
                          </span>
                          <span className="tab-picker-path">{r.root}</span>
                        </button>
                      ))}
                  </div>
                  <div className="tab-picker-divider" />
                  <button
                    className="tab-picker-item action"
                    onClick={() => {
                      setShowTabPicker(false);
                      const activeRoot = workspace?.root;
                      if (activeRoot) {
                        setOpenTabs((prev) =>
                          prev.includes(activeRoot) ? prev : [...prev, activeRoot],
                        );
                      }
                      openWorkspace();
                    }}
                  >
                    Open folder…
                  </button>
                  <button
                    className="tab-picker-item action"
                    onClick={() => {
                      setShowTabPicker(false);
                      const activeRoot = workspace?.root;
                      if (activeRoot) {
                        setOpenTabs((prev) =>
                          prev.includes(activeRoot) ? prev : [...prev, activeRoot],
                        );
                      }
                      setShowNew(true);
                    }}
                  >
                    New workspace…
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
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

      <Rail mode={railMode} onChange={setRailMode} />

      <div className="panel sidebar">
        {railMode === "workspace" && (
          <>
            <div className="panel-header sidebar-header">
              <span>Workspace</span>
              <button
                className="sidebar-add"
                title="New request / fragment / flow / environment"
                onClick={() => setShowNewEntry("request")}
              >
                +
              </button>
            </div>
            {workspace && (
              <Tree
                entries={entries}
                directories={directories}
                colors={colors}
                folderOrders={folderOrders}
                selected={selected}
                onSelect={setSelected}
                onDelete={async (path) => {
                  if (!workspace) return;
                  const ok = await confirm({
                    title: "Delete file",
                    message: `Delete ${path}? This cannot be undone.`,
                    confirmLabel: "Delete",
                  });
                  if (!ok) return;
                  try {
                    await invoke("delete_entry", { root: workspace.root, rel: path });
                    if (selected === path) {
                      setSelected(null);
                      setForm(null);
                      setRawContent("");
                    }
                    await refreshTree(workspace.root);
                  } catch (e) {
                    setError(String(e));
                  }
                }}
                onRenameInline={async (path, newBase) => {
                  if (!workspace) return;
                  const parentIdx = path.lastIndexOf("/");
                  const parent = parentIdx === -1 ? "" : path.slice(0, parentIdx);
                  const target = parent ? `${parent}/${newBase}` : newBase;
                  if (target === path) return;
                  try {
                    const updated = await invoke<string>("rename_entry", {
                      root: workspace.root,
                      oldRel: path,
                      newRel: target,
                    });
                    if (selected === path) setSelected(updated);
                    else if (selected && selected.startsWith(`${path}/`)) {
                      setSelected(`${updated}${selected.slice(path.length)}`);
                    }
                    await refreshTree(workspace.root);
                  } catch (e) {
                    setError(String(e));
                  }
                }}
                onSetColor={(dirPath) => setColorTarget(dirPath)}
                onAddRequest={(folderPath) => {
                  const top = folderPath.split("/")[0];
                  if (top !== "requests") return;
                  const rest = folderPath.slice("requests".length).replace(/^\//, "");
                  setNewEntryPath(rest ? `${rest}/` : "");
                  setShowNewEntry("request");
                }}
                onCreateFolder={async (parentPath, name) => {
                  if (!workspace) return;
                  const top = parentPath.split("/")[0];
                  const kindMap: Record<string, "request" | "flow" | "fragment" | "environment"> = {
                    requests: "request",
                    flows: "flow",
                    fragments: "fragment",
                    environments: "environment",
                  };
                  const kind = kindMap[top];
                  if (!kind) return;
                  const rest = parentPath.slice(top.length).replace(/^\//, "");
                  const rel = rest ? `${rest}/${name}` : name;
                  try {
                    await invoke("create_folder", { root: workspace.root, kind, rel });
                    await refreshTree(workspace.root);
                  } catch (e) {
                    setError(String(e));
                  }
                }}
                onCreateEntry={async (parentPath, name, kind) => {
                  if (!workspace) return;
                  const top = parentPath.split("/")[0];
                  const kindDir: Record<string, string> = {
                    request: "requests",
                    flow: "flows",
                    fragment: "fragments",
                    environment: "environments",
                  };
                  if (kindDir[kind] !== top) return;
                  const rest = parentPath.slice(top.length).replace(/^\//, "");
                  const rel = rest ? `${rest}/${name}` : name;
                  try {
                    const created = await invoke<string>("create_entry", {
                      root: workspace.root,
                      kind,
                      rel,
                      url: null,
                      method: null,
                      name: null,
                    });
                    await refreshTree(workspace.root);
                    setSelected(created);
                  } catch (e) {
                    setError(String(e));
                  }
                }}
                onChangeName={async (path, name) => {
                  if (!workspace) return;
                  try {
                    await invoke("update_request_name", {
                      root: workspace.root,
                      rel: path,
                      name,
                    });
                    await refreshTree(workspace.root);
                    if (selected === path) {
                      const next = await invoke<RequestForm>("parse_request_form", {
                        root: workspace.root,
                        rel: path,
                      });
                      setForm(next);
                    }
                  } catch (e) {
                    setError(String(e));
                  }
                }}
                onChangeMethod={async (path, method) => {
                  if (!workspace) return;
                  try {
                    await invoke("update_request_method", {
                      root: workspace.root,
                      rel: path,
                      method,
                    });
                    await refreshTree(workspace.root);
                    if (selected === path) {
                      const next = await invoke<RequestForm>("parse_request_form", {
                        root: workspace.root,
                        rel: path,
                      });
                      setForm(next);
                    }
                  } catch (e) {
                    setError(String(e));
                  }
                }}
                onMove={async ({ fromPath, toParent, toIndex }) => {
                  if (!workspace) return;
                  const base = fromPath.split("/").pop()!;
                  const parentIdx = fromPath.lastIndexOf("/");
                  const fromParent = parentIdx === -1 ? "" : fromPath.slice(0, parentIdx);
                  const newRel = toParent ? `${toParent}/${base}` : base;
                  try {
                    let movedTo = fromPath;
                    if (fromParent !== toParent) {
                      movedTo = await invoke<string>("rename_entry", {
                        root: workspace.root,
                        oldRel: fromPath,
                        newRel,
                      });
                      if (selected === fromPath) setSelected(movedTo);
                      else if (selected && selected.startsWith(`${fromPath}/`)) {
                        setSelected(`${movedTo}${selected.slice(fromPath.length)}`);
                      }
                    }
                    // Compute target ordering, save explicitly.
                    const movedBase = movedTo.split("/").pop()!;
                    const allChildren = collectChildBases(
                      entries,
                      directories,
                      toParent,
                      folderOrders,
                    );
                    const filtered = allChildren.filter(
                      (n) => n !== movedBase && n !== base,
                    );
                    const ordered = [
                      ...filtered.slice(0, toIndex),
                      movedBase,
                      ...filtered.slice(toIndex),
                    ];
                    await invoke("set_folder_order", {
                      root: workspace.root,
                      dirRel: toParent,
                      order: ordered,
                    });
                    await refreshTree(workspace.root);
                  } catch (e) {
                    setError(String(e));
                  }
                }}
                onDeleteFolder={async (path) => {
                  if (!workspace) return;
                  const ok = await confirm({
                    title: "Delete folder",
                    message: `Delete folder ${path} and all its contents? This cannot be undone.`,
                    confirmLabel: "Delete folder",
                  });
                  if (!ok) return;
                  try {
                    await invoke("delete_folder", { root: workspace.root, rel: path });
                    if (selected && (selected === path || selected.startsWith(`${path}/`))) {
                      setSelected(null);
                      setForm(null);
                      setRawContent("");
                    }
                    await refreshTree(workspace.root);
                  } catch (e) {
                    setError(String(e));
                  }
                }}
              />
            )}
          </>
        )}
        {railMode === "files" && workspace && (
          <>
            <div className="panel-header">Files</div>
            <FileBrowser
              root={workspace.root}
              selected={selected}
              onSelect={setSelected}
              refreshToken={filesRefreshToken}
            />
          </>
        )}
        {railMode === "git" && workspace && (
          <>
            <div className="panel-header">Git</div>
            <GitPanel
              root={workspace.root}
              onOpenFile={(rel) => {
                setSelected(rel);
                setRailMode("files");
              }}
            />
          </>
        )}
      </div>

      <Splitter
        onDelta={(d) => setSidebarWidth(clampWidth(sidebarWidth + d, 180, 600))}
      />

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
            <div className="panel-header raw-header">
              <span>{selected}{rawDirty && <span className="dirty-mark"> •</span>}</span>
              <div className="raw-actions">
                {rawSavedAt && !rawDirty && (
                  <span className="raw-saved">saved</span>
                )}
                <button
                  className="primary"
                  onClick={saveRaw}
                  disabled={!rawDirty}
                  title="Save (Ctrl+S)"
                >
                  Save
                </button>
              </div>
            </div>
            <Editor
              value={rawContent}
              onChange={(v) => {
                setRawContent(v);
                setRawDirty(true);
              }}
              onSave={saveRaw}
            />
          </>
        )}
      </div>

      <Splitter
        onDelta={(d) => setResponseWidth(clampWidth(responseWidth - d, 240, 1200))}
      />

      <div className="panel response-panel">
        <div className="panel-header">Response</div>
        {error && <div className="error">{error}</div>}
        {!error && !currentResponse && (
          <div className="empty">
            {isRequest ? "Hit Send to fire the request." : "Open a request to send it."}
          </div>
        )}
        {currentResponse && (
          <ResponseView
            response={currentResponse}
            history={currentRuns}
            activeIdx={currentIdx}
            activeAt={currentRunAt}
            onSelectRun={(idx) => {
              if (!selected) return;
              setViewIdx((v) => ({ ...v, [selected]: idx }));
            }}
            onClearHistory={async () => {
              if (!selected) return;
              const ok = await confirm({
                title: "Clear history",
                message: "Clear all stored runs for this request?",
                confirmLabel: "Clear",
              });
              if (!ok) return;
              try {
                await invoke("clear_history", {
                  root: workspace!.root,
                  rel: selected,
                });
              } catch (e) {
                setError(String(e));
                return;
              }
              setRuns((r) => {
                const next = { ...r };
                delete next[selected];
                return next;
              });
              setViewIdx((v) => {
                const next = { ...v };
                delete next[selected];
                return next;
              });
            }}
          />
        )}
      </div>

      {activeTool && (
        <>
          <Splitter
            onDelta={(d) => setToolsWidth(clampWidth(toolsWidth - d, 240, 800))}
          />
          <ToolsPanel
            tool={activeTool}
            onClose={() => setActiveTool(null)}
            onNavigate={(next) => setActiveTool(next)}
          />
        </>
      )}

      <ToolsRail
        active={activeTool}
        onToggle={(t) => setActiveTool(activeTool === t ? null : t)}
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

      {showNewEntry && workspace && (
        <NewEntryModal
          root={workspace.root}
          initialKind={showNewEntry}
          initialPath={newEntryPath}
          onCancel={() => {
            setShowNewEntry(false);
            setNewEntryPath("");
          }}
          onCreated={async (rel, kind) => {
            setShowNewEntry(false);
            setNewEntryPath("");
            await refreshTree(workspace.root);
            if (kind !== "folder") setSelected(rel);
          }}
        />
      )}

      {colorTarget && workspace && (
        <div className="modal-backdrop" onClick={() => setColorTarget(null)}>
          <ColorPicker
            current={colors[colorTarget]}
            onClose={() => setColorTarget(null)}
            onPick={async (c) => {
              try {
                await invoke("set_color", {
                  root: workspace.root,
                  key: colorTarget,
                  color: c,
                });
                setColors((prev) => {
                  const next = { ...prev };
                  if (c) next[colorTarget] = c;
                  else delete next[colorTarget];
                  return next;
                });
              } catch (e) {
                setError(String(e));
              }
            }}
          />
        </div>
      )}

      {showAppearance && workspace && (
        <WorkspaceAppearanceModal
          root={workspace.root}
          current={{ color: workspace.color, icon: workspace.icon }}
          onCancel={() => setShowAppearance(false)}
          onSaved={(next) => {
            setShowAppearance(false);
            setWorkspace({ ...workspace, color: next.color, icon: next.icon });
          }}
        />
      )}

      {confirmPending && (
        <ConfirmDialog
          {...confirmPending}
          onConfirm={() => resolveConfirm(true)}
          onCancel={() => resolveConfirm(false)}
        />
      )}
      <Statusbar
        workspaceRoot={workspace.root}
        workspaceName={workspace.name}
        envName={workspace.activeEnv}
        hint={error ? null : selected ?? null}
      />
    </div>
  );
}
