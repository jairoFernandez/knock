import { useEffect, useRef } from "react";

interface Props {
  initial: string;
  placeholder?: string;
  selectExt?: boolean;
  onCommit: (value: string) => void;
  onCancel: () => void;
  className?: string;
}

export function InlineInput({
  initial,
  placeholder,
  selectExt = true,
  onCommit,
  onCancel,
  className,
}: Props) {
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    if (selectExt) {
      el.select();
    } else {
      const dot = initial.lastIndexOf(".");
      const end = dot > 0 ? dot : initial.length;
      el.setSelectionRange(0, end);
    }
  }, []);

  function commit() {
    if (settled.current) return;
    settled.current = true;
    const v = (ref.current?.value ?? "").trim();
    if (!v || v === initial) {
      onCancel();
      return;
    }
    onCommit(v);
  }

  function cancel() {
    if (settled.current) return;
    settled.current = true;
    onCancel();
  }

  return (
    <input
      ref={ref}
      defaultValue={initial}
      placeholder={placeholder}
      className={`inline-input${className ? ` ${className}` : ""}`}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          cancel();
        }
      }}
      onBlur={commit}
    />
  );
}
