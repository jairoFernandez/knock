import { useState } from "react";
import type { EntryKind, TreeEntry } from "./types";

interface TreeProps {
  entries: TreeEntry[];
  selected: string | null;
  onSelect: (path: string) => void;
  onDelete?: (path: string) => void;
}

interface Node {
  name: string;
  path: string;
  entry?: TreeEntry;
  children: Node[];
}

function buildTree(entries: TreeEntry[]): Node {
  const root: Node = { name: "", path: "", children: [] };
  const dirMap = new Map<string, Node>();
  dirMap.set("", root);

  const sorted = [...entries].sort((a, b) => a.rel.localeCompare(b.rel));
  for (const entry of sorted) {
    const segments = entry.rel.split("/");
    let parentPath = "";
    let parent = root;
    for (let i = 0; i < segments.length; i++) {
      const name = segments[i];
      const isFile = i === segments.length - 1;
      const path = parentPath ? `${parentPath}/${name}` : name;
      const existing = dirMap.get(path);
      if (existing && !isFile) {
        parent = existing;
      } else if (isFile) {
        parent.children.push({ name, path, entry, children: [] });
      } else {
        const node: Node = { name, path, children: [] };
        parent.children.push(node);
        dirMap.set(path, node);
        parent = node;
      }
      parentPath = path;
    }
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
}

function renderNode(node: Node, depth: number, state: RenderState): JSX.Element[] {
  const items: JSX.Element[] = [];
  for (const child of node.children) {
    const pad = { paddingLeft: 8 + depth * 12 };
    if (child.entry) {
      const e = child.entry;
      const label = e.kind === "request" ? e.name ?? child.name.replace(/\.toml$/, "") : child.name;
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
          {state.onDelete && (
            <button
              className="tree-delete"
              title="Delete"
              onClick={(ev) => {
                ev.stopPropagation();
                state.onDelete!(child.path);
              }}
            >
              ×
            </button>
          )}
        </div>,
      );
    } else {
      const isCollapsed = state.collapsed.has(child.path);
      items.push(
        <div
          key={child.path}
          className="tree-item dir"
          style={pad}
          onClick={() => state.toggle(child.path)}
        >
          <span className={`dir-glyph ${isCollapsed ? "collapsed" : "open"}`}>
            {isCollapsed ? "▸" : "▾"}
          </span>
          <span className="tree-label">{child.name}</span>
          <span className="dir-count">{countFiles(child)}</span>
        </div>,
      );
      if (!isCollapsed) {
        items.push(...renderNode(child, depth + 1, state));
      }
    }
  }
  return items;
}

function countFiles(node: Node): number {
  let n = 0;
  for (const c of node.children) {
    if (c.entry) n++;
    else n += countFiles(c);
  }
  return n;
}

export function Tree({ entries, selected, onSelect, onDelete }: TreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const toggle = (path: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  };
  const root = buildTree(entries);
  return (
    <div className="tree">
      {renderNode(root, 0, { selected, collapsed, toggle, onSelect, onDelete })}
    </div>
  );
}
