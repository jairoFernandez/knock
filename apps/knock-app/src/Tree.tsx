import { useState } from "react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { EntryKind, TreeEntry } from "./types";
import { InlineInput } from "./InlineInput";

export type SectionKind = "request" | "fragment" | "flow" | "environment";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

export interface MoveOp {
  fromPath: string;
  toParent: string;
  toIndex: number;
}

interface TreeProps {
  entries: TreeEntry[];
  directories: string[];
  selected: string | null;
  colors: Record<string, string>;
  folderOrders: Record<string, string[]>;
  onSelect: (path: string) => void;
  onDelete?: (path: string) => void;
  onDeleteFolder?: (path: string) => void;
  onRenameInline?: (path: string, newBaseName: string) => void;
  onSetColor?: (dirPath: string) => void;
  onAddRequest?: (folderPath: string) => void;
  onCreateFolder?: (parentPath: string, name: string) => void;
  onCreateEntry?: (parentPath: string, name: string, kind: SectionKind) => void;
  onChangeMethod?: (path: string, method: string) => void;
  onChangeName?: (path: string, name: string) => void;
  onMove?: (op: MoveOp) => void;
  view?: TreeView;
}

export type TreeView = "tree" | "flat";

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
  // Set when a chain of single-child folders is shown as one row:
  // `path` stays the top folder (drag, collapse, delete) and `target`
  // is the deepest one (children, rename, "add here").
  target?: string;
}

function compact(node: Node, pendingParent: string | null): Node {
  let tail = node;
  const names = [node.name];
  while (
    tail.children.length === 1 &&
    !tail.children[0].entry &&
    tail.path !== pendingParent
  ) {
    tail = tail.children[0];
    names.push(tail.name);
  }
  if (tail === node) return node;
  return { ...tail, name: names.join("/"), path: node.path, target: tail.path };
}

function targetOf(node: Node): string {
  return node.target ?? node.path;
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

  for (const entry of entries) {
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

// Older requests were saved as `<host>/<path...>/get.toml` named "/"; show the
// last path segment instead so the row says what it hits.
function requestLabel(e: TreeEntry, path: string): string {
  const name = e.name?.trim();
  if (name && name !== "/") return name;
  const segments = path.replace(/\.toml$/, "").split("/");
  const base = segments[segments.length - 1];
  if (METHODS.includes(base.toUpperCase()) && segments.length > 2) {
    return segments[segments.length - 2];
  }
  return base;
}

function kindIcon(kind: EntryKind | undefined): string {
  switch (kind) {
    case "fragment": return "◇";
    case "environment": return "▦";
    case "flow": return "⇉";
    case "config": return "⚙";
    case "openapi": return "❖";
    default: return "·";
  }
}

function sortChildren(node: Node, folderOrders: Record<string, string[]>): Node[] {
  const order = folderOrders[node.path] ?? [];
  const byName = new Map<string, Node>();
  for (const c of node.children) byName.set(c.name, c);

  const ordered: Node[] = [];
  const used = new Set<string>();
  for (const name of order) {
    const child = byName.get(name);
    if (child) {
      ordered.push(child);
      used.add(name);
    }
  }
  const rest = node.children
    .filter((c) => !used.has(c.name))
    .sort((a, b) => {
      const aIsDir = !a.entry;
      const bIsDir = !b.entry;
      if (aIsDir !== bIsDir) return aIsDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  return [...ordered, ...rest];
}

interface RenderCtx {
  selected: string | null;
  collapsed: Set<string>;
  toggle: (path: string) => void;
  onSelect: (path: string) => void;
  onDelete?: (path: string) => void;
  onDeleteFolder?: (path: string) => void;
  onRenameInline?: (path: string, newBase: string) => void;
  onSetColor?: (path: string) => void;
  onAddRequest?: (path: string) => void;
  onCreateFolder?: (parent: string, name: string) => void;
  onCreateEntry?: (parent: string, name: string, kind: SectionKind) => void;
  onChangeMethod?: (path: string, method: string) => void;
  onChangeName?: (path: string, name: string) => void;
  colors: Record<string, string>;
  folderOrders: Record<string, string[]>;
  editing: string | null;
  setEditing: (path: string | null) => void;
  methodPopover: string | null;
  setMethodPopover: (path: string | null) => void;
  pending: { parent: string; kind: "folder" | SectionKind } | null;
  setPending: (p: { parent: string; kind: "folder" | SectionKind } | null) => void;
}

function FileRow({
  node,
  depth,
  ctx,
  sublabel,
}: {
  node: Node;
  depth: number;
  ctx: RenderCtx;
  sublabel?: string;
}) {
  const e = node.entry!;
  const isProtected = e.kind === "config";
  const isEditing = ctx.editing === node.path;
  const showMethodPopover = ctx.methodPopover === node.path;

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({
      id: `f:${node.path}`,
      data: { kind: "file", path: node.path, parent: parentOf(node.path) },
      disabled: isProtected || isEditing || sublabel !== undefined,
    });

  const style: React.CSSProperties = {
    paddingLeft: 8 + depth * 16,
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  const label = e.kind === "request" ? requestLabel(e, node.path) : node.name.replace(/\.toml$/, "");

  return (
    <div
      ref={setNodeRef}
      className={`tree-item file${ctx.selected === node.path ? " selected" : ""}`}
      style={style}
      onClick={() => !isEditing && ctx.onSelect(node.path)}
      title={node.path}
      {...attributes}
      {...listeners}
    >
      {e.kind === "request" ? (
        <span
          className={`method-chip ${methodClass(e.method)}${ctx.onChangeMethod && !isProtected ? " clickable" : ""}`}
          onClick={(ev) => {
            if (!ctx.onChangeMethod || isProtected) return;
            ev.stopPropagation();
            ctx.setMethodPopover(showMethodPopover ? null : node.path);
          }}
        >
          {e.method ?? "REQ"}
          {showMethodPopover && (
            <div className="method-popover" onClick={(ev) => ev.stopPropagation()}>
              {METHODS.map((m) => (
                <button
                  key={m}
                  className={`method-popover-item ${methodClass(m)}`}
                  onClick={(ev) => {
                    ev.stopPropagation();
                    ctx.setMethodPopover(null);
                    if (m !== (e.method ?? "")) ctx.onChangeMethod!(node.path, m);
                  }}
                >
                  {m}
                </button>
              ))}
            </div>
          )}
        </span>
      ) : (
        <span className="kind-glyph">{kindIcon(e.kind)}</span>
      )}
      {isEditing ? (
        <InlineInput
          initial={label}
          selectExt={false}
          onCommit={(v) => {
            ctx.setEditing(null);
            if (e.kind === "request" && ctx.onChangeName) {
              ctx.onChangeName(node.path, v);
            } else {
              const baseName = v.endsWith(".toml") ? v : `${v}.toml`;
              ctx.onRenameInline?.(node.path, baseName);
            }
          }}
          onCancel={() => ctx.setEditing(null)}
        />
      ) : (
        <span
          className="tree-label"
          onDoubleClick={(ev) => {
            if (isProtected) return;
            ev.stopPropagation();
            ctx.setEditing(node.path);
          }}
        >
          {label}
          {sublabel && <span className="tree-sublabel">{sublabel}</span>}
        </span>
      )}
      <div className="tree-row-actions">
        {!isProtected && ctx.onRenameInline && (
          <button
            className="tree-action"
            title="Rename"
            onClick={(ev) => {
              ev.stopPropagation();
              ctx.setEditing(node.path);
            }}
          >
            ✎
          </button>
        )}
        {!isProtected && ctx.onDelete && (
          <button
            className="tree-action tree-delete"
            title="Delete"
            onClick={(ev) => {
              ev.stopPropagation();
              ctx.onDelete!(node.path);
            }}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

function FolderRow({
  node,
  depth,
  ctx,
  topKind,
  isSectionRoot,
}: {
  node: Node;
  depth: number;
  ctx: RenderCtx;
  topKind: SectionKind | null;
  isSectionRoot?: boolean;
}) {
  const isEditing = ctx.editing === node.path;
  const isCollapsed = ctx.collapsed.has(node.path);
  const color = ctx.colors[node.path];

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({
      id: `d:${node.path}`,
      data: { kind: "folder", path: node.path, parent: parentOf(node.path) },
      disabled: isSectionRoot || isEditing,
    });

  const dirStyle: React.CSSProperties = {
    paddingLeft: 8 + depth * 16,
    ...(color ? { borderLeft: `2px solid ${color}` } : {}),
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      className={`tree-item dir ${color ? "has-color" : ""}`}
      style={dirStyle}
      onClick={() => !isEditing && ctx.toggle(node.path)}
      {...attributes}
      {...(isSectionRoot ? {} : listeners)}
    >
      <span className={`dir-glyph ${isCollapsed ? "collapsed" : "open"}`}>
        {isCollapsed ? "▸" : "▾"}
      </span>
      {isEditing ? (
        <InlineInput
          initial={targetOf(node).split("/").pop() ?? node.name}
          onCommit={(v) => {
            ctx.setEditing(null);
            ctx.onRenameInline?.(targetOf(node), v);
          }}
          onCancel={() => ctx.setEditing(null)}
        />
      ) : (
        <span
          className="tree-label"
          onDoubleClick={(ev) => {
            if (isSectionRoot) return;
            ev.stopPropagation();
            ctx.setEditing(node.path);
          }}
        >
          {node.name}
        </span>
      )}
      <div className="tree-row-actions">
        {topKind && ctx.onCreateFolder && (
          <button
            className="tree-action"
            title="New folder here"
            onClick={(ev) => {
              ev.stopPropagation();
              if (isCollapsed) ctx.toggle(node.path);
              ctx.setPending({ parent: targetOf(node), kind: "folder" });
            }}
          >
            ⊕
          </button>
        )}
        {topKind === "request" && ctx.onAddRequest && (
          <button
            className="tree-action"
            title="New request here"
            onClick={(ev) => {
              ev.stopPropagation();
              ctx.onAddRequest!(targetOf(node));
            }}
          >
            +
          </button>
        )}
        {topKind && topKind !== "request" && ctx.onCreateEntry && (
          <button
            className="tree-action"
            title={`New ${topKind} here`}
            onClick={(ev) => {
              ev.stopPropagation();
              if (isCollapsed) ctx.toggle(node.path);
              ctx.setPending({ parent: targetOf(node), kind: topKind });
            }}
          >
            +
          </button>
        )}
        {ctx.onSetColor && !isSectionRoot && (
          <button
            className="tree-action tree-color"
            title="Set color"
            style={color ? { color } : undefined}
            onClick={(ev) => {
              ev.stopPropagation();
              ctx.onSetColor!(node.path);
            }}
          >
            ●
          </button>
        )}
        {!isSectionRoot && ctx.onRenameInline && (
          <button
            className="tree-action"
            title="Rename"
            onClick={(ev) => {
              ev.stopPropagation();
              ctx.setEditing(node.path);
            }}
          >
            ✎
          </button>
        )}
        {!isSectionRoot && ctx.onDeleteFolder && (
          <button
            className="tree-action tree-delete"
            title="Delete folder"
            onClick={(ev) => {
              ev.stopPropagation();
              ctx.onDeleteFolder!(node.path);
            }}
          >
            ×
          </button>
        )}
      </div>
    </div>
  );
}

function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

function renderChildren(
  node: Node,
  depth: number,
  ctx: RenderCtx,
  topKind: SectionKind | null,
): JSX.Element[] {
  const items: JSX.Element[] = [];
  const pendingParent = ctx.pending?.parent ?? null;
  const children = sortChildren({ ...node, path: targetOf(node) }, ctx.folderOrders).map((c) =>
    c.entry ? c : compact(c, pendingParent),
  );
  const ids = children.map((c) =>
    c.entry ? `f:${c.path}` : `d:${c.path}`,
  );

  items.push(
    <SortableContext
      key={`ctx:${node.path}`}
      items={ids}
      strategy={verticalListSortingStrategy}
    >
      {children.map((child) => {
        if (child.entry) {
          return <FileRow key={child.path} node={child} depth={depth} ctx={ctx} />;
        }
        const isCollapsed = ctx.collapsed.has(child.path);
        return (
          <div key={child.path}>
            <FolderRow node={child} depth={depth} ctx={ctx} topKind={topKind} />
            {!isCollapsed && renderChildren(child, depth + 1, ctx, topKind)}
            {!isCollapsed && ctx.pending && ctx.pending.parent === targetOf(child) && (
              <PendingRow
                depth={depth + 1}
                kind={ctx.pending.kind}
                onCommit={(name) => {
                  const pending = ctx.pending!;
                  ctx.setPending(null);
                  if (pending.kind === "folder") {
                    ctx.onCreateFolder?.(pending.parent, name);
                  } else {
                    ctx.onCreateEntry?.(pending.parent, name, pending.kind);
                  }
                }}
                onCancel={() => ctx.setPending(null)}
              />
            )}
          </div>
        );
      })}
    </SortableContext>,
  );
  return items;
}

interface FlatGroup {
  folder: string;
  items: { node: Node; sub: string }[];
}

// Postman-like: one group per top-level folder ("collection"), every request
// inside it listed flat; deeper folders become a dim hint instead of nesting.
function flatGroups(section: Node): FlatGroup[] {
  const groups = new Map<string, FlatGroup>();
  const walk = (n: Node, group: string, trail: string[]) => {
    for (const c of n.children) {
      if (c.entry) {
        if (!groups.has(group)) groups.set(group, { folder: group, items: [] });
        groups.get(group)!.items.push({ node: c, sub: trail.join("/") });
      } else if (group === "") {
        if (!groups.has(c.path)) groups.set(c.path, { folder: c.path, items: [] });
        walk(c, c.path, []);
      } else {
        walk(c, group, [...trail, c.name]);
      }
    }
  };
  walk(section, "", []);
  const label = (r: { node: Node }) =>
    r.node.entry?.kind === "request" ? requestLabel(r.node.entry, r.node.path) : r.node.name;
  for (const g of groups.values()) {
    g.items.sort((a, b) => label(a).localeCompare(label(b)) || a.sub.localeCompare(b.sub));
  }
  return Array.from(groups.values()).sort((a, b) => {
    if (a.folder === "") return -1;
    if (b.folder === "") return 1;
    return a.folder.localeCompare(b.folder);
  });
}

function renderFlat(section: Node, ctx: RenderCtx): JSX.Element {
  const groups = flatGroups(section);
  return (
    <SortableContext items={[]} strategy={verticalListSortingStrategy}>
      {groups.map((g) => {
        const rows = g.items.map(({ node, sub }) => (
          <FileRow
            key={node.path}
            node={node}
            depth={g.folder ? 2 : 1}
            ctx={ctx}
            sublabel={sub}
          />
        ));
        if (!g.folder) return <div key="__root">{rows}</div>;
        const groupNode: Node = {
          name: g.folder.split("/").pop() ?? g.folder,
          path: g.folder,
          children: [],
        };
        const isCollapsed = ctx.collapsed.has(g.folder);
        return (
          <div key={g.folder}>
            <FolderRow node={groupNode} depth={1} ctx={ctx} topKind="request" />
            {!isCollapsed && rows}
            {!isCollapsed && ctx.pending && ctx.pending.parent === g.folder && (
              <PendingRow
                depth={2}
                kind={ctx.pending.kind}
                onCommit={(name) => {
                  const pending = ctx.pending!;
                  ctx.setPending(null);
                  if (pending.kind === "folder") ctx.onCreateFolder?.(pending.parent, name);
                  else ctx.onCreateEntry?.(pending.parent, name, pending.kind);
                }}
                onCancel={() => ctx.setPending(null)}
              />
            )}
          </div>
        );
      })}
    </SortableContext>
  );
}

function PendingRow({
  depth,
  kind,
  onCommit,
  onCancel,
}: {
  depth: number;
  kind: "folder" | SectionKind;
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const glyph = kind === "folder" ? "▾" : "·";
  return (
    <div className="tree-item pending" style={{ paddingLeft: 8 + depth * 16 }}>
      <span className={kind === "folder" ? "dir-glyph open" : "kind-glyph"}>
        {glyph}
      </span>
      <InlineInput
        initial=""
        placeholder={kind === "folder" ? "folder name" : "name"}
        onCommit={onCommit}
        onCancel={onCancel}
      />
    </div>
  );
}

export function Tree({
  entries,
  directories,
  selected,
  colors,
  folderOrders,
  onSelect,
  onDelete,
  onDeleteFolder,
  onRenameInline,
  onSetColor,
  onAddRequest,
  onCreateFolder,
  onCreateEntry,
  onChangeMethod,
  onChangeName,
  onMove,
  view = "tree",
}: TreeProps) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [methodPopover, setMethodPopover] = useState<string | null>(null);
  const [pending, setPending] = useState<
    { parent: string; kind: "folder" | SectionKind } | null
  >(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  );

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const tree = buildTree(entries, directories);

  const ctx: RenderCtx = {
    selected,
    collapsed,
    toggle,
    onSelect,
    onDelete,
    onDeleteFolder,
    onRenameInline,
    onSetColor,
    onAddRequest,
    onCreateFolder,
    onCreateEntry,
    onChangeMethod,
    onChangeName,
    colors,
    folderOrders,
    editing,
    setEditing,
    methodPopover,
    setMethodPopover,
    pending,
    setPending,
  };

  const childByName = new Map<string, Node>();
  for (const c of tree.children) childByName.set(c.name, c);
  const knownDirs = new Set(SECTIONS.map((s) => s.dir));
  const otherChildren = tree.children.filter((c) => !knownDirs.has(c.name));

  function handleDragStart(e: DragStartEvent) {
    setActiveId(String(e.active.id));
    setMethodPopover(null);
  }

  function handleDragEnd(e: DragEndEvent) {
    setActiveId(null);
    const { active, over } = e;
    if (!over || !onMove) return;
    if (active.id === over.id) return;
    const activeData = active.data.current as { kind: string; path: string; parent: string } | undefined;
    const overData = over.data.current as { kind: string; path: string; parent: string } | undefined;
    if (!activeData || !overData) return;
    const fromPath = activeData.path;
    const toParent = overData.parent;
    // Compute target index using sorted siblings of toParent.
    const parentNode = findNode(tree, toParent);
    if (!parentNode) return;
    const siblings = sortChildren(parentNode, folderOrders);
    const overIdx = siblings.findIndex(
      (s) => s.path === overData.path,
    );
    if (overIdx === -1) return;
    // If moving within same parent, use arrayMove semantics; otherwise insert before overIdx.
    let toIndex = overIdx;
    if (activeData.parent === toParent) {
      const fromIdx = siblings.findIndex((s) => s.path === fromPath);
      const reordered = arrayMove(siblings, fromIdx, overIdx);
      toIndex = reordered.findIndex((s) => s.path === fromPath);
    }
    onMove({ fromPath, toParent, toIndex });
  }

  function activeLabel(): string {
    if (!activeId) return "";
    const id = activeId;
    const path = id.slice(2);
    if (id.startsWith("f:")) {
      const entry = entries.find((e) => e.rel === path);
      if (entry?.kind === "request" && entry.name) return entry.name;
      return path.split("/").pop()?.replace(/\.toml$/, "") ?? path;
    }
    return path.split("/").pop() ?? path;
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveId(null)}
    >
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
                {onCreateFolder && (
                  <button
                    className="tree-section-add"
                    title="New folder"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      if (node && isCollapsed) toggle(node.path);
                      setPending({ parent: sec.dir, kind: "folder" });
                    }}
                  >
                    ⊕
                  </button>
                )}
                {sec.kind === "request" && onAddRequest && (
                  <button
                    className="tree-section-add"
                    title="New request"
                    onClick={(ev) => {
                      ev.stopPropagation();
                      onAddRequest(sec.dir);
                    }}
                  >
                    +
                  </button>
                )}
                {sec.kind !== "request" && onCreateEntry && (
                  <button
                    className="tree-section-add"
                    title={`New ${sec.label.toLowerCase().replace(/s$/, "")}`}
                    onClick={(ev) => {
                      ev.stopPropagation();
                      if (node && isCollapsed) toggle(node.path);
                      setPending({ parent: sec.dir, kind: sec.kind });
                    }}
                  >
                    +
                  </button>
                )}
              </div>
              {node && !isCollapsed && (view === "flat" && sec.kind === "request"
                ? renderFlat(node, ctx)
                : renderChildren(node, 1, ctx, sec.kind))}
              {node && !isCollapsed && pending && pending.parent === node.path && (
                <PendingRow
                  depth={1}
                  kind={pending.kind}
                  onCommit={(name) => {
                    const p = pending!;
                    setPending(null);
                    if (p.kind === "folder") onCreateFolder?.(p.parent, name);
                    else onCreateEntry?.(p.parent, name, p.kind);
                  }}
                  onCancel={() => setPending(null)}
                />
              )}
            </div>
          );
        })}
        {otherChildren.length > 0 && (
          <div className="tree-section">
            <div className="tree-section-header">
              <span className="tree-section-label">Workspace</span>
            </div>
            {renderChildren({ ...tree, children: otherChildren }, 0, ctx, null)}
          </div>
        )}
      </div>
      <DragOverlay>
        {activeId ? (
          <div className="tree-item drag-overlay">
            <span className="tree-label">{activeLabel()}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

function findNode(root: Node, path: string): Node | null {
  if (path === "") return root;
  const segments = path.split("/").filter(Boolean);
  let cur: Node | undefined = root;
  for (const seg of segments) {
    cur = cur?.children.find((c) => c.name === seg && !c.entry);
    if (!cur) return null;
  }
  return cur ?? null;
}
