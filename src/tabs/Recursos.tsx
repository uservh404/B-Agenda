import { useState } from "react";
import { Eye, MapPin, Package, Search, Tag, X } from "lucide-react";
import Sidebar from "../components/Sidebar";
import "./S-recursos.css";

type ResourceItem = {
  id: number;
  name: string;
  category: string;
  quantity: number;
  storedIn: string;
  notes: string[];
};

const initialResources: ResourceItem[] = [];

function Recursos() {
  const [resources, setResources] = useState<ResourceItem[]>(initialResources);
  const [searchText, setSearchText] = useState("");
  const [resourceToView, setResourceToView] = useState<ResourceItem | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [resourceList, setResourceList] = useState<Array<{
    name: string;
    category: string;
    quantity: string;
    storedIn: string;
    notes: string;
  }>>([
    { name: "", category: "", quantity: "1", storedIn: "", notes: "" },
  ]);

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
    setEditingId(null);
    resetResourceList();
    setModalOpen(true);
  };

  const openEditModal = (resource: ResourceItem) => {
    setEditingId(resource.id);
    setResourceList([
      {
        name: resource.name,
        category: resource.category,
        quantity: String(resource.quantity),
        storedIn: resource.storedIn,
        notes: resource.notes.join("\n"),
      },
    ]);
    setModalOpen(true);
  };

  const handleSave = () => {
    const validRows = resourceList.filter(
      (item) => item.name.trim() || item.category.trim() || item.notes.trim(),
    );

    if (!validRows.length) {
      alert("Agrega al menos un recurso antes de guardar.");
      return;
    }

    try {
      const entriesToSave: ResourceItem[] = validRows.map((item, index) => {
        if (!item.name.trim() || !item.category.trim()) {
          throw new Error(`Falta nombre o categoría en el recurso ${index + 1}.`);
        }

        const cleanedNotes = item.notes
          .split("\n")
          .map((entry) => entry.trim())
          .filter(Boolean);

        return {
          id: editingId ?? Date.now() + index,
          name: item.name.trim(),
          category: item.category.trim(),
          quantity: Number(item.quantity) || 0,
          storedIn: item.storedIn.trim() || "Sin ubicación registrada",
          notes: cleanedNotes.length ? cleanedNotes : ["Sin observaciones"],
        };
      });

      if (editingId !== null) {
        setResources((prev) =>
          prev.map((resource) =>
            resource.id === editingId ? { ...entriesToSave[0], id: editingId } : resource,
          ),
        );
      } else {
        setResources((prev) => [...entriesToSave, ...prev]);
      }

      setEditingId(null);
      resetResourceList();
      setModalOpen(false);
    } catch (error) {
      alert(error instanceof Error ? error.message : "Revisa los datos del recurso.");
    }
  };

  const normalizedSearch = searchText.trim().toLocaleLowerCase("es");
  const filteredResources = resources.filter((resource) =>
    resource.name.toLocaleLowerCase("es").includes(normalizedSearch),
  );

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

            <button type="button" className="add-resource-btn" onClick={openCreateModal}>
              +
            </button>
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

          <section className="resources-grid">
            {resources.length === 0 ? (
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
                    <button type="button" className="edit-resource-btn" onClick={() => openEditModal(resource)}>
                      Editar
                    </button>
                    <button
                      type="button"
                      className="delete-resource-btn"
                      onClick={() => setResources((prev) => prev.filter((item) => item.id !== resource.id))}
                    >
                      Eliminar
                    </button>
                  </div>
                </div>
              </article>
            ))}
          </section>
        </div>
      </main>

      {resourceToView && (
        <div className="resource-summary-backdrop" onClick={() => setResourceToView(null)}>
          <section className="resource-summary-dialog" role="dialog" aria-modal="true" aria-labelledby="resource-summary-title" onClick={(event) => event.stopPropagation()}>
            <header className="resource-summary-header">
              <span className="resource-summary-icon" aria-hidden="true"><Package size={22} /></span>
              <div>
                <span>Resumen del recurso</span>
                <h2 id="resource-summary-title">{resourceToView.name}</h2>
              </div>
              <button type="button" className="resource-summary-close" onClick={() => setResourceToView(null)} aria-label="Cerrar resumen"><X size={19} /></button>
            </header>

            <div className="resource-summary-content">
              <div className="resource-summary-facts">
                <article>
                  <Tag size={17} aria-hidden="true" />
                  <div><span>Categoría</span><strong>{resourceToView.category}</strong></div>
                </article>
                <article>
                  <Package size={17} aria-hidden="true" />
                  <div><span>Cantidad disponible</span><strong>{resourceToView.quantity} {resourceToView.quantity === 1 ? "unidad" : "unidades"}</strong></div>
                </article>
                <article className="resource-summary-location">
                  <MapPin size={17} aria-hidden="true" />
                  <div><span>Ubicación</span><strong>{resourceToView.storedIn}</strong></div>
                </article>
              </div>

              <section className="resource-summary-notes">
                <h3>Notas</h3>
                <ul>
                  {resourceToView.notes.map((note, index) => <li key={`${resourceToView.id}-summary-${index}`}>{note}</li>)}
                </ul>
              </section>
            </div>

            <footer className="resource-summary-footer">
              <button type="button" onClick={() => setResourceToView(null)}>Cerrar</button>
            </footer>
          </section>
        </div>
      )}

      {modalOpen && (
        <div className="modal-backdrop" onClick={() => setModalOpen(false)}>
          <div className="resource-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <h3>{editingId !== null ? "Editar recurso" : "Registrar recursos"}</h3>
              <button
                type="button"
                className="close-modal"
                onClick={() => {
                  setEditingId(null);
                  resetResourceList();
                  setModalOpen(false);
                }}
              >
                ✕
              </button>
            </div>

            <div className="multi-resource-list">
              {resourceList.map((item, index) => (
                <div key={`resource-row-${index}`} className="resource-row">
                  <button type="button" className="remove-row-btn" onClick={() => removeResourceRow(index)}>
                    −
                  </button>

                  <div className="modal-form">
                    <div className="field">
                      <label>Nombre</label>
                      <input
                        type="text"
                        value={item.name}
                        onChange={(event) => updateResourceRow(index, "name", event.target.value)}
                        placeholder="Ej. Sillas de lectura"
                      />
                    </div>

                    <div className="field">
                      <label>Categoría</label>
                      <input
                        type="text"
                        value={item.category}
                        onChange={(event) => updateResourceRow(index, "category", event.target.value)}
                        placeholder="Ej. Mobiliario"
                      />
                    </div>

                    <div className="field">
                      <label>Cantidad</label>
                      <input
                        type="number"
                        min="0"
                        value={item.quantity}
                        onChange={(event) => updateResourceRow(index, "quantity", event.target.value)}
                      />
                    </div>

                    <div className="field">
                      <label>Se almacenó en</label>
                      <input
                        type="text"
                        value={item.storedIn}
                        onChange={(event) => updateResourceRow(index, "storedIn", event.target.value)}
                        placeholder="Ej. Sala 1 / almacén / estante A"
                      />
                    </div>

                    <div className="field full-width">
                      <label>Notas</label>
                      <textarea
                        rows={3}
                        value={item.notes}
                        onChange={(event) => updateResourceRow(index, "notes", event.target.value)}
                        placeholder="Escribe una nota por línea\nEjemplo:\n- En buen estado\n- Requiere revisión"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>

            <div className="modal-footer-actions">
              <button type="button" className="secondary-btn" onClick={addResourceRow}>
                + Añadir otro
              </button>

              <div className="modal-actions">
                <button
                  type="button"
                  className="secondary-btn"
                  onClick={() => {
                    setEditingId(null);
                    resetResourceList();
                    setModalOpen(false);
                  }}
                >
                  Cancelar
                </button>
                <button type="button" className="primary-btn" onClick={handleSave}>
                  Guardar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default Recursos;
