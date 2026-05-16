import { useLayoutEffect, useRef } from "react";
import { highlightToml } from "./tomlHighlight";

interface EditorProps {
  value: string;
  onChange: (next: string) => void;
  onSave?: () => void;
}

export function Editor({ value, onChange, onSave }: EditorProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const preRef = useRef<HTMLPreElement>(null);

  useLayoutEffect(() => {
    const ta = taRef.current;
    const pre = preRef.current;
    if (!ta || !pre) return;
    pre.scrollTop = ta.scrollTop;
    pre.scrollLeft = ta.scrollLeft;
  });

  return (
    <div className="code-editor">
      <pre ref={preRef} className="code-editor-pre" aria-hidden="true">
        <code dangerouslySetInnerHTML={{ __html: highlightToml(value) + "\n" }} />
      </pre>
      <textarea
        ref={taRef}
        className="code-editor-ta"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          const pre = preRef.current;
          if (!pre) return;
          pre.scrollTop = e.currentTarget.scrollTop;
          pre.scrollLeft = e.currentTarget.scrollLeft;
        }}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
            e.preventDefault();
            onSave?.();
          }
        }}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
      />
    </div>
  );
}
