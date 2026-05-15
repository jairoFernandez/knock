import { useState } from "react";
import type { EntryKind, TreeEntry } from "./types";

interface TreeProps {
  entries: TreeEntry[];
  directories: string[];
  selected: string | null;
  colors: Record<string, string>;
  onSelect: (path: string) => void;
  onDelete?: (path: string) => void;
  onRename?: (path: string) => void;
  onSetColor?: (dirPath: string) => void;
}

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
    const pad = { paddingLeft: 8 + depth * 12 };
    if (child.entry) {
      const e = child.entry;
      const label = e.kind === "request" ? e.name ?? child.name.replace(/\.toml$/, "") : child.name.replace(/\.toml$/, "");
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
            {state.onRename && (
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
            {state.onDelete && (
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
  onRename,
  onSetColor,
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
  return (
    <div className="tree">
      {renderNode(tree, 0, {
        selected,
        collapsed,
        toggle,
        onSelect,
        onDelete,
        onRename,
        onSetColor,
        colors,
      })}
    </div>
  );
}
