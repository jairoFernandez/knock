import { useState } from "react";
import type { EntryKind, TreeEntry } from "./types";

export type SectionKind = "request" | "fragment" | "flow" | "environment";

interface TreeProps {
  entries: TreeEntry[];
  directories: string[];
  selected: string | null;
  colors: Record<string, string>;
  onSelect: (path: string) => void;
  onDelete?: (path: string) => void;
  onDeleteFolder?: (path: string) => void;
  onRename?: (path: string) => void;
  onSetColor?: (dirPath: string) => void;
  onAddInSection?: (kind: SectionKind) => void;
}

const SECTIONS: { kind: SectionKind; dir: string; label: string }[] = [
  { kind: "request", dir: "requests", label: "Requests" },
  { kind: "flow", dir: "flows", label: "Flows" },
  { kind: "fragment", dir: "fragments", label: "Fragments" },
  { kind: "environment", dir: "environments", label: "Environments" },
];

interface Node {
  name: string;
  path: string;
  entry?: TreeEntry;
  children: Node[];
}

function buildTree(entries: TreeEntry[], directories: string[]): Node {
  const root: Node = { name: "", path: "", children: [] };
  const dirMap = new Map<string, Node>();
  dirMap.set("", root);

  function ensureDirChain(segments: string[]): Node {
    let parentPath = "";
    let parent = root;
    for (const name of segments) {
      const path = parentPath ? `${parentPath}/${name}` : name;
      const existing = dirMap.get(path);
      if (existing) {
        parent = existing;
      } else {
        const node: Node = { name, path, children: [] };
        parent.children.push(node);
        dirMap.set(path, node);
        parent = node;
      }
      parentPath = path;
    }
    return parent;
  }

  const sortedFiles = [...entries].sort((a, b) => a.rel.localeCompare(b.rel));
  for (const entry of sortedFiles) {
    const segments = entry.rel.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    const fileName = segments[segments.length - 1];
    const dirSegments = segments.slice(0, -1);
    const parent = ensureDirChain(dirSegments);
    parent.children.push({ name: fileName, path: entry.rel, entry, children: [] });
  }
  for (const dir of directories) {
    const segments = dir.split("/").filter(Boolean);
    if (segments.length === 0) continue;
    ensureDirChain(segments);
  }
  return root;
}

function methodClass(method: string | null | undefined): string {
  if (!method) return "method-any";
  const m = method.toUpperCase();
  if (m === "GET") return "method-get";
  if (m === "POST") return "method-post";
  if (m === "PUT") return "method-put";
  if (m === "PATCH") return "method-patch";
  if (m === "DELETE") return "method-delete";
  if (m === "HEAD" || m === "OPTIONS") return "method-head";
  return "method-any";
}

function kindIcon(kind: EntryKind | undefined): string {
  switch (kind) {
    case "fragment": return "◇";
    case "environment": return "▦";
    case "flow": return "⇉";
    case "config": return "⚙";
    default: return "·";
  }
}

interface RenderState {
  selected: string | null;
  collapsed: Set<string>;
  toggle: (path: string) => void;
  onSelect: (path: string) => void;
  onDelete?: (path: string) => void;
  onDeleteFolder?: (path: string) => void;
  onRename?: (path: string) => void;
  onSetColor?: (path: string) => void;
  colors: Record<string, string>;
}

function renderNode(node: Node, depth: number, state: RenderState): JSX.Element[] {
  const items: JSX.Element[] = [];
  const childrenSorted = [...node.children].sort((a, b) => {
    const aIsDir = !a.entry;
    const bIsDir = !b.entry;
    if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of childrenSorted) {
    const pad = { paddingLeft: 8 + depth * 16 };
    if (child.entry) {
      const e = child.entry;
      const label = e.kind === "request" ? e.name ?? child.name.replace(/\.toml$/, "") : child.name.replace(/\.toml$/, "");
      const isProtected = e.kind === "config";
      items.push(
        <div
          key={child.path}
          className={`tree-item file${state.selected === child.path ? " selected" : ""}`}
          style={pad}
          onClick={() => state.onSelect(child.path)}
          title={child.path}
        >
          {e.kind === "request" ? (
            <span className={`method-chip ${methodClass(e.method)}`}>
              {e.method ?? "REQ"}
            </span>
          ) : (
            <span className="kind-glyph">{kindIcon(e.kind)}</span>
          )}
          <span className="tree-label">{label}</span>
          <div className="tree-row-actions">
            {!isProtected && state.onRename && (
              <button
                className="tree-action"
                title="Rename / move"
                onClick={(ev) => {
                  ev.stopPropagation();
                  state.onRename!(child.path);
                }}
              >
                ✎
              </button>
            )}
            {!isProtected && state.onDelete && (
              <button
                className="tree-action tree-delete"
                title="Delete"
                onClick={(ev) => {
                  ev.stopPropagation();
                  state.onDelete!(child.path);
                }}
              >
                ×
              </button>
            )}
          </div>
        </div>,
      );
    } else {
      const isCollapsed = state.collapsed.has(child.path);
      const color = state.colors[child.path];
      const dirStyle = { ...pad, ...(color ? { borderLeft: `2px solid ${color}` } : {}) };
      items.push(
        <div
          key={child.path}
          className={`tree-item dir ${color ? "has-color" : ""}`}
          style={dirStyle}
          onClick={() => state.toggle(child.path)}
        >
          <span className={`dir-glyph ${isCollapsed ? "collapsed" : "open"}`}>
            {isCollapsed ? "▸" : "▾"}
          </span>
          <span className="tree-label">{child.name}</span>
          <div className="tree-row-actions">
            {state.onSetColor && (
              <button
                className="tree-action tree-color"
                title="Set color"
                style={color ? { color } : undefined}
                onClick={(ev) => {
                  ev.stopPropagation();
                  state.onSetColor!(child.path);
                }}
              >
                ●
              </button>
            )}
            {state.onRename && (
              <button
                className="tree-action"
                title="Rename / move folder"
                onClick={(ev) => {
                  ev.stopPropagation();
                  state.onRename!(child.path);
                }}
              >
                ✎
              </button>
            )}
            {state.onDeleteFolder && (
              <button
                className="tree-action tree-delete"
                title="Delete folder"
                onClick={(ev) => {
                  ev.stopPropagation();
                  state.onDeleteFolder!(child.path);
                }}
              >
                ×
              </button>
            )}
          </div>
        </div>,
      );
      if (!isCollapsed) {
        items.push(...renderNode(child, depth + 1, state));
      }
    }
  }
  return items;
}

export function Tree({
  entries,
  directories,
  selected,
  colors,
  onSelect,
  onDelete,
  onDeleteFolder,
  onRename,
  onSetColor,
  onAddInSection,
}: TreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const tree = buildTree(entries, directories);
  const state: RenderState = {
    selected,
    collapsed,
    toggle,
    onSelect,
    onDelete,
    onDeleteFolder,
    onRename,
    onSetColor,
    colors,
  };

  const childByName = new Map<string, Node>();
  for (const c of tree.children) childByName.set(c.name, c);
  const knownDirs = new Set(SECTIONS.map((s) => s.dir));
  const otherChildren = tree.children.filter((c) => !knownDirs.has(c.name));

  return (
    <div className="tree">
      {SECTIONS.map((sec) => {
        const node = childByName.get(sec.dir);
        const isCollapsed = node ? collapsed.has(node.path) : false;
        return (
          <div key={sec.kind} className="tree-section">
            <div
              className="tree-section-header"
              onClick={() => node && toggle(node.path)}
            >
              {node && (
                <span className={`dir-glyph ${isCollapsed ? "collapsed" : "open"}`}>
                  {isCollapsed ? "▸" : "▾"}
                </span>
              )}
              <span className="tree-section-label">{sec.label}</span>
              {onAddInSection && (
                <button
                  className="tree-section-add"
                  title={`New ${sec.label.toLowerCase().replace(/s$/, "")}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    onAddInSection(sec.kind);
                  }}
                >
                  +
                </button>
              )}
            </div>
            {node && !isCollapsed && renderNode(node, 1, state)}
          </div>
        );
      })}
      {otherChildren.length > 0 && (
        <div className="tree-section">
          <div className="tree-section-header">
            <span className="tree-section-label">Workspace</span>
          </div>
          {renderNode({ ...tree, children: otherChildren }, 0, state)}
        </div>
      )}
    </div>
  );
}
