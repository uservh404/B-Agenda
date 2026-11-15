import { useEffect, useRef, useState } from "react";
import { Cloud, X } from "lucide-react";
import "./S-sync-status-panel.css";

export interface SyncPanelOperation {
  id: string;
  name: string;
  action: string;
  status: string;
  error?: string;
}

interface SyncStatusPanelProps {
  title: string;
  online: boolean;
  syncing: boolean;
  statusLabel: string;
  pendingCount: number;
  deletionCount: number;
  lastSuccessfulSyncAt: string | null;
  operations: SyncPanelOperation[];
  warnings: string[];
  onRefresh: () => void;
}

const OFFLINE_NOTICE = "La conexión se perdió antes de iniciar la sincronización. Los cambios se reintentarán sincronizar al reconectarse.";

function SyncStatusPanel({
  title,
  online,
  syncing,
  statusLabel,
  pendingCount,
  deletionCount,
  lastSuccessfulSyncAt,
  operations,
  warnings,
  onRefresh,
}: SyncStatusPanelProps) {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !anchorRef.current?.contains(event.target)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const connectionText = online ? "Con conexión" : "Sin conexión";
  const allWarnings = [...new Set([
    ...warnings,
    ...(!online ? [OFFLINE_NOTICE] : []),
  ])];

  return (
    <div className="sync-panel-anchor" ref={anchorRef}>
      <button
        className={`sync-indicator ${!online ? "is-offline" : ""}`}
        type="button"
        aria-label={`Estado de sincronización: ${statusLabel}. ${pendingCount} operaciones pendientes.`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
      >
        <Cloud size={19} aria-hidden="true" />
      </button>
      {open && (
        <div className="sync-panel" role="dialog" aria-label={`Estado de ${title}`}>
          <div className="sync-panel-heading">
            <strong>{title}</strong>
            <span className={`sync-connection-state ${online ? "connected" : "disconnected"}`}>
              {connectionText}
            </span>
            <button type="button" className="sync-panel-close" onClick={() => setOpen(false)} aria-label="Cerrar panel">
              <X size={16} aria-hidden="true" />
            </button>
          </div>
          <p className="sync-status-line">{statusLabel}</p>
          <div className="sync-counts">
            <span>Operaciones pendientes <strong>{pendingCount}</strong></span>
            <span>Eliminaciones pendientes <strong>{deletionCount}</strong></span>
          </div>
          <p className="sync-last-success">
            Última sincronización correcta: {lastSuccessfulSyncAt
              ? new Date(lastSuccessfulSyncAt).toLocaleString("es-MX")
              : "Aún no hay una sincronización confirmada."}
          </p>
          {allWarnings.length > 0 && (
            <div className="sync-panel-warnings" role="status">
              {allWarnings.map((warning) => <p key={warning}>{warning}</p>)}
            </div>
          )}
          {operations.length > 0 && (
            <div className="sync-operation-list">
              {operations.map((operation) => (
                <div className="sync-operation-item" key={operation.id}>
                  <div className="sync-operation-copy">
                    <strong>{operation.name}</strong>
                    <span>{operation.action} · {operation.status}</span>
                    {operation.error && <small>{operation.error}</small>}
                  </div>
                </div>
              ))}
            </div>
          )}
          <button
            className="sync-now-button"
            type="button"
            disabled={!online || !window.navigator.onLine || syncing}
            onClick={onRefresh}
          >
            {syncing || !online || !window.navigator.onLine ? "Sincronizando..." : "Actualizar ahora"}
          </button>
        </div>
      )}
    </div>
  );
}

export default SyncStatusPanel;
