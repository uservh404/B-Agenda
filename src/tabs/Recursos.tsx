import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Cloud, Eye, MapPin, Package, Search, Tag, X } from "lucide-react";
import Sidebar from "../components/Sidebar";
import ConfirmDialog from "../components/ConfirmDialog";
import { useAuth } from "../auth/useAuth";
import {
  getResourceManagementPermission,
  removeResourceChangeSignalSubscription,
  subscribeToResourceChangeSignals,
} from "../services/resources";
import type {
  ResourceInput,
  ResourceItem,
} from "../services/resources";
import {
  discardResourceOperations,
  enqueueResourceOperations,
  getResourceCacheIdentity,
  mergeResourcesWithOutbox,
  readResourceCache,
  resetRejectedResourceOperationForRetry,
  saveResourcePermission,
  type DisplayResource,
  type ResourceCacheBundle,
  type ResourceCacheIdentity,
  type ResourceOperationDraft,
} from "../services/resource-offline-cache";
import { synchronizeResources } from "../services/resource-offline-sync";
import "./S-recursos.css";

const OFFLINE_SYNC_NOTICE = "La conexión se perdió antes de iniciar la sincronización. Los cambios se reintentarán sincronizar al reconectarse.";

function Recursos() {
  const { profile, user } = useAuth();
  const identity = useMemo(
    () => user?.id ? getResourceCacheIdentity(user.id) : null,
    [user],
  );
  const [cacheState, setCacheState] = useState<{
    scope: string;
    snapshot: ResourceItem[] | null;
    snapshotSavedAt: string | null;
    operations: ResourceCacheBundle["operations"];
    canManageResources: boolean | null;
  }>({
    scope: "",
    snapshot: null,
    snapshotSavedAt: null,
    operations: [],
    canManageResources: null,
  });
  const [cacheLoadedScope, setCacheLoadedScope] = useState<string | null>(null);
  const [cacheReadError, setCacheReadError] = useState<{ scope: string; message: string } | null>(null);
  const [searchText, setSearchText] = useState("");
  const [resourceToView, setResourceToView] = useState<DisplayResource | null>(null);
  const [resourcePendingDeletion, setResourcePendingDeletion] = useState<DisplayResource | null>(null);
  const [deletionScope, setDeletionScope] = useState<string | null>(null);
  const [resourceToDiscard, setResourceToDiscard] = useState<DisplayResource | null>(null);
  const [discardScope, setDiscardScope] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [modalScope, setModalScope] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingExpectedVersion, setEditingExpectedVersion] = useState<number | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [operationError, setOperationError] = useState("");
  const [operationMessage, setOperationMessage] = useState("");
  const [realtimeWarning, setRealtimeWarning] = useState("");
  const [isOnline, setIsOnline] = useState(() => window.navigator.onLine);
  const [serverState, setServerState] = useState<{ scope: string; reachable: boolean }>({
    scope: "",
    reachable: false,
  });
  const [permissionState, setPermissionState] = useState<{
    scope: string;
    allowed: boolean;
    error: string;
  } | null>(null);
  const [checkingPermissionScope, setCheckingPermissionScope] = useState<string | null>(null);
  const [syncingScope, setSyncingScope] = useState<string | null>(null);
  const syncingScopeRef = useRef<string | null>(null);
  const [lastSuccessfulSyncState, setLastSuccessfulSyncState] = useState<{
    scope: string;
    at: string;
  } | null>(null);
  const [syncError, setSyncError] = useState<{ scope: string; message: string } | null>(null);
  const [syncPanelOpen, setSyncPanelOpen] = useState(false);
  const [refreshSequence, setRefreshSequence] = useState(0);
  const deletionInProgress = useRef(false);
  const syncPanelRef = useRef<HTMLDivElement>(null);
  const [resourceList, setResourceList] = useState<Array<{
    name: string;
    category: string;
    quantity: string;
    storedIn: string;
    notes: string;
  }>>([
    { name: "", category: "", quantity: "1", storedIn: "", notes: "" },
  ]);

  const currentUserId = user?.id;
  const currentRole = profile?.role;
  const isAdministrator = currentRole === "administrador";
  const activeCache = identity && cacheState.scope === identity.scope ? cacheState : null;
  const lastSuccessfulSyncAt = lastSuccessfulSyncState
    && lastSuccessfulSyncState.scope === identity?.scope
    ? lastSuccessfulSyncState.at
    : activeCache?.snapshotSavedAt ?? null;
  const resources = useMemo(
    () => activeCache
      ? mergeResourcesWithOutbox(activeCache.snapshot ?? [], activeCache.operations)
      : [],
    [activeCache],
  );
  const inventorySummary = resources.reduce((summary, resource) => ({
    resourceCount: summary.resourceCount + 1,
    totalUnits: summary.totalUnits + resource.quantity,
  }), { resourceCount: 0, totalUnits: 0 });
  const cachedPermission = activeCache?.canManageResources ?? null;
  const currentPermission = permissionState?.scope === identity?.scope
    ? permissionState
    : null;
  const isCheckingPermission = checkingPermissionScope === identity?.scope;
  const hasPermissionResult = currentPermission !== null || cachedPermission !== null;
  const isLoadingPermission = !isAdministrator
    && !!identity
    && (isCheckingPermission || (isOnline && !hasPermissionResult));
  const canManage = isAdministrator
    || ((currentPermission?.allowed ?? cachedPermission) === true && !isLoadingPermission);
  const permissionError = currentPermission?.error ?? "";
  const isLoading = !!identity && cacheLoadedScope !== identity.scope;
  const hasCachedSnapshot = activeCache?.snapshot !== null && activeCache !== null;
  const isSyncing = syncingScope === identity?.scope;
  const pendingOperations = activeCache?.operations ?? [];
  const pendingCount = pendingOperations.filter((operation) => operation.status === "pending").length;
  const problemOperations = pendingOperations.filter((operation) => operation.status !== "pending");
  const unsyncedOperationCount = pendingOperations.length;
  const pendingDeletionCount = pendingOperations.filter((operation) => operation.kind === "delete").length;
  const displayedSyncError = syncError && syncError.scope === identity?.scope ? syncError.message : "";
  const displayedCacheError = cacheReadError && cacheReadError.scope === identity?.scope
    ? cacheReadError.message
    : "";
  const serverReachable = serverState.scope === identity?.scope && serverState.reachable;
  const resourceConnectionAvailable = isOnline && serverReachable;
  const hasResourceSyncAttention = pendingCount > 0
    || problemOperations.length > 0
    || !!displayedSyncError
    || !!permissionError
    || !!realtimeWarning;
  const resourceSyncStatusLabel = !isOnline
    ? "Sin conexión"
    : isSyncing
      ? "Sincronizando"
      : pendingCount > 0
        ? "Sincronización pendiente"
        : hasResourceSyncAttention
          ? "Requiere atención"
          : resourceConnectionAvailable
            ? "Todo sincronizado"
            : "Sincronización pendiente";
  const resourcePanelWarnings = [...new Set([
    permissionError,
    displayedSyncError,
    !isOnline ? OFFLINE_SYNC_NOTICE : "",
  ].filter(Boolean))];
  const loadError = displayedCacheError
    || (!hasCachedSnapshot
      && resources.length === 0
      && !isLoading
      && !serverReachable
      && displayedSyncError)
    || "";
  const showInitialLoading = isLoading
    || (!!identity
      && cacheLoadedScope === identity.scope
      && isOnline
      && !hasCachedSnapshot
      && resources.length === 0
      && !serverReachable
      && !displayedSyncError);

  useEffect(() => {
    if (!operationMessage) return;
    const timeoutId = window.setTimeout(() => setOperationMessage(""), 4500);
    return () => window.clearTimeout(timeoutId);
  }, [operationMessage]);

  useEffect(() => {
    if (!syncPanelOpen) return;
    const closeOnOutsideClick = (event: PointerEvent) => {
      if (event.target instanceof Node && !syncPanelRef.current?.contains(event.target)) {
        setSyncPanelOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSyncPanelOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsideClick);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsideClick);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [syncPanelOpen]);

  const applyCacheBundle = useCallback((target: ResourceCacheIdentity, bundle: ResourceCacheBundle) => {
    setCacheState({
      scope: target.scope,
      snapshot: bundle.snapshot,
      snapshotSavedAt: bundle.snapshotSavedAt,
      operations: bundle.operations,
      canManageResources: bundle.canManageResources,
    });
  }, []);

  const refreshLocalCache = useCallback(async (target: ResourceCacheIdentity) => {
    const bundle = await readResourceCache(target);
    applyCacheBundle(target, bundle);
    setCacheLoadedScope(target.scope);
    return bundle;
  }, [applyCacheBundle]);

  useEffect(() => {
    const updateOnlineStatus = () => {
      const online = window.navigator.onLine;
      setIsOnline(online);
      setOperationMessage("");
      if (!online) {
        setServerState((current) => ({ ...current, reachable: false }));
        syncingScopeRef.current = null;
        setSyncingScope(null);
        setCheckingPermissionScope(null);
      }
    };
    window.addEventListener("online", updateOnlineStatus);
    window.addEventListener("offline", updateOnlineStatus);
    return () => {
      window.removeEventListener("online", updateOnlineStatus);
      window.removeEventListener("offline", updateOnlineStatus);
    };
  }, []);

  useEffect(() => {
    if (!identity) return;

    let active = true;
    void readResourceCache(identity).then((bundle) => {
      if (!active) return;
      applyCacheBundle(identity, bundle);
      setCacheReadError(null);
      setCacheLoadedScope(identity.scope);
    }).catch((error: unknown) => {
      if (!active) return;
      setCacheReadError({
        scope: identity.scope,
        message: error instanceof Error
          ? `No se pudo leer el inventario guardado: ${error.message}`
          : "No se pudo leer el inventario guardado en este equipo.",
      });
      setCacheLoadedScope(identity.scope);
    });

    return () => { active = false; };
  }, [identity, applyCacheBundle]);

  useEffect(() => {
    if (!identity || cacheLoadedScope !== identity.scope || !isOnline) return;

    let active = true;
    void (async () => {
      await Promise.resolve();
      if (!active) return;
      setCheckingPermissionScope(identity.scope);
      syncingScopeRef.current = identity.scope;
      setSyncingScope(identity.scope);
      try {
        const allowed = await getResourceManagementPermission(identity.userId);
        if (!active) return;
        await saveResourcePermission(identity, allowed);
        const bundle = await readResourceCache(identity);
        if (active) {
          applyCacheBundle(identity, bundle);
          setPermissionState({ scope: identity.scope, allowed, error: "" });
        }
      } catch {
        if (active) {
          let knownPermission: boolean | null = null;
          try {
            const bundle = await readResourceCache(identity);
            knownPermission = bundle.canManageResources;
            applyCacheBundle(identity, bundle);
          } catch {
            setCacheReadError({
              scope: identity.scope,
              message: "No se pudo leer el permiso guardado localmente.",
            });
          }
          setPermissionState({
            scope: identity.scope,
            allowed: knownPermission === true,
            error: knownPermission === null
              ? "No se pudo verificar el permiso de administración."
              : "",
          });
        }
      } finally {
        if (active) setCheckingPermissionScope(null);
      }

      const result = await synchronizeResources(identity);
      if (!active) return;
      if (result.serverReachable && !result.error) {
        setLastSuccessfulSyncState({
          scope: identity.scope,
          at: new Date().toISOString(),
        });
      }
      setServerState({ scope: identity.scope, reachable: result.serverReachable });
      setSyncError(result.error
        ? { scope: identity.scope, message: result.error }
        : null);
      try {
        await refreshLocalCache(identity);
      } catch (error) {
        setCacheReadError({
          scope: identity.scope,
          message: error instanceof Error
            ? `No se pudo actualizar el inventario local: ${error.message}`
            : "No se pudo actualizar el inventario local.",
        });
      }
    })().catch((error: unknown) => {
      if (active) {
        setSyncError({
          scope: identity.scope,
          message: error instanceof Error ? error.message : "No se pudo sincronizar Recursos.",
        });
      }
    }).finally(() => {
      if (active) {
        syncingScopeRef.current = null;
        setSyncingScope(null);
      }
    });

    return () => { active = false; };
  }, [
    identity,
    cacheLoadedScope,
    isOnline,
    refreshSequence,
    applyCacheBundle,
    refreshLocalCache,
  ]);

  useEffect(() => {
    if (!currentUserId || !identity) return;

    let active = true;
    const channel = subscribeToResourceChangeSignals(
      currentUserId,
      () => {
        if (active && window.navigator.onLine) {
          setRefreshSequence((sequence) => sequence + 1);
        }
      },
      (status) => {
        if (!active) return;
        if (status === "SUBSCRIBED") {
          setRealtimeWarning("");
          if (window.navigator.onLine) {
            setRefreshSequence((sequence) => sequence + 1);
          }
        } else {
          setRealtimeWarning("La actualización automática no está disponible. Los cambios se actualizarán al recargar la lista.");
        }
      },
    );
    const refreshOnFocus = () => {
      if (window.navigator.onLine) {
        setRefreshSequence((sequence) => sequence + 1);
      }
    };
    window.addEventListener("focus", refreshOnFocus);

    return () => {
      active = false;
      window.removeEventListener("focus", refreshOnFocus);
      void removeResourceChangeSignalSubscription(channel);
    };
  }, [currentUserId, identity]);

  const resetResourceList = () => {
    setResourceList([{ name: "", category: "", quantity: "1", storedIn: "", notes: "" }]);
  };

  const updateResourceRow = (
    index: number,
    field: "name" | "category" | "quantity" | "storedIn" | "notes",
    value: string,
  ) => {
    setResourceList((prev) =>
      prev.map((item, i) => (i === index ? { ...item, [field]: value } : item)),
    );
  };

  const addResourceRow = () => {
    setResourceList((prev) => [
      ...prev,
      { name: "", category: "", quantity: "1", storedIn: "", notes: "" },
    ]);
  };

  const removeResourceRow = (index: number) => {
    if (resourceList.length === 1) {
      resetResourceList();
      return;
    }

    setResourceList((prev) => prev.filter((_, i) => i !== index));
  };

  const openCreateModal = () => {
    if (!identity) return;
    setOperationError("");
    setOperationMessage("");
    setEditingId(null);
    setEditingExpectedVersion(null);
    resetResourceList();
    setModalScope(identity.scope);
    setModalOpen(true);
  };

  const openEditModal = (resource: ResourceItem) => {
    if (!identity) return;
    setEditingId(resource.id);
    setEditingExpectedVersion(resource.version);
    setResourceList([
      {
        name: resource.name,
        category: resource.category,
        quantity: String(resource.quantity),
        storedIn: resource.storedIn,
        notes: resource.notes.join("\n"),
      },
    ]);
    setOperationError("");
    setOperationMessage("");
    setModalScope(identity.scope);
    setModalOpen(true);
  };

  const synchronizeAndRefresh = useCallback(async (target: ResourceCacheIdentity) => {
    syncingScopeRef.current = target.scope;
    setSyncingScope(target.scope);
    try {
      const result = await synchronizeResources(target);
      if (result.serverReachable && !result.error) {
        setLastSuccessfulSyncState({
          scope: target.scope,
          at: new Date().toISOString(),
        });
      }
      setServerState({ scope: target.scope, reachable: result.serverReachable });
      setSyncError(result.error
        ? { scope: target.scope, message: result.error }
        : null);
      const bundle = await refreshLocalCache(target);
      return { result, bundle };
    } finally {
      syncingScopeRef.current = null;
      setSyncingScope(null);
    }
  }, [refreshLocalCache]);

  useEffect(() => {
    if (!identity || cacheLoadedScope !== identity.scope || !isOnline || isSyncing) return;

    const intervalId = window.setInterval(() => {
      if (!window.navigator.onLine || syncingScopeRef.current !== null) return;
      void synchronizeAndRefresh(identity).catch((error: unknown) => {
        setSyncError({
          scope: identity.scope,
          message: error instanceof Error
            ? `No se pudo actualizar Recursos: ${error.message}`
            : "No se pudo actualizar Recursos.",
        });
      });
    }, 15000);

    return () => window.clearInterval(intervalId);
  }, [identity, cacheLoadedScope, isOnline, isSyncing, synchronizeAndRefresh]);

  const handleSave = async () => {
    if (!canManage) {
      setOperationError("No tienes permiso para administrar los recursos.");
      return;
    }
    if (!identity || modalScope !== identity.scope || cacheLoadedScope !== identity.scope) {
      setOperationError("El almacenamiento local de Recursos todavía no está listo.");
      return;
    }

    const validRows = resourceList.filter(
      (item) => item.name.trim() || item.category.trim() || item.notes.trim(),
    );

    if (!validRows.length) {
      setOperationError("Agrega al menos un recurso antes de guardar.");
      return;
    }

    let entriesToSave: ResourceInput[];
    try {
      entriesToSave = validRows.map((item, index) => {
        if (!item.name.trim() || !item.category.trim()) {
          throw new Error(`Falta nombre o categoría en el recurso ${index + 1}.`);
        }

        const quantity = Number(item.quantity);
        if (!item.quantity.trim() || !Number.isInteger(quantity) || quantity < 0) {
          throw new Error(`La cantidad del recurso ${index + 1} debe ser un entero igual o mayor que cero.`);
        }

        const cleanedNotes = item.notes
          .split("\n")
          .map((entry) => entry.trim())
          .filter(Boolean);

        return {
          name: item.name.trim(),
          category: item.category.trim(),
          quantity,
          storedIn: item.storedIn.trim() || "Sin ubicación registrada",
          notes: cleanedNotes.length ? cleanedNotes : ["Sin observaciones"],
        };
      });
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Revisa los datos del recurso.");
      return;
    }

    if (editingId !== null && entriesToSave.length !== 1) {
      setOperationError("Edita un solo recurso a la vez.");
      return;
    }

    setIsSaving(true);
    setOperationError("");
    setOperationMessage("");
    try {
      let drafts: ResourceOperationDraft[];
      if (editingId !== null) {
        if (editingExpectedVersion === null) {
          throw new Error("No se encontró el recurso que intentas modificar.");
        }
        drafts = [{
          operationId: crypto.randomUUID(),
          kind: "update" as const,
          resourceId: editingId,
          expectedVersion: editingExpectedVersion,
          input: entriesToSave[0],
        }];
      } else {
        drafts = entriesToSave.map((input) => ({
          operationId: crypto.randomUUID(),
          kind: "create" as const,
          resourceId: crypto.randomUUID(),
          expectedVersion: 0,
          input,
        }));
      }

      await enqueueResourceOperations(identity, drafts);
      await refreshLocalCache(identity);
      let remaining = drafts.map((draft) => draft.operationId);
      if (window.navigator.onLine) {
        const { bundle } = await synchronizeAndRefresh(identity);
        const stillQueued = new Set(bundle.operations.map((operation) => operation.operationId));
        remaining = remaining.filter((operationId) => stillQueued.has(operationId));
        const issue = bundle.operations.find((operation) =>
          drafts.some((draft) => draft.operationId === operation.operationId)
          && operation.status !== "pending",
        );
        if (issue) setOperationError(issue.lastError ?? "El cambio necesita revisión.");
      }

      setEditingId(null);
      setEditingExpectedVersion(null);
      resetResourceList();
      setModalScope(null);
      setModalOpen(false);
      if (remaining.length === 0) {
        setOperationMessage(editingId === null
          ? "Los recursos se guardaron correctamente."
          : "El recurso se actualizó correctamente.");
      } else {
        setOperationMessage("El cambio se guardó en este equipo y está pendiente de sincronización.");
      }
    } catch (error) {
      setOperationError(error instanceof Error
        ? `No se pudo guardar el cambio local: ${error.message}`
        : "No se pudo guardar el cambio local. Inténtalo nuevamente.");
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async () => {
    const resource = resourcePendingDeletion;
    if (!resource || deletionInProgress.current) return;

    if (!canManage) {
      setOperationError("No tienes permiso para administrar los recursos.");
      setResourcePendingDeletion(null);
      return;
    }
    if (!identity || deletionScope !== identity.scope || cacheLoadedScope !== identity.scope) {
      setOperationError("El almacenamiento local de Recursos todavía no está listo.");
      return;
    }

    deletionInProgress.current = true;
    setDeletingId(resource.id);
    setOperationError("");
    setOperationMessage("");
    try {
      const operationId = crypto.randomUUID();
      await enqueueResourceOperations(identity, [{
        operationId,
        kind: "delete",
        resourceId: resource.id,
        expectedVersion: resource.version,
      }]);
      await refreshLocalCache(identity);
      let stillQueued = true;
      let needsReview = false;
      if (window.navigator.onLine) {
        const { bundle } = await synchronizeAndRefresh(identity);
        const operation = bundle.operations.find((entry) => entry.operationId === operationId);
        stillQueued = !!operation;
        if (operation && operation.status !== "pending") {
          needsReview = true;
          setOperationError(operation.lastError ?? "La eliminación necesita revisión.");
        }
      }
      setResourcePendingDeletion(null);
      setDeletionScope(null);
      setOperationMessage(needsReview
        ? "La eliminación requiere revisión antes de sincronizarse."
        : stillQueued
          ? "La eliminación quedó guardada en este equipo y pendiente de sincronización."
          : "El recurso se eliminó correctamente.");
    } catch (error) {
      setOperationError(error instanceof Error
        ? `No se pudo guardar la eliminación local: ${error.message}`
        : "No se pudo guardar la eliminación local. Inténtalo nuevamente.");
    } finally {
      deletionInProgress.current = false;
      setDeletingId(null);
    }
  };

  const handleDiscardLocalChanges = async () => {
    if (!identity || !resourceToDiscard || discardScope !== identity.scope) return;
    try {
      await discardResourceOperations(identity, resourceToDiscard.id);
      setResourceToDiscard(null);
      setDiscardScope(null);
      await refreshLocalCache(identity);
      if (window.navigator.onLine) {
        await synchronizeAndRefresh(identity);
      }
      setOperationMessage("Se descartaron los cambios locales no sincronizados.");
      setOperationError("");
    } catch (error) {
      setOperationError(error instanceof Error
        ? `No se pudieron descartar los cambios locales: ${error.message}`
        : "No se pudieron descartar los cambios locales.");
    }
  };

  const handleRetryRejectedOperation = async (resource: DisplayResource) => {
    if (!identity || !resource.syncOperationId) return;
    try {
      await resetRejectedResourceOperationForRetry(identity, resource.syncOperationId);
      await refreshLocalCache(identity);
      if (window.navigator.onLine) {
        await synchronizeAndRefresh(identity);
      }
      setOperationMessage("El cambio quedó listo para volver a sincronizarse.");
      setOperationError("");
    } catch (error) {
      setOperationError(error instanceof Error
        ? error.message
        : "No se pudo reintentar el cambio.");
    }
  };

  const handleRetrySynchronization = () => {
    if (!window.navigator.onLine) return;
    setRefreshSequence((sequence) => sequence + 1);
  };

  const normalizedSearch = searchText.trim().toLocaleLowerCase("es");
  const filteredResources = resources.filter((resource) =>
    resource.name.toLocaleLowerCase("es").includes(normalizedSearch),
  );

  const resourceSummary = resourceToView
    ? resources.find((resource) => resource.id === resourceToView.id) ?? null
    : null;

  return (
    <div className="recursos-page">
      <Sidebar />

      <main className="recursos-content">
        <div className="recursos-shell">
          <header className="recursos-header">
            <div>
              <span className="eyebrow">Inventario</span>
              <h1>Recursos</h1>
            </div>

            {canManage && !isLoadingPermission && (
              <button
                type="button"
                className="add-resource-btn"
                onClick={openCreateModal}
                disabled={isSaving}
                aria-label="Registrar recursos"
                title={!isOnline ? "El recurso se guardará en este equipo hasta que vuelva la conexión." : undefined}
              >
                +
              </button>
            )}
          </header>

          <div className="resources-toolbar">
            <label className="resource-search" htmlFor="resource-search">
              <Search size={18} aria-hidden="true" />
              <input
                id="resource-search"
                type="search"
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
                placeholder="Buscar por nombre o título"
                aria-label="Buscar recurso por nombre o título"
              />
            </label>
          </div>

          <div className="resources-status">
            <div className="sync-panel-anchor" ref={syncPanelRef}>
              <button
                type="button"
                className={`sync-indicator ${!isOnline ? "is-offline" : ""}`}
                aria-label={`Estado de sincronización de Recursos: ${resourceSyncStatusLabel}. ${unsyncedOperationCount} operaciones pendientes.`}
                aria-expanded={syncPanelOpen}
                aria-haspopup="dialog"
                aria-controls="resources-sync-panel"
                onClick={() => setSyncPanelOpen((open) => !open)}
              >
                <Cloud size={19} aria-hidden="true" />
              </button>
              {syncPanelOpen && (
                <div id="resources-sync-panel" className="sync-panel" role="dialog" aria-label="Estado de conexión y sincronización de Recursos">
                  <div className="sync-panel-heading">
                    <strong>Estado de Recursos</strong>
                    <span className={`sync-connection-state ${resourceConnectionAvailable ? "connected" : "disconnected"}`}>
                      {resourceConnectionAvailable ? "Con conexión" : "Sin conexión"}
                    </span>
                    <button
                      type="button"
                      className="resource-sync-panel-close"
                      aria-label="Cerrar estado de sincronización"
                      onClick={() => setSyncPanelOpen(false)}
                    >
                      <X size={16} aria-hidden="true" />
                    </button>
                  </div>
                  <p className="sync-status-line">{resourceSyncStatusLabel}</p>
                  <div className="sync-counts">
                    <span>Operaciones pendientes <strong>{unsyncedOperationCount}</strong></span>
                    <span>Eliminaciones pendientes <strong>{pendingDeletionCount}</strong></span>
                  </div>
                  <p className="sync-last-success">
                    Última sincronización correcta: {lastSuccessfulSyncAt
                      ? new Date(lastSuccessfulSyncAt).toLocaleString("es-MX")
                      : "Aún no hay una sincronización confirmada."}
                  </p>
                  {resourcePanelWarnings.length > 0 && (
                    <div className="sync-panel-warnings" role="status">
                      {resourcePanelWarnings.map((warning) => <p key={warning}>{warning}</p>)}
                    </div>
                  )}
                  {pendingOperations.length > 0 && (
                    <div className="sync-operation-list">
                      {pendingOperations.map((operation) => (
                        <div className="sync-operation-item" key={operation.operationId}>
                          <div className="sync-operation-copy">
                            <strong>
                              {operation.optimisticResource?.name
                                ?? operation.previousResource?.name
                                ?? operation.input?.name
                                ?? "Recurso"}
                            </strong>
                            <span>
                              {operation.kind === "create"
                                ? "Creación"
                                : operation.kind === "update" ? "Modificación" : "Eliminación"}
                              {" · "}
                              {operation.status === "pending"
                                ? "Pendiente de sincronización"
                                : operation.status === "conflict" ? "Conflicto" : "Rechazado"}
                            </span>
                            {(operation.lastError || operation.status !== "pending") && (
                              <small>
                                {operation.lastError ?? "Este cambio requiere revisión."}
                              </small>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <button
                    className="sync-now-button"
                    type="button"
                    disabled={!isOnline || !window.navigator.onLine || isSyncing}
                    onClick={handleRetrySynchronization}
                  >
                    {isSyncing || !isOnline || !window.navigator.onLine
                      ? "Sincronizando..."
                      : "Actualizar ahora"}
                  </button>
                </div>
              )}
            </div>
            <span className="resources-count">
              {inventorySummary.resourceCount} {inventorySummary.resourceCount === 1 ? "recurso" : "recursos"}
            </span>
          </div>
          {operationError && <p className="resources-error" role="alert">{operationError}</p>}
          {isOnline && operationMessage && !operationError && (
            <p className="resources-success" role="status">{operationMessage}</p>
          )}

          <section className="resources-grid" aria-label="Inventario de recursos">
            {showInitialLoading ? (
              <div className="resources-empty"><p>Cargando recursos...</p></div>
            ) : loadError ? (
              <div className="resources-empty" role="alert">
                <p>{loadError}</p>
                <button type="button" className="resource-retry-btn" onClick={handleRetrySynchronization}>
                  Intentar de nuevo
                </button>
              </div>
            ) : resources.length === 0 ? (
              <div className="resources-empty">
                <p>{searchText.trim() ? "No hay recursos para mostrar." : "Aún no hay recursos registrados."}</p>
              </div>
            ) : filteredResources.length === 0 ? (
              <div className="resources-empty">
                <p>No encontramos recursos con ese nombre.</p>
              </div>
            ) : filteredResources.map((resource) => (
              <article key={resource.id} className="resource-card">
                <div className="resource-top">
                  <div className="resource-icon">📦</div>
                  <span className="resource-category">{resource.category}</span>
                </div>

                <h3>{resource.name}</h3>
                {resource.syncStatus && (
                  <div className={`resource-sync-state is-${resource.syncStatus}`}>
                    <span>
                      {resource.syncStatus === "pending"
                        ? "Pendiente de sincronización"
                        : resource.syncMessage ?? "El cambio necesita revisión."}
                    </span>
                    {resource.syncStatus === "conflict" || resource.syncStatus === "rejected" ? (
                      <div className="resource-sync-actions">
                        {resource.syncStatus === "rejected"
                          && (resource.syncErrorCode === "not_authorized"
                            || resource.syncErrorCode === "sync_error")
                          && canManage && (
                            <button
                              type="button"
                              onClick={() => { void handleRetryRejectedOperation(resource); }}
                            >
                              Reintentar
                            </button>
                          )}
                        <button
                          type="button"
                          onClick={() => {
                            setDiscardScope(identity?.scope ?? null);
                            setResourceToDiscard(resource);
                          }}
                        >
                          Descartar cambio local
                        </button>
                      </div>
                    ) : null}
                  </div>
                )}
                <div className="resource-quantity">
                  <strong>{resource.quantity}</strong>
                  <span>Unidades</span>
                </div>

                <div className="resource-meta">
                  <p><strong>Se almacenó en:</strong> {resource.storedIn}</p>
                  <div className="resource-notes-box">
                    <strong>Notas:</strong>
                    <ul>
                      {resource.notes.map((note, index) => (
                        <li key={`${resource.id}-${index}`}>{note}</li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="resource-actions">
                  <button type="button" className="resource-summary-btn" onClick={() => setResourceToView(resource)} aria-label={`Ver resumen de ${resource.name}`}>
                    <Eye size={16} aria-hidden="true" />
                    <span>Ver resumen</span>
                  </button>
                  <div className="resource-edit-delete-actions">
                    {canManage && !isLoadingPermission && (
                      <>
                        <button
                          type="button"
                          className="edit-resource-btn"
                          onClick={() => openEditModal(resource)}
                          disabled={deletingId === resource.id || isSaving}
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          className="delete-resource-btn"
                          onClick={() => {
                            setOperationError("");
                            setOperationMessage("");
                            setDeletionScope(identity?.scope ?? null);
                            setResourcePendingDeletion(resource);
                          }}
                          disabled={deletingId !== null || isSaving}
                        >
                          {deletingId === resource.id ? "Eliminando..." : "Eliminar"}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </article>
            ))}
          </section>
        </div>
      </main>

      {resourceSummary && (
        <div className="resource-summary-backdrop" onClick={() => setResourceToView(null)}>
          <section className="resource-summary-dialog" role="dialog" aria-modal="true" aria-labelledby="resource-summary-title" onClick={(event) => event.stopPropagation()}>
            <header className="resource-summary-header">
              <span className="resource-summary-icon" aria-hidden="true"><Package size={22} /></span>
              <div>
                <span>Resumen del recurso</span>
                <h2 id="resource-summary-title">{resourceSummary.name}</h2>
              </div>
              <button type="button" className="resource-summary-close" onClick={() => setResourceToView(null)} aria-label="Cerrar resumen"><X size={19} /></button>
            </header>

            <div className="resource-summary-content">
              <div className="resource-summary-facts">
                <article>
                  <Tag size={17} aria-hidden="true" />
                  <div><span>Categoría</span><strong>{resourceSummary.category}</strong></div>
                </article>
                <article>
                  <Package size={17} aria-hidden="true" />
                  <div><span>Cantidad disponible</span><strong>{resourceSummary.quantity} {resourceSummary.quantity === 1 ? "unidad" : "unidades"}</strong></div>
                </article>
                <article className="resource-summary-location">
                  <MapPin size={17} aria-hidden="true" />
                  <div><span>Ubicación</span><strong>{resourceSummary.storedIn}</strong></div>
                </article>
              </div>

              <section className="resource-summary-notes">
                <h3>Notas</h3>
                <ul>
                  {resourceSummary.notes.map((note, index) => <li key={`${resourceSummary.id}-summary-${index}`}>{note}</li>)}
                </ul>
              </section>
            </div>

            <footer className="resource-summary-footer">
              <button type="button" onClick={() => setResourceToView(null)}>Cerrar</button>
            </footer>
          </section>
        </div>
      )}

      {modalOpen && modalScope === identity?.scope && canManage && !isLoadingPermission && (
        <div className="modal-backdrop" onClick={() => setModalOpen(false)}>
          <div className="resource-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>{editingId !== null ? "Editar recurso" : "Registrar recursos"}</h3>
              <button
                type="button"
                className="close-modal"
                disabled={isSaving}
                onClick={() => {
                  setEditingId(null);
                  setEditingExpectedVersion(null);
                  resetResourceList();
                  setModalScope(null);
                  setModalOpen(false);
                }}
              >
                ✕
              </button>
            </div>

            <div className="multi-resource-list">
              {resourceList.map((item, index) => (
                <div key={`resource-row-${index}`} className="resource-row">
                  <button type="button" className="remove-row-btn" disabled={isSaving} onClick={() => removeResourceRow(index)}>
                    −
                  </button>

                  <div className="modal-form">
                    <div className="field">
                      <label>Nombre</label>
                      <input
                        type="text"
                        value={item.name}
                        disabled={isSaving}
                        onChange={(event) => updateResourceRow(index, "name", event.target.value)}
                        placeholder="Ej. Sillas de lectura"
                      />
                    </div>

                    <div className="field">
                      <label>Categoría</label>
                      <input
                        type="text"
                        value={item.category}
                        disabled={isSaving}
                        onChange={(event) => updateResourceRow(index, "category", event.target.value)}
                        placeholder="Ej. Mobiliario"
                      />
                    </div>

                    <div className="field">
                      <label>Cantidad</label>
                      <input
                        type="number"
                        min="0"
                        step="1"
                        value={item.quantity}
                        disabled={isSaving}
                        onChange={(event) => updateResourceRow(index, "quantity", event.target.value)}
                      />
                    </div>

                    <div className="field">
                      <label>Se almacenó en</label>
                      <input
                        type="text"
                        value={item.storedIn}
                        disabled={isSaving}
                        onChange={(event) => updateResourceRow(index, "storedIn", event.target.value)}
                        placeholder="Ej. Sala 1 / almacén / estante A"
                      />
                    </div>

                    <div className="field full-width">
                      <label>Notas</label>
                      <textarea
                        rows={3}
                        value={item.notes}
                        disabled={isSaving}
                        onChange={(event) => updateResourceRow(index, "notes", event.target.value)}
                        placeholder="Escribe una nota por línea\nEjemplo:\n- En buen estado\n- Requiere revisión"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="modal-footer-actions">
              {editingId === null && (
                <button type="button" className="secondary-btn" disabled={isSaving} onClick={addResourceRow}>
                  + Añadir otro
                </button>
              )}

              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary-btn"
                  disabled={isSaving}
                  onClick={() => {
                    setEditingId(null);
                    setEditingExpectedVersion(null);
                    resetResourceList();
                    setModalScope(null);
                    setModalOpen(false);
                  }}
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  className="primary-btn"
                  onClick={() => { void handleSave(); }}
                  disabled={isSaving || !canManage}
                >
                  {isSaving ? "Guardando..." : isOnline ? "Guardar" : "Guardar en este equipo"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {resourcePendingDeletion && deletionScope === identity?.scope && canManage && (
        <ConfirmDialog
          title="Eliminar recurso"
          message="¿Estás seguro de que deseas eliminar este recurso?"
          detail={resourcePendingDeletion.name.trim() === "+" ? undefined : resourcePendingDeletion.name}
          errorMessage={operationError || undefined}
          confirmLabel="Sí, eliminar"
          isConfirming={deletingId === resourcePendingDeletion.id}
          onCancel={() => {
            if (deletionInProgress.current) return;
            setResourcePendingDeletion(null);
            setDeletionScope(null);
            setOperationError("");
          }}
          onConfirm={() => { void handleDelete(); }}
        />
      )}

      {resourceToDiscard && discardScope === identity?.scope && (
        <ConfirmDialog
          title="Descartar cambios locales"
          message="Se perderán los cambios de este recurso que todavía no se han sincronizado. ¿Deseas continuar?"
          detail={resourceToDiscard.name}
          confirmLabel="Descartar"
          onCancel={() => {
            setResourceToDiscard(null);
            setDiscardScope(null);
          }}
          onConfirm={() => { void handleDiscardLocalChanges(); }}
        />
      )}
    </div>
  );
}

export default Recursos;
