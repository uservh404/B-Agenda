import "./S-confirm.css";

interface ConfirmDialogProps {
  title: string;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
}

function ConfirmDialog({ title, message, onCancel, onConfirm }: ConfirmDialogProps) {
  return (
    <div className="confirm-backdrop" onClick={onCancel}>
      <section className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(event) => event.stopPropagation()}>
        <div className="confirm-icon" aria-hidden="true">!</div>
        <h2 id="confirm-title">{title}</h2>
        <p>{message}</p>
        <div className="confirm-actions">
          <button type="button" className="confirm-cancel" onClick={onCancel}>Cancelar</button>
          <button type="button" className="confirm-delete" onClick={onConfirm}>Eliminar</button>
        </div>
      </section>
    </div>
  );
}

export default ConfirmDialog;