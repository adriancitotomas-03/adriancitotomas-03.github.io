let shipments = [];
let map = null;
let shipmentMarkersLayer = null;
let simulationLayer = null;
let simulationVehicleMarker = null;
let simulationRoutePath = [];
let simulationProgress = 0;
let simulationInterval = null;
let simulationSpeed = 1;
let selectedSimulationShipment = null;
let pinValidationShipment = null;
const SIMULATION_HUB = { lat: -34.7117, lon: -58.5072 };
const SIMULATION_TICK_MS = 100;
const SIMULATION_BASE_DURATION_MS = 30000;

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...options.headers
    }
  });
  const payload = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.error || `La API respondió con el estado ${response.status}.`);
  }
  return payload;
}

async function loadShipmentsFromApi() {
  return apiRequest("/api/envios");
}

async function refreshShipmentsFromApi() {
  shipments = await loadShipmentsFromApi();
  refreshMapMarkers();
  renderShipmentsTable();
  renderSimulationShipmentOptions();
  return shipments;
}

function showToast(message, type = "info") {
  const allowedTypes = ["success", "error", "warning", "info"];
  const toastType = allowedTypes.includes(type) ? type : "info";
  let container = document.getElementById("toast-container");

  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.className = "toast-container";
    container.setAttribute("aria-label", "Notificaciones");
    document.body.append(container);
  }

  const toast = document.createElement("div");
  toast.className = `toast toast--${toastType}`;
  toast.setAttribute("role", toastType === "error" ? "alert" : "status");
  toast.setAttribute("aria-live", toastType === "error" ? "assertive" : "polite");
  toast.textContent = String(message);
  container.append(toast);

  window.setTimeout(() => {
    toast.classList.add("toast--leaving");
    toast.addEventListener("transitionend", () => toast.remove(), { once: true });
    window.setTimeout(() => toast.remove(), 300);
  }, 3500);

  return toast;
}

function renderShipmentsTable(filterText = document.getElementById("records-filter")?.value || "") {
  const tableBody = document.getElementById("shipments-table-body");
  if (!tableBody) {
    return 0;
  }

  const normalizedFilter = String(filterText).trim().toLocaleLowerCase("es");

  const statusLabels = {
    preparacion: "En preparación",
    "en-transito": "En tránsito",
    "en-reparto": "En reparto",
    entregado: "Entregado",
    incidencia: "Incidencia"
  };
  const statusClasses = {
    preparacion: "is-pending",
    "en-transito": "is-transit",
    "en-reparto": "is-pending",
    entregado: "is-delivered",
    incidencia: "is-incident"
  };

  const filteredShipments = shipments.filter((shipment) => [
    shipment.trackingCode,
    shipment.recipient,
    shipment.address
  ].some((value) => String(value || "").toLocaleLowerCase("es").includes(normalizedFilter)));

  const rows = filteredShipments.map((shipment) => {
    const row = document.createElement("tr");
    const values = [
      ["Guía", shipment.trackingCode || "Sin guía"],
      ["Destinatario", shipment.recipient || "Sin destinatario"],
      ["Ruta", `${shipment.origin || "Tapiales"} → ${shipment.address || "Destino pendiente"}`]
    ];

    values.forEach(([label, value]) => {
      const cell = document.createElement("td");
      cell.dataset.label = label;
      cell.textContent = value;
      row.append(cell);
    });

    const statusCell = document.createElement("td");
    statusCell.dataset.label = "Estado";
    const statusBadge = document.createElement("span");
    statusBadge.className = `table-status ${statusClasses[shipment.status] || "is-pending"}`;
    statusBadge.textContent = statusLabels[shipment.status] || "Estado desconocido";
    statusCell.append(statusBadge);
    row.append(statusCell);

    const etaCell = document.createElement("td");
    etaCell.dataset.label = "Entrega estimada";
    etaCell.textContent = shipment.estimatedDelivery || "Sin estimar";
    row.append(etaCell);

    const actionsCell = document.createElement("td");
    actionsCell.className = "table-actions";
    [
      ["track", "Rastrear", "track-shipment-button"],
      ["label", "Rótulo", "label-shipment-button"],
      ["edit", "Editar", "edit-shipment-button"],
      ["delete", "Eliminar", "delete-shipment-button"]
    ].forEach(([action, label, className]) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = className;
      button.dataset.action = action;
      button.dataset.id = shipment.id;
      button.dataset.guide = shipment.trackingCode || "";
      button.textContent = label;
      if (action === "delete") {
        button.classList.add("button-danger");
      }
      actionsCell.append(button);
    });
    row.append(actionsCell);
    return row;
  });

  tableBody.replaceChildren(...rows);
  const emptyMessage = document.getElementById("records-empty");
  if (emptyMessage) {
    emptyMessage.hidden = rows.length > 0;
  }
  return rows.length;
}

async function deleteShipment(id) {
  const shipment = shipments.find((item) => item.id === id);
  if (!shipment) {
    showToast("No se encontró el envío que deseas eliminar.", "error");
    return false;
  }

  if (typeof window.confirm === "function" && !window.confirm(`¿Eliminar la guía ${shipment.trackingCode}?`)) {
    return false;
  }

  try {
    await apiRequest(`/api/envios/${encodeURIComponent(id)}`, { method: "DELETE" });
    if (selectedSimulationShipment?.id === id) {
      stopSimulation();
      if (simulationLayer && map) {
        map.removeLayer(simulationLayer);
      }
      simulationLayer = null;
      simulationVehicleMarker = null;
      simulationRoutePath = [];
      selectedSimulationShipment = null;
    }
    if (pinValidationShipment?.id === id) {
      closePinModal();
    }
    await refreshShipmentsFromApi();
    showToast(`La guía ${shipment.trackingCode} fue eliminada.`, "success");
    return true;
  } catch (error) {
    showToast(error.message || "No se pudo eliminar el envío.", "error");
    return false;
  }
}

function prepareEdit(id) {
  const shipment = shipments.find((item) => item.id === id);
  if (!shipment) {
    showToast("No se encontró el envío para editar.", "error");
    return false;
  }

  document.getElementById("shipment-record-id").value = shipment.id;
  document.getElementById("form-guide").value = shipment.trackingCode || "";
  document.getElementById("form-recipient").value = shipment.recipient || "";
  document.getElementById("form-origin").value = shipment.origin || "Tapiales";
  document.getElementById("form-destination").value = shipment.address || "";
  document.getElementById("form-status").value = shipment.status || "preparacion";
  document.getElementById("form-eta").value = shipment.estimatedDelivery || "";
  document.getElementById("form-pin").value = shipment.pin || "";
  document.getElementById("form-mode-label").textContent = `Editando ${shipment.trackingCode}`;
  document.getElementById("shipment-submit").textContent = "Guardar cambios";
  document.getElementById("shipment-form-section")?.scrollIntoView({ behavior: "smooth", block: "start" });
  document.getElementById("form-guide").focus();
  return true;
}

function renderSimulationShipmentOptions() {
  const selector = document.getElementById("simulation-shipment");
  if (!selector) {
    return 0;
  }

  const selectedId = selectedSimulationShipment?.id || selector.value;
  selector.replaceChildren();
  shipments.forEach((shipment) => {
    const option = document.createElement("option");
    option.value = shipment.id;
    option.textContent = `${shipment.trackingCode || "Guía sin número"} · ${shipment.recipient || "Destinatario"}`;
    selector.append(option);
  });
  if (shipments.some((shipment) => shipment.id === selectedId)) {
    selector.value = selectedId;
  }
  return shipments.length;
}

function openLabelModal(shipmentId) {
  const shipment = shipments.find((item) => item.id === shipmentId);
  if (!shipment) {
    showToast("No se encontró el envío para generar el rótulo.", "error");
    return false;
  }

  const labelFields = {
    "dispatch-guide": shipment.trackingCode,
    "dispatch-origin": shipment.origin || "Tapiales",
    "dispatch-recipient": shipment.recipient,
    "dispatch-destination": shipment.address,
    "dispatch-service": shipment.packageType,
    "dispatch-pin": shipment.pin
  };
  Object.entries(labelFields).forEach(([id, value]) => {
    const element = document.getElementById(id);
    if (element) {
      element.textContent = value || "—";
    }
  });

  const qrImage = document.getElementById("label-qr");
  if (qrImage) {
    const qrPayload = [
      `Guía: ${shipment.trackingCode || "—"}`,
      `Destinatario: ${shipment.recipient || "—"}`,
      `Dirección: ${shipment.address || "—"}`,
      `PIN: ${shipment.pin || "—"}`
    ].join("\n");
    const query = new URLSearchParams({ size: "150x150", data: qrPayload });
    qrImage.alt = `Código QR del envío ${shipment.trackingCode || "sin guía"}`;
    qrImage.src = `https://api.qrserver.com/v1/create-qr-code/?${query.toString()}`;
    qrImage.onerror = () => {
      qrImage.removeAttribute("src");
      qrImage.alt = "No se pudo cargar el código QR";
    };
  }

  const dialog = document.getElementById("label-modal");
  if (typeof dialog?.showModal === "function" && !dialog.open) {
    dialog.showModal();
  }
  return Boolean(dialog);
}

function closeLabelModal() {
  const dialog = document.getElementById("label-modal");
  if (!dialog) {
    return false;
  }
  if (typeof dialog.close === "function" && dialog.open) {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
  return true;
}

function openDispatchLabel(shipment) {
  return openLabelModal(shipment?.id);
}

function setupShipmentManagement() {
  const form = document.getElementById("shipment-form");
  const tableBody = document.getElementById("shipments-table-body");
  const filterInput = document.getElementById("records-filter");

  filterInput?.addEventListener("input", () => renderShipmentsTable(filterInput.value));

  tableBody?.addEventListener("click", (event) => {
    const actionButton = event.target.closest("[data-action]");
    if (!actionButton) {
      return;
    }
    const shipment = shipments.find((candidate) => candidate.id === actionButton.dataset.id);
    if (!shipment) {
      return;
    }

    switch (actionButton.dataset.action) {
      case "track": {
        const trackingInput = document.getElementById("tracking-input");
        if (trackingInput) {
          trackingInput.value = shipment.trackingCode;
          document.getElementById("tracking-form")?.requestSubmit();
        }
        break;
      }
      case "label":
        openDispatchLabel(shipment);
        break;
      case "edit":
        prepareEdit(shipment.id);
        break;
      case "delete":
        deleteShipment(shipment.id);
        break;
    }
  });

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) {
      return;
    }

    const recordId = document.getElementById("shipment-record-id").value;
    const trackingCode = document.getElementById("form-guide").value.trim();
    const recipient = document.getElementById("form-recipient").value.trim();
    const origin = document.getElementById("form-origin").value.trim();
    const address = document.getElementById("form-destination").value.trim();
    const status = document.getElementById("form-status").value;
    const estimatedDelivery = document.getElementById("form-eta").value;
    const pin = document.getElementById("form-pin").value.trim();
    const submitButton = document.getElementById("shipment-submit");
    const duplicate = shipments.some((shipment) => shipment.trackingCode.toLowerCase() === trackingCode.toLowerCase() && shipment.id !== recordId);

    if (duplicate) {
      showToast("Ya existe un envío con ese número de guía.", "error");
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = "Geocodificando destino...";
    try {
      const coordinates = await geocodeAddress(address);
      const existingShipment = shipments.find((shipment) => shipment.id === recordId);
      const shipment = {
        ...(existingShipment || {}),
        id: recordId || (crypto.randomUUID ? crypto.randomUUID() : `shipment-${Date.now()}`),
        trackingCode,
        recipient,
        origin,
        address,
        status,
        packageType: existingShipment?.packageType || "Domestic Ground",
        pin,
        lat: coordinates.lat,
        lon: coordinates.lon,
        estimatedDelivery
      };
      const savedShipment = existingShipment
        ? await apiRequest(`/api/envios/${encodeURIComponent(recordId)}`, {
          method: "PUT",
          body: JSON.stringify(shipment)
        })
        : await apiRequest("/api/envios", {
          method: "POST",
          body: JSON.stringify(shipment)
        });
      await refreshShipmentsFromApi();
      if (selectedSimulationShipment?.id === savedShipment.id) {
        selectedSimulationShipment = savedShipment;
      }
      form.reset();
      document.getElementById("shipment-record-id").value = "";
      document.getElementById("form-mode-label").textContent = "Nuevo registro";
      submitButton.textContent = "Guardar envío";
      showToast(existingShipment ? `Se actualizó la guía ${trackingCode}.` : `Se creó la guía ${trackingCode}.`, "success");
    } catch (error) {
      showToast(error.message || "No se pudo guardar el envío.", "error");
    } finally {
      submitButton.disabled = false;
      if (!document.getElementById("shipment-record-id").value) {
        submitButton.textContent = "Guardar envío";
      } else {
        submitButton.textContent = "Guardar cambios";
      }
    }
  });

  form?.addEventListener("reset", () => {
    window.setTimeout(() => {
      document.getElementById("form-mode-label").textContent = "Nuevo registro";
      document.getElementById("shipment-submit").textContent = "Guardar envío";
    }, 0);
  });

  document.getElementById("tracking-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const trackingCode = document.getElementById("tracking-input").value.trim().toLowerCase();
    try {
      const shipment = await apiRequest(`/api/envios/${encodeURIComponent(document.getElementById("tracking-input").value.trim())}`);
      const shipmentIndex = shipments.findIndex((candidate) => candidate.id === shipment.id);
      if (shipmentIndex === -1) {
        shipments.push(shipment);
      } else {
        shipments[shipmentIndex] = shipment;
      }
      document.getElementById("manifest-guide").textContent = shipment.trackingCode;
      document.getElementById("shipment-origin").textContent = shipment.origin || "Tapiales";
      document.getElementById("shipment-destination").textContent = shipment.address;
      document.getElementById("shipment-status").textContent = shipment.status === "entregado" ? "Entregado" : shipment.status;
      document.getElementById("shipment-status").dataset.status = shipment.status;
      document.getElementById("shipment-pin").textContent = shipment.pin;
      if (map && Number.isFinite(Number(shipment.lat)) && Number.isFinite(Number(shipment.lon))) {
        map.setView([Number(shipment.lat), Number(shipment.lon)], 13);
      }
      refreshMapMarkers();
      showToast(`Mostrando el seguimiento de ${shipment.trackingCode}.`, "success");
    } catch (error) {
      showToast(error.message || "No se encontró la guía indicada.", "error");
    }
  });

  document.getElementById("print-dispatch-label")?.addEventListener("click", () => window.print());
  document.querySelectorAll("[data-close-modal='label-modal']").forEach((button) => {
    button.addEventListener("click", closeLabelModal);
  });
}

function openPinModal(shipment) {
  pinValidationShipment = shipment || selectedSimulationShipment;
  if (!pinValidationShipment) {
    showToast("No hay un envío seleccionado para validar.", "warning");
    return false;
  }

  const dialog = document.getElementById("pin-modal");
  const input = document.getElementById("pin-entry");
  const feedback = document.getElementById("pin-feedback");
  if (!dialog || !input) {
    return false;
  }

  input.value = "";
  input.classList.remove("animate-shake");
  input.removeAttribute("aria-invalid");
  if (feedback) {
    feedback.textContent = "";
    feedback.removeAttribute("data-state");
  }

  if (typeof dialog.showModal === "function") {
    if (!dialog.open) {
      dialog.showModal();
    }
  } else {
    dialog.setAttribute("open", "");
  }
  window.setTimeout(() => input.focus(), 0);
  return true;
}

function closePinModal() {
  const dialog = document.getElementById("pin-modal");
  if (!dialog) {
    pinValidationShipment = null;
    return false;
  }

  if (typeof dialog.close === "function" && dialog.open) {
    dialog.close();
  } else {
    dialog.removeAttribute("open");
  }
  pinValidationShipment = null;
  return true;
}

async function validateDeliveryPin() {
  const input = document.getElementById("pin-entry");
  const feedback = document.getElementById("pin-feedback");
  const enteredPin = input?.value.trim() || "";
  const shipment = pinValidationShipment || selectedSimulationShipment;

  if (!input || !shipment) {
    return false;
  }

  if (enteredPin !== String(shipment.pin)) {
    if (feedback) {
      feedback.textContent = "El PIN no coincide. Verifica los 4 dígitos e inténtalo nuevamente.";
      feedback.dataset.state = "error";
    }
    input.setAttribute("aria-invalid", "true");
    input.classList.remove("animate-shake");
    void input.offsetWidth;
    input.classList.add("animate-shake");
    input.addEventListener("animationend", () => input.classList.remove("animate-shake"), { once: true });
    return false;
  }

  try {
    const updatedShipment = await apiRequest(`/api/envios/${encodeURIComponent(shipment.id)}`, {
      method: "PUT",
      body: JSON.stringify({ status: "entregado" })
    });
    await refreshShipmentsFromApi();
    selectedSimulationShipment = updatedShipment;
    closePinModal();
    showToast(`Entrega confirmada para ${updatedShipment.trackingCode}.`, "success");
    return true;
  } catch (error) {
    if (feedback) {
      feedback.textContent = error.message || "No se pudo actualizar el estado de entrega.";
      feedback.dataset.state = "error";
    }
    return false;
  }
}

function setupMap() {
  const mapContainer = document.getElementById("map-container");
  if (!mapContainer || typeof L === "undefined") {
    return null;
  }

  if (!map) {
    map = L.map(mapContainer).setView([-34.6037, -58.3816], 12);
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      maxZoom: 19
    }).addTo(map);
    shipmentMarkersLayer = L.layerGroup().addTo(map);
  }

  refreshMapMarkers();
  return map;
}

function refreshMapMarkers() {
  if (!map || !shipmentMarkersLayer || typeof L === "undefined") {
    return 0;
  }

  const markerStatusClasses = {
    "en-transito": "is-transit",
    "en-reparto": "is-delivery",
    preparacion: "is-preparing",
    entregado: "is-delivered",
    incidencia: "is-incident"
  };

  shipmentMarkersLayer.clearLayers();

  return shipments.reduce((markerCount, shipment) => {
    const lat = Number(shipment.lat);
    const lon = Number(shipment.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return markerCount;
    }

    const statusClass = markerStatusClasses[shipment.status] || "is-default";
    const icon = L.divIcon({
      className: "shipment-marker-icon",
      html: `<span class="shipment-marker ${statusClass}" aria-hidden="true"></span>`,
      iconSize: [20, 20],
      iconAnchor: [10, 10],
      popupAnchor: [0, -10]
    });
    const marker = L.marker([lat, lon], {
      icon,
      title: shipment.trackingCode || "Envío"
    });

    const popup = document.createElement("div");
    popup.className = "shipment-popup";
    const guide = document.createElement("strong");
    guide.textContent = shipment.trackingCode || "Envío sin guía";
    const recipient = document.createElement("p");
    recipient.textContent = shipment.recipient || "Destinatario no especificado";
    const address = document.createElement("p");
    address.textContent = shipment.address || "Dirección no especificada";
    const status = document.createElement("span");
    status.textContent = shipment.status || "Estado desconocido";
    popup.append(guide, recipient, address, status);

    marker.bindPopup(popup).addTo(shipmentMarkersLayer);
    return markerCount + 1;
  }, 0);
}

async function fetchRoadRoute(start, end) {
  const toLatLon = (point) => {
    if (Array.isArray(point) && point.length >= 2) {
      return { lat: Number(point[0]), lon: Number(point[1]) };
    }

    if (point && typeof point === "object") {
      return { lat: Number(point.lat), lon: Number(point.lon) };
    }

    return null;
  };
  const startPoint = toLatLon(start);
  const endPoint = toLatLon(end);
  const isValidPoint = (point) => point
    && Number.isFinite(point.lat)
    && Number.isFinite(point.lon)
    && Math.abs(point.lat) <= 90
    && Math.abs(point.lon) <= 180;

  if (!isValidPoint(startPoint) || !isValidPoint(endPoint)) {
    throw new TypeError("El origen y el destino deben tener coordenadas válidas.");
  }

  const coordinates = `${startPoint.lon},${startPoint.lat};${endPoint.lon},${endPoint.lat}`;
  const url = `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson`;
  const response = await fetch(url, { headers: { Accept: "application/json" } });

  if (!response.ok) {
    throw new Error(`OSRM respondió con el estado ${response.status}.`);
  }

  const data = await response.json();
  const route = data.routes?.[0];
  if (data.code !== "Ok" || !route?.geometry?.coordinates?.length) {
    throw new Error("OSRM no encontró una ruta vial entre los puntos indicados.");
  }

  const path = route.geometry.coordinates.map(([lon, lat]) => [Number(lat), Number(lon)]);
  if (path.some(([lat, lon]) => !Number.isFinite(lat) || !Number.isFinite(lon))) {
    throw new Error("OSRM devolvió coordenadas de ruta inválidas.");
  }

  return {
    path,
    distanceKm: Number(route.distance) / 1000,
    durationMin: Number(route.duration) / 60
  };
}

async function selectShipmentForSimulation(item) {
  if (!item) {
    showToast("Selecciona un envío para simular su recorrido.", "warning");
    return null;
  }

  if (!map || typeof L === "undefined") {
    showToast("El mapa no está disponible para iniciar la simulación.", "error");
    return null;
  }

  pauseSimulation();
  simulationProgress = 0;
  updateSimulationProgress();
  if (simulationLayer) {
    map.removeLayer(simulationLayer);
  }

  let destination = { lat: Number(item.lat), lon: Number(item.lon) };
  if (!Number.isFinite(destination.lat) || !Number.isFinite(destination.lon)) {
    destination = await geocodeAddress(item.address || "");
  }

  try {
    const route = await fetchRoadRoute(SIMULATION_HUB, destination);
    selectedSimulationShipment = item;
    simulationRoutePath = route.path;
    simulationLayer = L.layerGroup().addTo(map);

    const hubMarker = L.marker([SIMULATION_HUB.lat, SIMULATION_HUB.lon], {
      icon: L.divIcon({
        className: "simulation-marker-icon",
        html: '<span class="simulation-marker simulation-marker--hub">HUB</span>',
        iconSize: [42, 28],
        iconAnchor: [21, 14]
      }),
      title: "Hub Logístico Central · Tapiales"
    }).bindTooltip("Hub Logístico Central · Tapiales");
    const destinationMarker = L.marker([destination.lat, destination.lon], {
      icon: L.divIcon({
        className: "simulation-marker-icon",
        html: '<span class="simulation-marker simulation-marker--destination">D</span>',
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      }),
      title: item.recipient || item.trackingCode || "Destino"
    }).bindTooltip(item.address || item.recipient || "Destino");
    const vehicleIcon = L.divIcon({
      className: "simulation-marker-icon",
      html: '<span class="simulation-marker simulation-marker--vehicle" role="img" aria-label="Vehículo">🚚</span>',
      iconSize: [40, 40],
      iconAnchor: [20, 20]
    });
    const routeLine = L.polyline(route.path, {
      color: "#4D148C",
      weight: 5,
      opacity: 0.85,
      lineCap: "round",
      lineJoin: "round"
    });

    simulationVehicleMarker = L.marker(route.path[0], {
      icon: vehicleIcon,
      title: "Vehículo en recorrido",
      zIndexOffset: 1000
    });
    simulationLayer.addLayer(routeLine);
    simulationLayer.addLayer(hubMarker);
    simulationLayer.addLayer(destinationMarker);
    simulationLayer.addLayer(simulationVehicleMarker);
    map.fitBounds(routeLine.getBounds(), { padding: [30, 30] });
    updateSimulationProgress();
    showToast(`Ruta lista para ${item.trackingCode || item.recipient || "el envío"}.`, "success");
    return route;
  } catch (error) {
    simulationRoutePath = [];
    simulationVehicleMarker = null;
    selectedSimulationShipment = null;
    console.error("No se pudo preparar la ruta de simulación.", error);
    showToast(error.message || "No se pudo calcular la ruta del envío.", "error");
    return null;
  }
}

function updateSimulationProgress() {
  const percent = Math.round(simulationProgress * 100);
  const progressBar = document.getElementById("simulation-progress-bar");
  const progressTrack = document.getElementById("simulation-progress");
  const progressValue = document.getElementById("simulation-progress-value");

  if (progressBar) {
    progressBar.style.width = `${percent}%`;
  }
  if (progressTrack) {
    progressTrack.setAttribute("aria-valuenow", String(percent));
  }
  if (progressValue) {
    progressValue.textContent = `${percent}%`;
  }
  renderTimeline(percent);

  if (simulationVehicleMarker && simulationRoutePath.length > 0) {
    const lastIndex = simulationRoutePath.length - 1;
    const routePosition = simulationProgress * lastIndex;
    const startIndex = Math.floor(routePosition);
    const endIndex = Math.min(startIndex + 1, lastIndex);
    const segmentProgress = routePosition - startIndex;
    const startPoint = simulationRoutePath[startIndex];
    const endPoint = simulationRoutePath[endIndex];
    const position = [
      startPoint[0] + (endPoint[0] - startPoint[0]) * segmentProgress,
      startPoint[1] + (endPoint[1] - startPoint[1]) * segmentProgress
    ];
    simulationVehicleMarker.setLatLng(position);
  }
}

function renderTimeline(percentage) {
  const timelineContainer = document.getElementById("timeline-container");
  if (!timelineContainer) {
    return 0;
  }

  const timeline = timelineContainer.querySelector("#shipment-timeline") || timelineContainer;
  const numericPercentage = Number(percentage);
  const progress = Number.isFinite(numericPercentage)
    ? Math.min(100, Math.max(0, numericPercentage))
    : 0;
  const milestones = [
    { title: "Ingreso en Planta Central", threshold: 0 },
    { title: "En Tránsito Troncal", threshold: 25 },
    { title: "Última Milla en Curso", threshold: 60 },
    { title: "Entrega Finalizada", threshold: 90 }
  ];
  const activeIndex = progress >= 100
    ? milestones.length
    : milestones.reduce((currentIndex, milestone, index) => progress >= milestone.threshold ? index : currentIndex, 0);

  const items = milestones.map((milestone, index) => {
    const isComplete = progress >= 100 || index < activeIndex;
    const isCurrent = progress < 100 && index === activeIndex;
    const state = isComplete ? "is-complete" : isCurrent ? "is-current" : "";
    const statusText = isComplete ? "Completado" : isCurrent ? "En curso" : "Pendiente";
    const item = document.createElement("li");
    item.className = `timeline-item ${state}`.trim();

    if (isCurrent) {
      item.setAttribute("aria-current", "step");
    }

    const marker = document.createElement("span");
    marker.className = "timeline-marker";
    marker.setAttribute("aria-hidden", "true");
    marker.textContent = isComplete ? "✓" : isCurrent ? "●" : "○";

    const content = document.createElement("div");
    const heading = document.createElement("h3");
    heading.textContent = milestone.title;
    const status = document.createElement("span");
    status.className = "timeline-pending timeline-stage-status";
    status.textContent = statusText;
    content.append(heading, status);
    item.append(marker, content);
    return item;
  });

  timeline.replaceChildren(...items);
  return items.length;
}

function syncSimulationControls() {
  const toggle = document.getElementById("simulation-toggle");
  if (toggle) {
    const running = simulationInterval !== null;
    toggle.textContent = running ? "Pausar simulación" : simulationProgress > 0 ? "Reanudar simulación" : "Iniciar simulación";
    toggle.setAttribute("aria-pressed", String(running));
    toggle.setAttribute("aria-checked", String(running));
  }

  document.querySelectorAll("[data-simulation-speed]").forEach((button) => {
    const active = Number(button.dataset.simulationSpeed) === simulationSpeed;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

async function startSimulation() {
  if (simulationInterval !== null) {
    return true;
  }

  if (simulationRoutePath.length === 0) {
    const selector = document.getElementById("simulation-shipment");
    const shipment = shipments.find((candidate) => candidate.id === selector?.value) || shipments[0];
    const route = await selectShipmentForSimulation(shipment);
    if (!route) {
      return false;
    }
  }

  if (simulationProgress >= 1) {
    simulationProgress = 0;
    updateSimulationProgress();
  }

  simulationInterval = window.setInterval(() => {
    simulationProgress = Math.min(1, simulationProgress + (SIMULATION_TICK_MS * simulationSpeed) / SIMULATION_BASE_DURATION_MS);
    updateSimulationProgress();

    if (simulationProgress >= 1) {
      pauseSimulation();
      openPinModal(selectedSimulationShipment);
    }
  }, SIMULATION_TICK_MS);
  syncSimulationControls();
  return true;
}

function pauseSimulation() {
  if (simulationInterval !== null) {
    window.clearInterval(simulationInterval);
    simulationInterval = null;
  }
  syncSimulationControls();
}

function stopSimulation() {
  pauseSimulation();
  simulationProgress = 0;
  updateSimulationProgress();
  if (simulationRoutePath.length > 0 && simulationVehicleMarker) {
    simulationVehicleMarker.setLatLng(simulationRoutePath[0]);
  }
  syncSimulationControls();
}

function toggleSimulation() {
  if (simulationInterval !== null) {
    pauseSimulation();
    return false;
  }
  return startSimulation();
}

function setupSimulationControls() {
  const shipmentSelector = document.getElementById("simulation-shipment");
  if (shipmentSelector) {
    shipmentSelector.replaceChildren();
    shipments.forEach((shipment) => {
      const option = document.createElement("option");
      option.value = shipment.id;
      option.textContent = `${shipment.trackingCode || "Guía sin número"} · ${shipment.recipient || "Destinatario"}`;
      shipmentSelector.append(option);
    });
    shipmentSelector.addEventListener("change", () => {
      const shipment = shipments.find((candidate) => candidate.id === shipmentSelector.value);
      selectShipmentForSimulation(shipment);
    });
  }

  document.querySelectorAll("[data-simulation-speed]").forEach((button) => {
    button.addEventListener("click", () => {
      simulationSpeed = Number(button.dataset.simulationSpeed);
      syncSimulationControls();
    });
  });

  document.getElementById("simulation-toggle")?.addEventListener("click", toggleSimulation);
  document.getElementById("simulation-reset")?.addEventListener("click", stopSimulation);
  renderTimeline(Math.round(simulationProgress * 100));
  syncSimulationControls();
}

function setupDeliveryPinControls() {
  const currentGuide = document.getElementById("manifest-guide")?.textContent.trim();
  const currentShipment = shipments.find((shipment) => shipment.trackingCode === currentGuide) || shipments[0];

  document.getElementById("validate-pin-button")?.addEventListener("click", () => {
    openPinModal(currentShipment);
  });

  document.getElementById("pin-validation-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    validateDeliveryPin();
  });

  document.querySelectorAll("[data-close-modal='pin-modal']").forEach((button) => {
    button.addEventListener("click", closePinModal);
  });

  document.getElementById("pin-modal")?.addEventListener("close", () => {
    pinValidationShipment = null;
  });
}

function setupQuoteCalculator() {
  const form = document.getElementById("quote-form");
  if (!form) {
    return;
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const destinationInput = document.getElementById("quote-destination");
    const weightInput = document.getElementById("quote-weight");
    const serviceInput = document.getElementById("quote-service");
    const calculateButton = document.getElementById("btn-calculate-quote");
    const resultCard = document.getElementById("quote-result-card");
    const resultMessage = document.getElementById("quote-result");
    const destinationCity = destinationInput?.value.trim();
    const weightKg = Number(weightInput?.value);

    if (!destinationCity || !Number.isFinite(weightKg) || weightKg <= 0) {
      form.reportValidity();
      return;
    }

    const serviceLevels = {
      "mismo-dia": "FedEx Priority",
      express: "Express Saver",
      estandar: "Domestic Ground"
    };
    const serviceLevel = serviceLevels[serviceInput?.value] || "Domestic Ground";
    const originalButtonText = calculateButton?.textContent || "Calcular tarifa";
    if (calculateButton) {
      calculateButton.disabled = true;
      calculateButton.textContent = "Calculando...";
    }
    if (resultCard) {
      resultCard.hidden = false;
      resultCard.setAttribute("aria-busy", "true");
    }
    if (resultMessage) {
      resultMessage.textContent = "Buscando ruta por carretera...";
    }

    try {
      const destination = await geocodeAddress(destinationCity);
      const route = await fetchRoadRoute(SIMULATION_HUB, destination);
      const baseCost = 3500;
      const distanceCost = route.distanceKm * 120;
      const weightCost = weightKg * 400;
      const totalCost = baseCost + distanceCost + weightCost;
      const currency = new Intl.NumberFormat("es-AR", { style: "currency", currency: "ARS" });

      document.getElementById("quote-service-level").textContent = serviceLevel;
      document.getElementById("quote-total").textContent = currency.format(totalCost);
      document.getElementById("quote-distance").textContent = `${route.distanceKm.toFixed(1)} km`;
      document.getElementById("quote-base-cost").textContent = currency.format(baseCost);
      document.getElementById("quote-distance-cost").textContent = currency.format(distanceCost);
      document.getElementById("quote-weight-cost").textContent = currency.format(weightCost);
      if (resultMessage) {
        resultMessage.textContent = `Cotización estimada para ${destinationCity}.`;
        resultMessage.dataset.state = "success";
      }
    } catch (error) {
      if (resultMessage) {
        resultMessage.textContent = error.message || "No se pudo calcular la cotización.";
        resultMessage.dataset.state = "error";
      }
    } finally {
      if (calculateButton) {
        calculateButton.disabled = false;
        calculateButton.textContent = originalButtonText;
      }
      resultCard?.removeAttribute("aria-busy");
    }
  });
}

async function geocodeAddress(queryAddress) {
  const fallbackCoordinates = () => ({
    lat: Number((-34.9 + Math.random() * 0.6).toFixed(6)),
    lon: Number((-58.8 + Math.random() * 0.7).toFixed(6))
  });

  if (typeof queryAddress !== "string" || !queryAddress.trim()) {
    return fallbackCoordinates();
  }

  try {
    const query = new URLSearchParams({
      format: "json",
      q: queryAddress.trim()
    });
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${query.toString()}`, {
      headers: { Accept: "application/json" }
    });

    if (!response.ok) {
      throw new Error(`Nominatim respondió con el estado ${response.status}.`);
    }

    const results = await response.json();
    if (!Array.isArray(results) || results.length === 0) {
      return fallbackCoordinates();
    }

    const lat = Number.parseFloat(results[0].lat);
    const lon = Number.parseFloat(results[0].lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return fallbackCoordinates();
    }

    return { lat, lon };
  } catch (error) {
    console.warn("No se pudo geocodificar la dirección; se usarán coordenadas aproximadas.", error);
    return fallbackCoordinates();
  }
}

function switchRole(role) {
  const normalizedRole = String(role).toLowerCase();
  const activeRole = ["client", "cliente"].includes(normalizedRole)
    ? "client"
    : ["operator", "operador"].includes(normalizedRole)
      ? "operator"
      : null;

  if (!activeRole) {
    console.warn(`Rol no reconocido: ${role}`);
    return false;
  }

  const roleElements = {
    client: {
      panel: document.getElementById("view-client") || document.getElementById("vista-cliente"),
      button: document.getElementById("tab-client") || document.getElementById("tab-cliente")
    },
    operator: {
      panel: document.getElementById("view-operator") || document.getElementById("vista-operador"),
      button: document.getElementById("tab-operator") || document.getElementById("tab-operador")
    }
  };

  Object.entries(roleElements).forEach(([currentRole, elements]) => {
    if (elements.panel) {
      elements.panel.hidden = currentRole !== activeRole;
    }

    if (elements.button) {
      const isActive = currentRole === activeRole;
      elements.button.classList.toggle("nav-btn-active", isActive);
      elements.button.classList.toggle("nav-btn-inactive", !isActive);
      elements.button.classList.toggle("is-active", isActive);
      elements.button.setAttribute("aria-selected", String(isActive));
      elements.button.tabIndex = isActive ? 0 : -1;
    }
  });

  window.setTimeout(() => {
    const leafletMap = window.map || (typeof map !== "undefined" ? map : null);
    if (leafletMap && typeof leafletMap.invalidateSize === "function") {
      leafletMap.invalidateSize();
    }
  }, 150);

  return true;
}

document.querySelectorAll(".nav-btn, .view-tab").forEach((button) => {
  button.addEventListener("click", () => {
    const role = button.dataset.role || button.dataset.view || button.getAttribute("aria-controls");
    switchRole(role);
  });
});

async function initializeApp() {
  try {
    shipments = await loadShipmentsFromApi();
  } catch (error) {
    shipments = [];
    showToast(`No se pudo conectar con el servidor: ${error.message}`, "error");
  }

  setupMap();
  setupSimulationControls();
  setupDeliveryPinControls();
  setupQuoteCalculator();
  setupShipmentManagement();
  renderShipmentsTable();
}

initializeApp();