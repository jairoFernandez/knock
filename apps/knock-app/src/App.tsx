import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { Tree } from "./Tree";
import { Editor } from "./Editor";
import { ResponseView } from "./ResponseView";
import { NewWorkspaceModal } from "./NewWorkspaceModal";
import { NewEntryModal } from "./NewEntryModal";
import { RequestEditor } from "./RequestEditor";
import { Dashboard } from "./Dashboard";
import {
  GlobalRail,
  ProjectRail,
  type GlobalRailMode,
  type ProjectRailMode,
} from "./Rail";
import { FileBrowser } from "./FileBrowser";
import { GitPanel } from "./GitPanel";
import { KubeconfigsView } from "./KubeconfigsView";
import { WindowControls, detectIsMac } from "./WindowControls";
import { Splitter } from "./Splitter";
import { usePersistedNumber, usePersistedString, useConfirm } from "./hooks";
import { ToolsRail } from "./ToolsRail";
import { ToolsPanel, type ToolKey } from "./ToolsPanel";
import { ConfirmDialog } from "./ConfirmDialog";
import { ColorPicker } from "./ColorPicker";
import { WorkspaceAppearanceModal } from "./WorkspaceAppearanceModal";
import { Statusbar, SCALE_STEP, clampScale } from "./Statusbar";
import { OpenApiImportModal } from "./OpenApiImportModal";
import { OpenApiView } from "./OpenApiView";
import { MockView } from "./MockView";
import { BottomTerminalDock } from "./BottomTerminalDock";
import { terminalStore, type KubeTerminalSpawnArgs } from "./kubeTerminalStore";
import type { DirEntryDto, RecentEntry } from "./types";
import type {
  KV,
  RequestForm,
  ResponseDto,
  TreeEntry,
  WorkspaceInfo,
} from "./types";

const TAB_GROUPS_KEY = "knock.layout.tabGroups";

function loadTabGroups(): Record<string, string[]> {
  try {
    const raw = localStorage.getItem(TAB_GROUPS_KEY);
    if (raw) return JSON.parse(raw) as Record<string, string[]>;
  } catch {
    /* non-fatal */
  }
  return {};
}

function persistTabGroups(groups: Record<string, string[]>): void {
  try {
    localStorage.setItem(TAB_GROUPS_KEY, JSON.stringify(groups));
  } catch {
    /* non-fatal */
  }
}

function dedupe(list: string[]): string[] {
  return Array.from(new Set(list));
}

function writeGroup(
  groups: Record<string, string[]>,
  root: string,
  tabs: string[],
): void {
  const unique = dedupe(tabs);
  if (unique.length === 0 || (unique.length === 1 && unique[0] === root)) {
    delete groups[root];
  } else {
    groups[root] = unique;
  }
  persistTabGroups(groups);
}

function appendToAnchor(
  groups: Record<string, string[]>,
  anchor: string,
  currentTabs: string[],
  newRoot: string,
): string[] {
  const merged = dedupe([...currentTabs, anchor, newRoot]);
  if (merged.length === 1 && merged[0] === anchor) {
    delete groups[anchor];
  } else {
    groups[anchor] = merged;
  }
  persistTabGroups(groups);
  return merged;
}

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
  const [globalMode, setGlobalMode] = useState<GlobalRailMode>("requests");
  const [projectMode, setProjectMode] = useState<ProjectRailMode>("workspace");
  const isMacPlatform = useMemo(() => detectIsMac(), []);
  const [filesRefreshToken, setFilesRefreshToken] = useState(0);
  const [directories, setDirectories] = useState<string[]>([]);
  const [colors, setColors] = useState<Record<string, string>>({});
  const [folderOrders, setFolderOrders] = useState<Record<string, string[]>>({});
  const [openTabs, setOpenTabs] = useState<string[]>([]);
  const [anchorRoot, setAnchorRoot] = useState<string | null>(null);
  const anchorRootRef = useRef<string | null>(null);
  const openTabsRef = useRef<string[]>([]);
  const tabGroupsRef = useRef<Record<string, string[]>>(loadTabGroups());
  const pendingSourceRef = useRef<"primary" | "secondary">("primary");

  useEffect(() => {
    anchorRootRef.current = anchorRoot;
  }, [anchorRoot]);

  useEffect(() => {
    openTabsRef.current = openTabs;
  }, [openTabs]);
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
  const [terminalDockHeight, setTerminalDockHeight] = usePersistedNumber("knock.layout.terminalDock", 300);
  const [activeTool, setActiveTool] = usePersistedString<ToolKey>("knock.layout.toolsTab", null);
  const [terminalSpawnArgs, setTerminalSpawnArgs] = useState<KubeTerminalSpawnArgs | null>(null);
  const [terminalDockExpanded, setTerminalDockExpanded] = useState(true);
  const [terminalDockMaximized, setTerminalDockMaximized] = useState(false);
  const [uiScaleRaw, setUiScaleRaw] = usePersistedNumber("knock.ui.scale", 1);
  const uiScale = clampScale(uiScaleRaw);
  const setUiScale = (v: number) => setUiScaleRaw(clampScale(v));
  const { pending: confirmPending, confirm, resolve: resolveConfirm } = useConfirm();

  useEffect(() => {
    const el = document.documentElement as HTMLElement & { style: CSSStyleDeclaration & { zoom?: string } };
    el.style.zoom = String(uiScale);
    el.style.setProperty("--ui-zoom", String(uiScale));
    return () => {
      el.style.zoom = "";
      el.style.removeProperty("--ui-zoom");
    };
  }, [uiScale]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "=" || e.key === "+") {
        e.preventDefault();
        setUiScale(uiScale + SCALE_STEP);
      } else if (e.key === "-" || e.key === "_") {
        e.preventDefault();
        setUiScale(uiScale - SCALE_STEP);
      } else if (e.key === "0") {
        e.preventDefault();
        setUiScale(1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [uiScale]);

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
      const [list, envList, dirList, colorMap, orderMap] = await Promise.all([
        invoke<TreeEntry[]>("list_tree", { root }),
        invoke<string[]>("list_envs", { root }),
        invoke<DirEntryDto[]>("list_directories", { root }),
        invoke<Record<string, string>>("get_colors", { root }),
        invoke<Record<string, string[]>>("list_folder_orders", { root }),
      ]);
      setEntries(list);
      setEnvs(envList);
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

  type OpenSource = "primary" | "secondary";

  async function openWorkspace(source: OpenSource = "primary") {
    setError(null);
    const picked = await open({ directory: true, multiple: false });
    if (!picked || typeof picked !== "string") return;
    await openWorkspaceAt(picked, source);
  }

  function activateForSource(root: string, source: OpenSource) {
    if (source === "primary") {
      const stored = tabGroupsRef.current[root];
      const group = stored && stored.length > 0 ? dedupe(stored) : [root];
      const final = group.includes(root) ? group : [...group, root];
      setAnchorRoot(root);
      anchorRootRef.current = root;
      setOpenTabs(final);
      openTabsRef.current = final;
      return;
    }
    const anchor = anchorRootRef.current ?? root;
    if (!anchorRootRef.current) {
      setAnchorRoot(anchor);
      anchorRootRef.current = anchor;
    }
    const merged = appendToAnchor(
      tabGroupsRef.current,
      anchor,
      openTabsRef.current,
      root,
    );
    setOpenTabs(merged);
    openTabsRef.current = merged;
  }

  async function openWorkspaceAt(path: string, source: OpenSource = "primary") {
    if (switchToTab(path)) {
      activateForSource(path, source);
      return;
    }
    setError(null);
    try {
      const info = await invoke<WorkspaceInfo>("open_workspace", { path });
      await loadWorkspace(info);
      activateForSource(info.root, source);
    } catch (e) {
      setError(String(e));
    }
  }

  const isRequest = selected?.startsWith("requests/") ?? false;
  const isOpenApi =
    selected === "openapi/spec.json" || selected === "openapi/spec.yaml";
  const [showOpenApiImport, setShowOpenApiImport] = useState(false);

  useEffect(() => {
    if (!workspace || !selected) return;
    setError(null);
    if (isOpenApi) {
      setForm(null);
      setRawContent("");
      return;
    }
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
  }, [workspace, selected, isRequest, isOpenApi]);

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
  useSyncExternalStore(
    (cb) => terminalStore.subscribe(cb),
    () => terminalStore.revision,
    () => terminalStore.revision,
  );
  const terminalDockVisible = terminalStore.tabs.length > 0;
  const terminalDockRowHeight = terminalDockMaximized
    ? "minmax(0, calc((100vh / var(--ui-zoom, 1)) - 58px))"
    : `${terminalDockExpanded ? terminalDockHeight : 34}px`;
  const terminalDockRows = terminalDockVisible
    ? `34px minmax(0, 1fr) ${terminalDockRowHeight} 24px`
    : undefined;

  async function openPlainShell() {
    await terminalStore.openGeneralTab({ cwd: workspace?.root ?? null });
    setTerminalDockExpanded(true);
  }

  if (!workspace) {
    const dashCols = activeTool ? `44px 1fr 4px ${toolsWidth}px 36px` : `44px 1fr 36px`;
    return (
      <div
        className={`app app-dashboard${terminalDockVisible ? " has-terminal-dock" : ""}${isMacPlatform ? " is-mac" : ""}`}
        style={{
          gridTemplateColumns: dashCols,
          ...(terminalDockRows ? { gridTemplateRows: terminalDockRows } : {}),
        }}
      >
        <div className="topbar" data-tauri-drag-region>
          <h1 data-tauri-drag-region>KNOCK</h1>
          <div className="topbar-spacer" data-tauri-drag-region />
          <WindowControls />
        </div>
        <GlobalRail mode={globalMode} onChange={setGlobalMode} />
        {globalMode === "kube" ? (
          <KubeconfigsView
            onTerminalContextChange={setTerminalSpawnArgs}
            onTerminalStarted={() => {
              setTerminalDockExpanded(true);
            }}
          />
        ) : (
          <Dashboard
            onOpen={(root) => openWorkspaceAt(root, "primary")}
            onPickDirectory={() => openWorkspace("primary")}
            onCreate={() => {
              pendingSourceRef.current = "primary";
              setShowNew(true);
            }}
            onLoadInfo={async (info) => {
              await loadWorkspace(info);
              activateForSource(info.root, "primary");
            }}
            confirm={confirm}
          />
        )}
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
            onCancel={() => {
              setShowNew(false);
              pendingSourceRef.current = "primary";
            }}
            onCreated={async (info) => {
              setShowNew(false);
              const source = pendingSourceRef.current;
              pendingSourceRef.current = "primary";
              await loadWorkspace(info);
              activateForSource(info.root, source);
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
        {terminalDockVisible && (
          <BottomTerminalDock
            spawnArgs={terminalSpawnArgs}
            expanded={terminalDockExpanded}
            maximized={terminalDockMaximized}
            onExpandedChange={setTerminalDockExpanded}
            onMaximizedChange={setTerminalDockMaximized}
            onHeightDelta={(d) =>
              setTerminalDockHeight(clampWidth(terminalDockHeight + d, 120, 720))
            }
          />
        )}
        <Statusbar
          scale={uiScale}
          onScaleChange={setUiScale}
          onOpenShell={() => {
            void openPlainShell();
          }}
        />
      </div>
    );
  }

  const toolsCols = activeTool ? ` 4px ${toolsWidth}px 36px` : ` 36px`;
  const appStyle: React.CSSProperties = {
    gridTemplateColumns:
      globalMode === "kube"
        ? `minmax(0, 1fr)${toolsCols}`
        : `44px ${sidebarWidth}px 4px 1fr 4px ${responseWidth}px${toolsCols}`,
  };
  if (terminalDockRows) {
    appStyle.gridTemplateRows = terminalDockRows;
  }
  if (workspace.color) {
    (appStyle as Record<string, string>)["--ws-color"] = workspace.color;
  }

  return (
    <div
      className={`app${workspace.color ? " has-ws-color" : ""}${terminalDockVisible ? " has-terminal-dock" : ""}${isMacPlatform ? " is-mac" : ""}`}
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
        <button
          onClick={() => {
            pendingSourceRef.current = "primary";
            setShowNew(true);
          }}
        >
          New…
        </button>
        <button onClick={() => openWorkspace("primary")}>Open…</button>
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
                  if (isActive) {
                    setShowAppearance(true);
                    return;
                  }
                  await openWorkspaceAt(root, "secondary");
                }}
              >
                {meta?.icon && <span className="workspace-icon">{meta.icon}</span>}
                <span className="ws-tab-label">{label}</span>
                <button
                  className="ws-tab-close"
                  title="Close tab"
                  onClick={(ev) => {
                    ev.stopPropagation();
                    const next = dedupe(openTabs.filter((r) => r !== root));
                    setOpenTabs(next);
                    openTabsRef.current = next;
                    const anchor = anchorRootRef.current;
                    if (anchor === root) {
                      // Closing anchor: drop anchor's stored group entirely.
                      delete tabGroupsRef.current[root];
                      const newAnchor = next[next.length - 1] ?? null;
                      setAnchorRoot(newAnchor);
                      anchorRootRef.current = newAnchor;
                      if (newAnchor && next.length > 1) {
                        writeGroup(tabGroupsRef.current, newAnchor, next);
                      } else if (newAnchor) {
                        delete tabGroupsRef.current[newAnchor];
                      }
                      persistTabGroups(tabGroupsRef.current);
                    } else if (anchor) {
                      writeGroup(tabGroupsRef.current, anchor, next);
                    }
                    delete tabStatesRef.current[root];
                    setTabMeta((prev) => {
                      const nextMeta = { ...prev };
                      delete nextMeta[root];
                      return nextMeta;
                    });
                    if (isActive) {
                      if (next.length > 0) {
                        openWorkspaceAt(next[next.length - 1], "secondary");
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
                            await openWorkspaceAt(r.root, "secondary");
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
                      openWorkspace("secondary");
                    }}
                  >
                    Open folder…
                  </button>
                  <button
                    className="tab-picker-item action"
                    onClick={() => {
                      setShowTabPicker(false);
                      pendingSourceRef.current = "secondary";
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
        <WindowControls />
      </div>

      {globalMode === "requests" && (
        <ProjectRail mode={projectMode} onChange={setProjectMode} />
      )}

      <div className="panel sidebar">
        {projectMode === "workspace" && globalMode === "requests" && (
          <>
            <div className="panel-header sidebar-header">
              <span>Workspace</span>
              <div style={{ display: "flex", gap: 4 }}>
                <button
                  className="sidebar-add"
                  title="Import OpenAPI spec"
                  onClick={() => setShowOpenApiImport(true)}
                >
                  ❖
                </button>
                <button
                  className="sidebar-add"
                  title="New request / fragment / flow / environment"
                  onClick={() => setShowNewEntry("request")}
                >
                  +
                </button>
              </div>
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
        {projectMode === "files" && globalMode === "requests" && workspace && (
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
        {projectMode === "git" && globalMode === "requests" && workspace && (
          <>
            <div className="panel-header">Git</div>
            <GitPanel
              root={workspace.root}
              onOpenFile={(rel) => {
                setSelected(rel);
                setProjectMode("files");
              }}
            />
          </>
        )}
        {projectMode === "mock" && globalMode === "requests" && workspace && (
          <>
            <div className="panel-header">Mock server</div>
            <div className="mock-sidebar-hint">
              Start a local HTTP server built from this workspace's requests.
              Live request logs appear on the right.
            </div>
          </>
        )}
        {globalMode === "kube" && (
          <>
            <div className="panel-header">Kubeconfigs</div>
            <div className="kube-sidebar-hint">
              Encrypted with a passphrase (Argon2id + AES-256-GCM). Stored locally per user.
            </div>
          </>
        )}
      </div>

      <Splitter
        onDelta={(d) => setSidebarWidth(clampWidth(sidebarWidth + d, 180, 600))}
      />

      <div className="panel editor-panel">
        {globalMode === "kube" && (
          <KubeconfigsView
            onTerminalContextChange={setTerminalSpawnArgs}
            onTerminalStarted={() => {
              setTerminalDockExpanded(true);
            }}
          />
        )}
        {globalMode === "requests" && projectMode === "mock" && workspace && (
          <MockView workspaceRoot={workspace.root} />
        )}
        {globalMode === "requests" && projectMode !== "mock" && !selected && <div className="empty">Select a request from the tree.</div>}
        {globalMode === "requests" && projectMode !== "mock" && selected && isRequest && form && (
          <RequestEditor
            form={form}
            vars={varsRecord}
            running={running}
            onChange={setForm}
            onSend={runRequest}
          />
        )}
        {globalMode === "requests" && projectMode !== "mock" && selected && isOpenApi && workspace && (
          <OpenApiView
            root={workspace.root}
            rel={selected}
            onSelectRequest={(rel) => setSelected(rel)}
            onTreeChanged={(tree) => setEntries(tree)}
            onReimport={() => setShowOpenApiImport(true)}
          />
        )}
        {globalMode === "requests" && projectMode !== "mock" && selected && !isRequest && !isOpenApi && (
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

      {globalMode === "requests" && (
        <Splitter
          onDelta={(d) => setResponseWidth(clampWidth(responseWidth - d, 240, 1200))}
        />
      )}

      {globalMode === "requests" && (
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
      )}

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
          onCancel={() => {
            setShowNew(false);
            pendingSourceRef.current = "primary";
          }}
          onCreated={async (info) => {
            setShowNew(false);
            const source = pendingSourceRef.current;
            pendingSourceRef.current = "primary";
            await loadWorkspace(info);
            activateForSource(info.root, source);
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
            setTabMeta((prev) => ({
              ...prev,
              [workspace.root]: {
                ...(prev[workspace.root] ?? { name: workspace.name }),
                color: next.color,
                icon: next.icon,
              },
            }));
          }}
        />
      )}

      {showOpenApiImport && workspace && (
        <OpenApiImportModal
          root={workspace.root}
          onCancel={() => setShowOpenApiImport(false)}
          onDone={async (tree) => {
            setShowOpenApiImport(false);
            setEntries(tree);
            await refreshTree(workspace.root);
            setSelected(
              tree.find((t) => t.kind === "openapi")?.rel ?? null,
            );
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
      {terminalDockVisible && (
        <BottomTerminalDock
          spawnArgs={terminalSpawnArgs}
          expanded={terminalDockExpanded}
          maximized={terminalDockMaximized}
          onExpandedChange={setTerminalDockExpanded}
          onMaximizedChange={setTerminalDockMaximized}
          onHeightDelta={(d) =>
            setTerminalDockHeight(clampWidth(terminalDockHeight + d, 120, 720))
          }
        />
      )}
      <Statusbar
        workspaceRoot={workspace.root}
        workspaceName={workspace.name}
        envName={workspace.activeEnv}
        hint={error ? null : selected ?? null}
        scale={uiScale}
        onScaleChange={setUiScale}
        onOpenShell={() => {
          void openPlainShell();
        }}
      />
    </div>
  );
}
