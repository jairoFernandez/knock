interface EditorProps {
  value: string;
  onChange: (next: string) => void;
  onSave?: () => void;
}

export function Editor({ value, onChange, onSave }: EditorProps) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
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
  );
}
