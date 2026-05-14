import type { EntryKind, TreeEntry } from "./types";

interface TreeProps {
  entries: TreeEntry[];
  selected: string | null;
  onSelect: (path: string) => void;
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

function renderNode(
  node: Node,
  depth: number,
  selected: string | null,
  onSelect: (p: string) => void,
): JSX.Element[] {
  const items: JSX.Element[] = [];
  for (const child of node.children) {
    const pad = { paddingLeft: 10 + depth * 14 };
    if (child.entry) {
      const e = child.entry;
      const label = e.kind === "request" ? (e.name ?? child.name.replace(/\.toml$/, "")) : child.name;
      items.push(
        <div
          key={child.path}
          className={`tree-item file${selected === child.path ? " selected" : ""}`}
          style={pad}
          onClick={() => onSelect(child.path)}
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
        </div>,
      );
    } else {
      items.push(
        <div key={child.path} className="tree-item dir" style={pad}>
          <span className="dir-glyph">▸</span>
          <span className="tree-label">{child.name}</span>
        </div>,
      );
      items.push(...renderNode(child, depth + 1, selected, onSelect));
    }
  }
  return items;
}

export function Tree({ entries, selected, onSelect }: TreeProps) {
  const root = buildTree(entries);
  return <div className="tree">{renderNode(root, 0, selected, onSelect)}</div>;
}
