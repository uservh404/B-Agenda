import "./S-confirm.css";

interface ConfirmDialogProps {
  title: string;
  message: string;
  detail?: string;
  errorMessage?: string;
  confirmLabel?: string;
  isConfirming?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmDialog({
  title,
  message,
  detail,
  errorMessage,
  confirmLabel = "Eliminar",
  isConfirming = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <div className="confirm-backdrop" onClick={() => { if (!isConfirming) onCancel(); }}>
      <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(event) => event.stopPropagation()}>
        <div className="confirm-icon" aria-hidden="true">!</div>
        <h2 id="confirm-title">{title}</h2>
        <p>{message}</p>
        {detail && <p><strong>{detail}</strong></p>}
        {errorMessage && <p className="confirm-error" role="alert">{errorMessage}</p>}
        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={onCancel} disabled={isConfirming}>Cancelar</button>
          <button type="button" className="confirm-delete" onClick={onConfirm} disabled={isConfirming}>
            {isConfirming ? "Eliminando..." : confirmLabel}
          </button>
        </div>
      </section>
    </div>
  );
}

export default ConfirmDialog;