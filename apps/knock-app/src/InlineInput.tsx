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
    const v = (ref.current?.value ?? "").trim();
    if (!v || v === initial) {
      onCancel();
      return;
    }
    onCommit(v);
  }

  return (
    <input
      ref={ref}
      defaultValue={initial}
      placeholder={placeholder}
      className={`inline-input${className ? ` ${className}` : ""}`}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
      onBlur={commit}
    />
  );
}
