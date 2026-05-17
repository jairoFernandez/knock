import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { highlightYaml } from "./yamlHighlight";

interface Snippet {
  label: string;
  detail?: string;
  /** Inserted text. `$0` (single) marks final caret. */
  insert: string;
}

// kubeconfig schema (top-level keys + nested contexts)
const ROOT_KEYS: Snippet[] = [
  { label: "apiVersion", detail: "string", insert: "apiVersion: v1" },
  { label: "kind", detail: "string", insert: "kind: Config" },
  { label: "current-context", detail: "string", insert: "current-context: $0" },
  { label: "clusters", detail: "list", insert: "clusters:\n  - name: $0\n    cluster:\n      server: " },
  { label: "contexts", detail: "list", insert: "contexts:\n  - name: $0\n    context:\n      cluster: \n      user: " },
  { label: "users", detail: "list", insert: "users:\n  - name: $0\n    user:\n      token: " },
  { label: "preferences", detail: "object", insert: "preferences: {}" },
];

const CLUSTER_KEYS: Snippet[] = [
  { label: "server", detail: "url", insert: "server: $0" },
  { label: "certificate-authority", detail: "path", insert: "certificate-authority: $0" },
  { label: "certificate-authority-data", detail: "base64", insert: "certificate-authority-data: $0" },
  { label: "insecure-skip-tls-verify", detail: "bool", insert: "insecure-skip-tls-verify: false" },
  { label: "tls-server-name", detail: "string", insert: "tls-server-name: $0" },
  { label: "proxy-url", detail: "url", insert: "proxy-url: $0" },
];

const CONTEXT_KEYS: Snippet[] = [
  { label: "cluster", detail: "ref", insert: "cluster: $0" },
  { label: "user", detail: "ref", insert: "user: $0" },
  { label: "namespace", detail: "string", insert: "namespace: $0" },
];

const USER_KEYS: Snippet[] = [
  { label: "token", detail: "string", insert: "token: $0" },
  { label: "tokenFile", detail: "path", insert: "tokenFile: $0" },
  { label: "client-certificate", detail: "path", insert: "client-certificate: $0" },
  { label: "client-certificate-data", detail: "base64", insert: "client-certificate-data: $0" },
  { label: "client-key", detail: "path", insert: "client-key: $0" },
  { label: "client-key-data", detail: "base64", insert: "client-key-data: $0" },
  { label: "username", detail: "string", insert: "username: $0" },
  { label: "password", detail: "string", insert: "password: $0" },
  { label: "as", detail: "string", insert: "as: $0" },
  { label: "as-groups", detail: "list", insert: "as-groups:\n  - $0" },
  {
    label: "exec",
    detail: "object",
    insert:
      "exec:\n  apiVersion: client.authentication.k8s.io/v1\n  command: $0\n  args: []\n  env: []",
  },
  {
    label: "auth-provider",
    detail: "object",
    insert: "auth-provider:\n  name: $0\n  config: {}",
  },
];

const ENTRY_KEYS_LIST_ITEM: Snippet[] = [
  { label: "name", detail: "string", insert: "name: $0" },
];

interface Ctx {
  parent: "root" | "cluster" | "context" | "user" | "clusters_item" | "contexts_item" | "users_item" | "unknown";
}

function detectContext(value: string, caret: number): Ctx {
  const before = value.slice(0, caret);
  const lines = before.split("\n");
  const curIdx = lines.length - 1;
  const curLine = lines[curIdx] ?? "";
  // For empty/whitespace-only current line, the user's intended indent is the
  // caret column (spaces typed before the caret).
  const curIndent = curLine.trim() === ""
    ? caretColumn(curLine)
    : leadingSpaces(curLine);

  // Walk backwards. Parent is the most recent line whose indent is strictly
  // less than curIndent AND that opens a block (ends with `:` or `key:` then
  // only spaces/comment). Grandparent is the most recent line with indent
  // strictly less than parentIndent.
  let parentKey: string | null = null;
  let parentIndent = -1;
  let gpKey: string | null = null;
  for (let i = curIdx - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.trim() === "" || l.trim().startsWith("#")) continue;
    const ind = leadingSpaces(l);
    if (parentKey === null) {
      if (ind >= curIndent) continue;
      const key = extractBlockKey(l);
      if (key === null) continue;
      parentKey = key;
      parentIndent = ind;
    } else {
      if (ind >= parentIndent) continue;
      const key = extractKey(l);
      if (key) {
        gpKey = key;
        break;
      }
      // Could be a list item line: keep walking
    }
  }

  if (parentKey === null) return { parent: "root" };

  if (parentKey === "cluster") return { parent: "cluster" };
  if (parentKey === "context") return { parent: "context" };
  if (parentKey === "user") return { parent: "user" };

  if (parentKey === "clusters") return { parent: "clusters_item" };
  if (parentKey === "contexts") return { parent: "contexts_item" };
  if (parentKey === "users") return { parent: "users_item" };

  // inside a list item with named map: parent line might be "- name: foo" → gp tells us list
  if (gpKey === "clusters") return { parent: "clusters_item" };
  if (gpKey === "contexts") return { parent: "contexts_item" };
  if (gpKey === "users") return { parent: "users_item" };

  return { parent: "unknown" };
}

function leadingSpaces(s: string): number {
  let n = 0;
  for (const c of s) {
    if (c === " ") n++;
    else if (c === "\t") n += 2;
    else break;
  }
  return n;
}

function caretColumn(currentLineBeforeCaret: string): number {
  // Treat tab as 2 cols, matching leadingSpaces.
  let n = 0;
  for (const c of currentLineBeforeCaret) {
    if (c === "\t") n += 2;
    else n += 1;
  }
  return n;
}

/** Returns the key if the line opens a block: `key:` with no inline value
 *  (only whitespace or a comment after the colon). Allows leading `- ` for
 *  list-item maps. */
function extractBlockKey(line: string): string | null {
  const trimmed = line.replace(/^\s*-\s*/, "").trimStart();
  const m = trimmed.match(/^([A-Za-z0-9_.\-]+)\s*:(.*)$/);
  if (!m) return null;
  const after = m[2].trim();
  if (after === "" || after.startsWith("#")) return m[1];
  return null;
}

function extractKey(line: string): string | null {
  const t = line.replace(/^\s*-\s*/, "").trimStart();
  const m = t.match(/^([A-Za-z0-9_.\-]+)\s*:/);
  return m ? m[1] : null;
}

function suggestionsFor(ctx: Ctx): Snippet[] {
  switch (ctx.parent) {
    case "root":
      return ROOT_KEYS;
    case "cluster":
      return CLUSTER_KEYS;
    case "context":
      return CONTEXT_KEYS;
    case "user":
      return USER_KEYS;
    case "clusters_item":
      return [...ENTRY_KEYS_LIST_ITEM, { label: "cluster", detail: "object", insert: "cluster:\n  server: $0" }];
    case "contexts_item":
      return [...ENTRY_KEYS_LIST_ITEM, { label: "context", detail: "object", insert: "context:\n  cluster: $0\n  user: " }];
    case "users_item":
      return [...ENTRY_KEYS_LIST_ITEM, { label: "user", detail: "object", insert: "user:\n  token: $0" }];
    default:
      return [];
  }
}

function currentWord(value: string, caret: number): { word: string; start: number } {
  let i = caret;
  while (i > 0) {
    const c = value[i - 1];
    if (/[A-Za-z0-9_.-]/.test(c)) i--;
    else break;
  }
  return { word: value.slice(i, caret), start: i };
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
}

export function KubeconfigEditor({ value, onChange, placeholder }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{
    items: Snippet[];
    sel: number;
    top: number;
    left: number;
    placeAbove: boolean;
    maxHeight: number;
    wordStart: number;
    word: string;
  } | null>(null);

  const html = useMemo(() => highlightYaml(value) + "\n", [value]);

  useLayoutEffect(() => {
    const ta = taRef.current;
    const pre = preRef.current;
    if (!ta || !pre) return;
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  }, [value]);

  function recomputeMenu() {
    const ta = taRef.current;
    if (!ta) return;
    const caret = ta.selectionStart;
    if (caret !== ta.selectionEnd) {
      setMenu(null);
      return;
    }
    const { word, start } = currentWord(value, caret);
    const ctx = detectContext(value, caret);
    const all = suggestionsFor(ctx);
    if (all.length === 0) {
      setMenu(null);
      return;
    }
    const filtered = word
      ? all.filter((s) => s.label.toLowerCase().startsWith(word.toLowerCase()))
      : all;
    if (filtered.length === 0) {
      setMenu(null);
      return;
    }
    // Position relative to viewport so the popup can render in a portal and
    // escape the editor's `overflow: hidden`.
    const before = value.slice(0, start);
    const lineIdx = before.match(/\n/g)?.length ?? 0;
    const lineStart = before.lastIndexOf("\n") + 1;
    const col = start - lineStart;
    const lh = 18; // line-height (matches CSS)
    const cw = 7.2; // approx mono char width @ 12.5px
    const rect = ta.getBoundingClientRect();
    const padTop = 8;
    const padLeft = 10;
    const caretX = rect.left + padLeft + col * cw - ta.scrollLeft;
    const caretYTop = rect.top + padTop + lineIdx * lh - ta.scrollTop;
    const caretYBottom = caretYTop + lh;

    const popupH = Math.min(240, filtered.length * 24 + 8);
    const margin = 4;
    const spaceBelow = window.innerHeight - caretYBottom - margin;
    const spaceAbove = caretYTop - margin;
    const placeAbove = spaceBelow < popupH && spaceAbove > spaceBelow;
    const maxHeight = Math.max(120, placeAbove ? spaceAbove : spaceBelow);
    const top = placeAbove ? Math.max(margin, caretYTop - popupH) : caretYBottom;
    // Clamp horizontally
    const popupW = 240;
    const left = Math.min(Math.max(margin, caretX), window.innerWidth - popupW - margin);

    // Preserve selection if the previously-selected label is still present
    let sel = 0;
    if (menu && menu.items[menu.sel]) {
      const prevLabel = menu.items[menu.sel].label;
      const idx = filtered.findIndex((s) => s.label === prevLabel);
      if (idx >= 0) sel = idx;
    }
    setMenu({
      items: filtered,
      sel,
      top,
      left,
      placeAbove,
      maxHeight,
      wordStart: start,
      word,
    });
  }

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      const target = e.target as Node;
      if (wrapRef.current?.contains(target)) return;
      // Allow clicks inside the portal'd completions list
      if ((target as HTMLElement).closest?.(".kube-completions")) return;
      setMenu(null);
    }
    function onScroll(e: Event) {
      // Close on scroll outside the textarea (it'd misplace the fixed popup)
      const target = e.target as Node | null;
      if (target && taRef.current === target) return;
      setMenu(null);
    }
    document.addEventListener("mousedown", onDocClick);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", () => setMenu(null));
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, []);

  function apply(item: Snippet) {
    const ta = taRef.current;
    if (!ta || !menu) return;
    const caret = ta.selectionStart;
    const before = value.slice(0, menu.wordStart);
    const after = value.slice(caret);
    const tokenMarker = "$0";
    const idx = item.insert.indexOf(tokenMarker);
    const insertText = idx >= 0 ? item.insert.replace(tokenMarker, "") : item.insert;
    const next = before + insertText + after;
    const newCaret = before.length + (idx >= 0 ? idx : insertText.length);
    onChange(next);
    setMenu(null);
    queueMicrotask(() => {
      ta.focus();
      ta.setSelectionRange(newCaret, newCaret);
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (menu) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMenu({ ...menu, sel: (menu.sel + 1) % menu.items.length });
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMenu({ ...menu, sel: (menu.sel - 1 + menu.items.length) % menu.items.length });
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        apply(menu.items[menu.sel]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setMenu(null);
        return;
      }
    }
    if ((e.ctrlKey || e.metaKey) && e.key === " ") {
      e.preventDefault();
      recomputeMenu();
      return;
    }
    if (e.key === "Tab" && !menu) {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const next = value.slice(0, start) + "  " + value.slice(end);
      onChange(next);
      queueMicrotask(() => {
        ta.setSelectionRange(start + 2, start + 2);
      });
    }
  }

  function onChangeInner(e: React.ChangeEvent<HTMLTextAreaElement>) {
    onChange(e.target.value);
    queueMicrotask(recomputeMenu);
  }

  function onKeyUp(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Skip navigation / control keys — they neither change text nor caret position
    // in ways that should rebuild the menu.
    if (
      e.key === "ArrowUp" ||
      e.key === "ArrowDown" ||
      e.key === "ArrowLeft" ||
      e.key === "ArrowRight" ||
      e.key === "Enter" ||
      e.key === "Tab" ||
      e.key === "Escape" ||
      e.key === "Shift" ||
      e.key === "Control" ||
      e.key === "Meta" ||
      e.key === "Alt"
    ) {
      return;
    }
    queueMicrotask(recomputeMenu);
  }

  return (
    <div ref={wrapRef} className="kube-editor">
      <pre
        ref={preRef}
        className="kube-editor-pre"
        aria-hidden="true"
        dangerouslySetInnerHTML={{ __html: html }}
      />
      <textarea
        ref={taRef}
        className="kube-editor-ta"
        value={value}
        onChange={onChangeInner}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onScroll={(e) => {
          const pre = preRef.current;
          if (!pre) return;
          pre.scrollTop = e.currentTarget.scrollTop;
          pre.scrollLeft = e.currentTarget.scrollLeft;
        }}
        onBlur={() => setTimeout(() => setMenu(null), 100)}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        placeholder={placeholder}
      />
      {menu &&
        createPortal(
          <ul
            className="kube-completions"
            style={{ top: menu.top, left: menu.left, maxHeight: menu.maxHeight }}
            onMouseDown={(e) => e.preventDefault()}
          >
            {menu.items.map((it, i) => (
              <li
                key={it.label}
                className={`kube-completion ${i === menu.sel ? "selected" : ""}`}
                onClick={() => apply(it)}
                onMouseEnter={() => setMenu({ ...menu, sel: i })}
              >
                <span className="kube-completion-label">{it.label}</span>
                {it.detail && <span className="kube-completion-detail">{it.detail}</span>}
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </div>
  );
}
