import { useEffect } from "react";

export interface ConfirmOptions {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

interface Props extends ConfirmOptions {
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title = "Confirm",
  message,
  confirmLabel = "Delete",
  cancelLabel = "Cancel",
  danger = true,
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
      else if (e.key === "Enter") onConfirm();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel, onConfirm]);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal confirm-modal"
        onClick={(e) => e.stopPropagation()}
        role="alertdialog"
      >
        <h2>{title}</h2>
        <div className="confirm-message">{message}</div>
        <div className="row right">
          <button onClick={onCancel}>{cancelLabel}</button>
          <button
            className={danger ? "danger" : "primary"}
            onClick={onConfirm}
            autoFocus
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
