interface Props {
  current: string | undefined;
  onPick: (color: string | null) => void;
  onClose: () => void;
}

export const PALETTE = [
  "#8b6cff",
  "#75d76b",
  "#e0a04a",
  "#e36572",
  "#4cb6c4",
  "#d68f47",
  "#b16eb1",
  "#5d8af0",
];

export function ColorPicker({ current, onPick, onClose }: Props) {
  return (
    <div className="color-popover" onClick={(e) => e.stopPropagation()}>
      <div className="color-swatches">
        {PALETTE.map((c) => (
          <button
            key={c}
            className={`color-swatch ${current === c ? "active" : ""}`}
            style={{ background: c }}
            onClick={() => {
              onPick(c);
              onClose();
            }}
            title={c}
          />
        ))}
        <button
          className="color-clear"
          onClick={() => {
            onPick(null);
            onClose();
          }}
          title="Clear color"
        >
          ✕
        </button>
      </div>
    </div>
  );
}
