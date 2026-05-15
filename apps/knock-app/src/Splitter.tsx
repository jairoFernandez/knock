import { useColumnDrag } from "./hooks";

interface Props {
  onDelta: (delta: number) => void;
}

export function Splitter({ onDelta }: Props) {
  const start = useColumnDrag({ onDelta });
  return <div className="splitter" onMouseDown={start} />;
}
