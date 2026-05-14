interface TreeProps {
  files: string[];
  selected: string | null;
  onSelect: (path: string) => void;
}

interface Node {
  name: string;
  path: string;
  isFile: boolean;
  children: Node[];
}

function buildTree(files: string[]): Node {
  const root: Node = { name: "", path: "", isFile: false, children: [] };
  const dirMap = new Map<string, Node>();
  dirMap.set("", root);

  const sorted = [...files].sort();
  for (const file of sorted) {
    const segments = file.split("/");
    let parentPath = "";
    let parent = root;
    for (let i = 0; i < segments.length; i++) {
      const name = segments[i];
      const isFile = i === segments.length - 1;
      const path = parentPath ? `${parentPath}/${name}` : name;
      const existing = dirMap.get(path);
      if (existing) {
        parent = existing;
      } else {
        const node: Node = { name, path, isFile, children: [] };
        parent.children.push(node);
        if (!isFile) dirMap.set(path, node);
        parent = node;
      }
      parentPath = path;
    }
  }
  return root;
}

function renderNode(node: Node, depth: number, selected: string | null, onSelect: (p: string) => void): JSX.Element[] {
  const items: JSX.Element[] = [];
  for (const child of node.children) {
    const pad = { paddingLeft: 12 + depth * 12 };
    if (child.isFile) {
      items.push(
        <div
          key={child.path}
          className={`tree-item file${selected === child.path ? " selected" : ""}`}
          style={pad}
          onClick={() => onSelect(child.path)}
        >
          {child.name}
        </div>,
      );
    } else {
      items.push(
        <div key={child.path} className="tree-item dir" style={pad}>
          {child.name}/
        </div>,
      );
      items.push(...renderNode(child, depth + 1, selected, onSelect));
    }
  }
  return items;
}

export function Tree({ files, selected, onSelect }: TreeProps) {
  const root = buildTree(files);
  return <div className="tree">{renderNode(root, 0, selected, onSelect)}</div>;
}
