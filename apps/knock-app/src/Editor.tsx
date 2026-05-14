interface EditorProps {
  value: string;
  onChange: (next: string) => void;
}

export function Editor({ value, onChange }: EditorProps) {
  return (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
    />
  );
}
