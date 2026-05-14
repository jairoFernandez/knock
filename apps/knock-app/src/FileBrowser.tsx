import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FileEntry } from "./types";

interface Props {
  root: string;
  selected: string | null;
  onSelect: (rel: string) => void;
  refreshToken?: number;
}

interface Node {
  name: string;
  rel: string;
  entry?: FileEntry;
  children: Node[];
}

function buildTree(entries: FileEntry[]): Node {
  const root: Node = { name: "", rel: "", children: [] };
  const dirMap = new Map<string, Node>();
  dirMap.set("", root);
  for (const entry of entries) {
    const parts = entry.rel.split("/");
    let parentPath = "";
    let parent = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i];
      const isFile = i === parts.length - 1;
      const path = parentPath ? `${parentPath}/${name}` : name;
      if (isFile) {
        parent.children.push({ name, rel: path, entry, children: [] });
      } else {
        const existing = dirMap.get(path);
        if (existing) {
          parent = existing;
        } else {
          const node: Node = { name, rel: path, children: [] };
          parent.children.push(node);
          dirMap.set(path, node);
          parent = node;
        }
      }
      parentPath = path;
    }
  }
  return root;
}

function renderNode(
  node: Node,
  depth: number,
  selected: string | null,
  collapsed: Set<string>,
  toggle: (rel: string) => void,
  onSelect: (rel: string) => void,
): JSX.Element[] {
  const items: JSX.Element[] = [];
  for (const child of node.children) {
    const pad = { paddingLeft: 8 + depth * 12 };
    if (child.entry) {
      items.push(
        <div
          key={child.rel}
          className={`tree-item file${selected === child.rel ? " selected" : ""}`}
          style={pad}
          onClick={() => onSelect(child.rel)}
          title={child.rel}
        >
          <span className="file-glyph">{child.entry.isText ? "·" : "▣"}</span>
          <span className="tree-label">{child.name}</span>
        </div>,
      );
    } else {
      const isCollapsed = collapsed.has(child.rel);
      items.push(
        <div
          key={child.rel}
          className="tree-item dir"
          style={pad}
          onClick={() => toggle(child.rel)}
        >
          <span className={`dir-glyph ${isCollapsed ? "collapsed" : "open"}`}>
            {isCollapsed ? "▸" : "▾"}
          </span>
          <span className="tree-label">{child.name}</span>
        </div>,
      );
      if (!isCollapsed) {
        items.push(...renderNode(child, depth + 1, selected, collapsed, toggle, onSelect));
      }
    }
  }
  return items;
}

export function FileBrowser({ root, selected, onSelect, refreshToken }: Props) {
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  useEffect(() => {
    invoke<FileEntry[]>("list_files", { root })
      .then(setEntries)
      .catch(() => setEntries([]));
  }, [root, refreshToken]);

  const toggle = (rel: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });

  const tree = buildTree(entries);
  return (
    <div className="tree">
      {renderNode(tree, 0, selected, collapsed, toggle, onSelect)}
      {entries.length === 0 && <div className="empty">No files.</div>}
    </div>
  );
}
