import { configureOAuth } from "./auth/configureOAuth";

// ArcGIS Maps Components 5.0 imports
import "@arcgis/map-components/components/arcgis-scene";
import "@arcgis/map-components/components/arcgis-search";

// SDK Core imports
import esriId from "@arcgis/core/identity/IdentityManager.js";
import Graphic from "@arcgis/core/Graphic.js";
import GraphicsLayer from "@arcgis/core/layers/GraphicsLayer.js";
import FeatureLayer from "@arcgis/core/layers/FeatureLayer.js";
import Mesh from "@arcgis/core/geometry/Mesh.js";
import Point from "@arcgis/core/geometry/Point.js";
import Polygon from "@arcgis/core/geometry/Polygon.js";
import WebScene from "@arcgis/core/WebScene.js";
import Portal from "@arcgis/core/portal/Portal.js";
import Basemap from "@arcgis/core/Basemap.js";
import "@arcgis/map-components/components/arcgis-sketch";
import * as geodeticAreaOperator from "@arcgis/core/geometry/operators/geodeticAreaOperator.js";
import * as centroidOperator from "@arcgis/core/geometry/operators/centroidOperator.js";
import * as webMercatorUtils from "@arcgis/core/geometry/support/webMercatorUtils.js";

// Custom RPK configuration mapping
import { RPK_CONFIG } from "./RpkConfig";
import type { RpkAttributeDefinition } from "./RpkConfig";

// ---------------------------------------------------------------------------
// Configuration Constants (Manually set by developer/user)
// ---------------------------------------------------------------------------
const WEBSCENE_ID = "832369e9af49433d91bdf0807ad12341"; // User sets this. Default fallback below.
const APP_CLIENT_ID = "2JSOKuomAscBzB4"; // User sets this.
const API_BASE_DEFAULT = "https://imrao-space-inuse.hf.space";
const urlParams = new URLSearchParams(window.location.search);
const API_BASE = urlParams.get("api") || API_BASE_DEFAULT; // Python FastAPI server port

// Auto-correct client ID typo if it matches the 15-character template ID
let activeClientId = APP_CLIENT_ID;
if (activeClientId === "2JSOKuomAscBzB4") {
  activeClientId = "2JSOKuomAscBzB4e";
}

// ---------------------------------------------------------------------------
// OAuth Authentication Setup
// ---------------------------------------------------------------------------
configureOAuth({
  portalUrl: "https://www.arcgis.com",
  appId: activeClientId,
  popup: false, // Redirect flow in the same browser tab
});

const loginOverlay = document.getElementById("login-overlay") as HTMLDivElement;
const btnLogin = document.getElementById("btn-login") as HTMLButtonElement | null;
const appContainer = document.getElementById("app-container") as HTMLDivElement;

async function checkAuth() {
  try {
    const credential = await esriId.checkSignInStatus("https://www.arcgis.com/sharing");
    if (credential) {
      onLoginSuccess();
    }
  } catch (error) {
    triggerLogin();
  }
}

async function triggerLogin() {
  try {
    const credential = await esriId.getCredential("https://www.arcgis.com/sharing");
    if (credential) {
      onLoginSuccess();
    }
  } catch (error) {
    console.error("Login failed:", error);
  }
}

function onLoginSuccess() {
  const loadingText = document.querySelector(".login-overlay .loading-text");
  if (loadingText) {
    loadingText.textContent = "Loading 3D WebScene & Assets...";
  }
  appContainer.classList.remove("hidden");
  initApp();
}

// ---------------------------------------------------------------------------
// Global Application State Variables
// ---------------------------------------------------------------------------
const sceneElement = document.getElementById("scene-view") as any;
let view: any = null;
let parcelLayer: GraphicsLayer;
let modelsLayer: GraphicsLayer;
let sketchComponent: any;

let activeGraphic: Graphic | null = null;
let selectedRpkName = "";
let rpkAttributes: any[] = [];
let currentParamValues: Record<string, any> = {};

interface PlacedModel {
  id: string;
  parcelId?: string;
  rpkName: string;
  glbUrl: string;
  centroid: Point;
  graphic: Graphic;
  baseMesh: Mesh;
  reports: Record<string, any>;
  parameters: Record<string, any>;
  transform: {
    heading: number;
    pitch: number;
    roll: number;
    scale: number;
    offsetX: number;
    offsetY: number;
    offsetZ: number;
  };
}

let placedModels: PlacedModel[] = [];
let selectedModelId: string | null = null;

// ---------------------------------------------------------------------------
// Application Initializer
// ---------------------------------------------------------------------------
async function initApp() {
  // Load scene programmatically with robust fallback handling
  let webScene = new WebScene({
    portalItem: {
      id: WEBSCENE_ID
    }
  });

  try {
    await webScene.load();
  } catch (error) {
    console.warn(`[ArcGIS Scene] WebScene ${WEBSCENE_ID} failed to load. Falling back to default scene. Error:`, error);
    webScene = new WebScene({
      portalItem: {
        id: "c656360df94943f789ad69a531bfa2eb"
      }
    });
    try {
      await webScene.load();
    } catch (fallbackError) {
      console.error("[ArcGIS Scene] Fallback WebScene also failed to load:", fallbackError);
    }
  }

  sceneElement.map = webScene;

  // Wait for scene readiness
  await sceneElement.viewOnReady();
  view = sceneElement.view;

  // Load geometry operators
  if (!geodeticAreaOperator.isLoaded()) {
    await geodeticAreaOperator.load();
  }

  // Initialize Graphic Layers
  parcelLayer = new GraphicsLayer({
    title: "Drawn Parcels",
    elevationInfo: {
      mode: "on-the-ground"
    }
  });
  modelsLayer = new GraphicsLayer({ title: "Procedural 3D Models" });
  view.map.addMany([parcelLayer, modelsLayer]);

  // Bind Location Search View
  const searchWidget = document.getElementById("location-search") as any;
  if (searchWidget) searchWidget.view = view;

  // Initialize features
  initBasemapGallery();
  initSketch();
  initWizard();
  initLayersManager();
  loadRpksList();

  // Sign out listener
  document.getElementById("btn-signout")?.addEventListener("click", () => {
    esriId.destroyCredentials();
    window.location.reload();
  });

  // Hide the loading gate overlay now that the view and all maps are fully loaded & ready
  loginOverlay.classList.add("hidden");
}

// ---------------------------------------------------------------------------
// Basemap Gallery Setup
// ---------------------------------------------------------------------------
async function initBasemapGallery() {
  const selectBasemap = document.getElementById("select-basemap") as HTMLSelectElement | null;
  if (!selectBasemap) return;

  try {
    const portal = Portal.getDefault();
    // Load the portal to populate metadata queries like basemapGalleryGroupQuery3D and g3DTilesGalleryGroupQuery
    await portal.load();

    const fetchPromises: Promise<Basemap[]>[] = [];

    // 1. Fetch 3D basemaps from the portal if configured
    if (portal.basemapGalleryGroupQuery3D) {
      fetchPromises.push(
        portal.fetchBasemaps(portal.basemapGalleryGroupQuery3D)
          .catch((e) => {
            console.warn("[Basemap] Failed to fetch portal 3D basemaps:", e);
            return [];
          })
      );
    }

    // 2. Fetch Google 3D Tiles basemaps if configured
    if (portal.g3DTilesGalleryGroupQuery) {
      fetchPromises.push(
        portal.fetchBasemaps(portal.g3DTilesGalleryGroupQuery)
          .catch((e) => {
            console.warn("[Basemap] Failed to fetch Google 3D Tiles basemaps:", e);
            return [];
          })
      );
    }

    // 3. Fetch standard portal basemaps (typically 2D)
    fetchPromises.push(
      portal.fetchBasemaps()
        .catch((e) => {
          console.warn("[Basemap] Failed to fetch standard portal basemaps:", e);
          return [];
        })
    );

    // Run all fetches in parallel
    const fetchedGroups = await Promise.all(fetchPromises);
    const portalBasemaps: Basemap[] = [];
    for (const group of fetchedGroups) {
      portalBasemaps.push(...group);
    }

    // 4. Fetch the default 3D basemap specifically
    try {
      const default3DBm = await portal.fetchDefault3DBasemap();
      if (default3DBm) {
        portalBasemaps.push(default3DBm);
      }
    } catch (e) {
      console.warn("[Basemap] Failed to fetch default 3D basemap:", e);
    }

    // Load each portal basemap in parallel so that properties like title are fully populated
    await Promise.all(
      portalBasemaps.map((bm) =>
        bm.load().catch((e) => console.warn(`[Basemap] Failed to load basemap ${bm.id || bm.portalItem?.id || ""}:`, e))
      )
    );

    // List of standard 3D basemaps to explicitly prepend
    const threeDBasemapsList = [
      { id: "topo-3d", title: "Topographic 3D" },
      { id: "navigation-3d", title: "Navigation 3D" },
      { id: "navigation-dark-3d", title: "Navigation Dark 3D" },
      { id: "osm-3d", title: "OpenStreetMap 3D" },
      { id: "gray-3d", title: "Light Gray Canvas 3D" },
      { id: "dark-gray-3d", title: "Dark Gray Canvas 3D" },
      { id: "streets-3d", title: "Streets 3D" }
    ];

    const loaded3DBasemaps = threeDBasemapsList
      .map(item => {
        try {
          const bm = Basemap.fromId(item.id);
          if (bm) {
            bm.title = item.title;
          }
          return bm;
        } catch (e) {
          console.warn(`[Basemap] Failed to instantiate standard 3D basemap ${item.id}:`, e);
          return null;
        }
      })
      .filter((bm): bm is Basemap => bm !== null);

    // Merge and deduplicate basemaps
    const allBasemaps: Basemap[] = [];
    const seenKeys = new Set<string>();

    const addUniqueBasemap = (bm: Basemap) => {
      const id = bm.id || "";
      const portalItemId = bm.portalItem?.id || "";
      const key = (id || portalItemId || bm.title || "").toLowerCase().trim();
      
      if (key && !seenKeys.has(key)) {
        seenKeys.add(key);
        // Ensure a default title exists
        if (!bm.title) {
          bm.title = bm.id || bm.portalItem?.id || "Unnamed Basemap";
        }
        allBasemaps.push(bm);
      }
    };

    // Prepend standard 3D basemaps
    loaded3DBasemaps.forEach(addUniqueBasemap);

    // Append fetched portal basemaps
    portalBasemaps.forEach(addUniqueBasemap);

    // Clear dropdown and rebuild options
    selectBasemap.innerHTML = "";
    allBasemaps.forEach((bm) => {
      const option = document.createElement("option");
      option.value = (bm.id || (bm.portalItem ? bm.portalItem.id : "")) || "";
      option.innerText = bm.title || "";
      selectBasemap.appendChild(option);
    });

    // Match current active basemap
    if (view && view.map && view.map.basemap) {
      const activeBm = view.map.basemap;
      const activeBmId = activeBm.id || (activeBm.portalItem ? activeBm.portalItem.id : "");
      if (activeBmId) {
        for (let i = 0; i < selectBasemap.options.length; i++) {
          if (selectBasemap.options[i].value === activeBmId) {
            selectBasemap.value = activeBmId;
            break;
          }
        }
      }
    }

    selectBasemap.addEventListener("change", (e: any) => {
      const selectedId = e.target.value;
      const selectedBm = allBasemaps.find(bm => {
        const key = (bm.id || (bm.portalItem ? bm.portalItem.id : "")) || "";
        return key === selectedId;
      });
      if (selectedBm && view && view.map) {
        view.map.basemap = selectedBm;
      }
    });
  } catch (error) {
    console.error("Failed to load portal default basemaps, keeping static options:", error);
    selectBasemap.addEventListener("change", (e: any) => {
      if (view && view.map) {
        view.map.basemap = e.target.value;
      }
    });
  }
}

function showSketchComponent() {
  if (sketchComponent) {
    sketchComponent.classList.remove("collapsed");
  }
}

function hideSketchComponent() {
  if (sketchComponent) {
    sketchComponent.classList.add("collapsed");
  }
}

function initSketch() {
  sketchComponent = document.getElementById("map-sketch") as any;
  if (!sketchComponent) return;

  // Link sketch to the current parcel layer
  sketchComponent.layer = parcelLayer;

  sketchComponent.polygonSymbol = {
    type: "simple-fill",
    color: "rgba(0, 102, 255, 0.15)",
    outline: {
      color: "#0066ff",
      width: 2
    }
  };

  sketchComponent.activeFillSymbol = {
    type: "simple-fill",
    color: "rgba(0, 102, 255, 0.25)",
    outline: {
      color: "#0066ff",
      width: 2,
      style: "dash"
    }
  };

  sketchComponent.updateOnGraphicClick = false;
  sketchComponent.defaultCreateOptions = {
    mode: "click"
  };

  sketchComponent.addEventListener("arcgisCreate", async (event: any) => {
    const detail = event.detail;
    if (detail.state === "complete") {
      const newGraphic = detail.graphic;
      const parcelId = "parcel_" + Date.now();
      let parcelNum = parcelLayer.graphics.length;
      if (!parcelLayer.graphics.includes(newGraphic)) {
        parcelNum += 1;
      }
      newGraphic.attributes = {
        id: parcelId,
        name: "Parcel " + parcelNum
      };
      activeGraphic = newGraphic;
      styleParcels();
      updateParcelsListUI();
      await updateFootprintStatus("drawn", activeGraphic!);
    }
  });
}

function styleParcels() {
  parcelLayer.graphics.forEach((graphic) => {
    const isSelected = activeGraphic && (graphic.attributes?.id === activeGraphic.attributes?.id);
    graphic.symbol = {
      type: "simple-fill",
      color: isSelected ? "rgba(0, 102, 255, 0.3)" : "rgba(0, 102, 255, 0.1)",
      outline: {
        color: isSelected ? "#0052cc" : "#0066ff",
        width: isSelected ? 3.5 : 1.5,
        style: "solid"
      }
    } as any;
  });
}

function updateParcelsListUI() {
  const container = document.getElementById("parcels-list-container") as HTMLDivElement;
  if (!container) return;
  container.innerHTML = "";

  if (parcelLayer.graphics.length === 0) {
    container.innerHTML = '<div class="empty-state-small">No parcels drawn.</div>';
    return;
  }

  parcelLayer.graphics.forEach(graphic => {
    const id = graphic.attributes?.id;
    const name = graphic.attributes?.name || "Unnamed Parcel";

    const item = document.createElement("div");
    item.className = "manager-item";
    if (activeGraphic && activeGraphic.attributes?.id === id) {
      item.classList.add("active");
    }

    item.addEventListener("click", (e: any) => {
      if (e.target.closest("button") || e.target.closest("svg")) return;

      activeGraphic = graphic;
      styleParcels();
      updateParcelsListUI();

      updateFootprintStatus("drawn", activeGraphic);

      const assocModel = placedModels.find(m => m.parcelId === id);
      if (assocModel) {
        selectModel(assocModel.id);
      } else {
        selectedModelId = null;
        updateModelsListUI();
        document.getElementById("insights-content")?.classList.add("hidden");
        document.querySelector("#insights-panel .empty-state")?.classList.remove("hidden");
        document.getElementById("insight-active-dot")?.classList.add("hidden");
      }
    });

    const label = document.createElement("div");
    label.className = "manager-item-label";
    label.innerText = name;

    const actions = document.createElement("div");
    actions.className = "manager-item-actions";

    const btnVis = document.createElement("button");
    btnVis.className = `btn-icon ${graphic.visible ? "active" : ""}`;
    btnVis.title = "Toggle Visibility";
    btnVis.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
        ${graphic.visible
        ? '<path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>'
        : '<path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.82l2.92 2.92c1.51-1.26 2.7-2.89 3.44-4.74-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.34-4.3l1.83 1.83C13.2 7.12 12.62 7 12 7c-2.76 0-5 2.24-5 5 0 .62.12 1.2.33 1.7l1.83 1.83c-.1-.28-.16-.58-.16-.9 0-1.66 1.34-3 3-3 .32 0 .62.06.9.16z"/>'}
      </svg>
    `;
    btnVis.addEventListener("click", (e) => {
      e.stopPropagation();
      graphic.visible = !graphic.visible;
      updateParcelsListUI();
    });

    const btnDel = document.createElement("button");
    btnDel.className = "btn-icon danger";
    btnDel.title = "Delete Parcel";
    btnDel.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
        <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
      </svg>
    `;
    btnDel.addEventListener("click", (e) => {
      e.stopPropagation();

      parcelLayer.remove(graphic);

      const associatedModels = placedModels.filter(m => m.parcelId === id);
      associatedModels.forEach(m => {
        modelsLayer.remove(m.graphic);
      });
      placedModels = placedModels.filter(m => m.parcelId !== id);

      if (activeGraphic && activeGraphic.attributes?.id === id) {
        activeGraphic = null;
        const statusBox = document.getElementById("footprint-status-box") as HTMLDivElement;
        statusBox.className = "selection-status-box empty";
        statusBox.innerHTML = `
          <div class="status-icon-container">
            <svg class="status-icon" viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
            </svg>
          </div>
          <div class="status-text">No footprint selected or drawn yet.</div>
        `;
        (document.getElementById("btn-goto-step-2") as HTMLButtonElement).disabled = true;
      }

      styleParcels();
      updateParcelsListUI();
      updateModelsListUI();
    });

    actions.appendChild(btnVis);
    actions.appendChild(btnDel);
    item.appendChild(label);
    item.appendChild(actions);
    container.appendChild(item);
  });
}


let selectionHandler: any = null;

function getSelectedLayer(): any {
  const selectBt = document.getElementById("select-bt-layer") as HTMLSelectElement;
  const val = selectBt.value;
  if (val === "drawn") {
    return parcelLayer;
  }
  return view.map.findLayerById(val);
}

function enableSelectionMode() {
  if (sketchComponent) sketchComponent.cancel();
  hideSketchComponent();
  document.getElementById("btn-draw-mode")?.classList.remove("active");
  document.getElementById("btn-select-mode")?.classList.add("active");

  if (selectionHandler) selectionHandler.remove();

  selectionHandler = view.on("click", async (event: any) => {
    const targetLayer = getSelectedLayer();
    if (!targetLayer) return;

    let selectedGraphic: Graphic | null = null;
    const response = await view.hitTest(event);
    const results = response.results.filter(
      (r: any) => r.type === "graphic" && r.graphic && r.graphic.layer === targetLayer
    );

    if (results.length > 0) {
      selectedGraphic = results[0].graphic;
    } else if (targetLayer && typeof targetLayer.queryFeatures === "function") {
      try {
        const query = targetLayer.createQuery();
        query.geometry = event.mapPoint;
        query.spatialRelationship = "intersects";
        query.returnGeometry = true;
        query.outFields = ["*"];
        const queryResult = await targetLayer.queryFeatures(query);
        if (queryResult.features && queryResult.features.length > 0) {
          const feat = queryResult.features[0];
          feat.layer = targetLayer;
          selectedGraphic = feat;
        }
      } catch (error) {
        console.error("Failed querying features from layer:", error);
      }
    }

    if (selectedGraphic) {
      if (selectedGraphic.geometry && selectedGraphic.geometry.type === "polygon") {
        activeGraphic = selectedGraphic;
        const source = (targetLayer === parcelLayer) ? "drawn" : "selected";
        await updateFootprintStatus(source, activeGraphic!);
        styleParcels();
        updateParcelsListUI();

        // Select associated 3D model if it exists
        const assocModel = placedModels.find(m => m.parcelId === activeGraphic!.attributes?.id);
        if (assocModel) {
          selectModel(assocModel.id);
        } else {
          selectedModelId = null;
          updateModelsListUI();
          document.getElementById("insights-content")?.classList.add("hidden");
          document.querySelector("#insights-panel .empty-state")?.classList.remove("hidden");
          document.getElementById("insight-active-dot")?.classList.add("hidden");
        }
      }
    }
  });
}

function disableSelectionMode() {
  document.getElementById("btn-select-mode")?.classList.remove("active");
  if (selectionHandler) {
    selectionHandler.remove();
    selectionHandler = null;
  }
}

async function updateFootprintStatus(source: string, graphic: Graphic) {
  const statusBox = document.getElementById("footprint-status-box") as HTMLDivElement;
  const gotoStep2Btn = document.getElementById("btn-goto-step-2") as HTMLButtonElement;

  const poly = graphic.geometry as Polygon;
  if (!poly) return;

  const centroid = centroidOperator.execute(poly);
  if (!centroid) return;

  if (!geodeticAreaOperator.isLoaded()) {
    await geodeticAreaOperator.load();
  }
  const area = Math.round(geodeticAreaOperator.execute(poly, { unit: "square-meters" }));
  const lonStr = centroid.longitude !== undefined && centroid.longitude !== null ? centroid.longitude.toFixed(5) : centroid.x.toFixed(1);
  const latStr = centroid.latitude !== undefined && centroid.latitude !== null ? centroid.latitude.toFixed(5) : centroid.y.toFixed(1);

  statusBox.className = "selection-status-box active";
  statusBox.innerHTML = `
    <div class="status-icon-container">
      <svg class="status-icon" viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
        <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
      </svg>
    </div>
    <div class="status-text">
      <strong>Footprint Identified</strong><br/>
      Source: ${source === "drawn" ? "Drawn Local" : "Selected Layer"}<br/>
      Area: ${area.toLocaleString()} sqm<br/>
      Centroid: ${lonStr}, ${latStr}
    </div>
  `;

  gotoStep2Btn.disabled = false;

  if (source === "selected") {
    const centroidKey = `${centroid.x.toFixed(3)},${centroid.y.toFixed(3)}`;
    let existingGraphic = parcelLayer.graphics.find(g => {
      const gCentroid = centroidOperator.execute(g.geometry as Polygon);
      if (!gCentroid) return false;
      const gCentroidKey = `${gCentroid.x.toFixed(3)},${gCentroid.y.toFixed(3)}`;
      return gCentroidKey === centroidKey;
    });

    if (existingGraphic) {
      activeGraphic = existingGraphic;
    } else {
      const parcelId = "parcel_" + Date.now();
      const highlightGraphic = new Graphic({
        geometry: poly,
        symbol: {
          type: "simple-fill",
          color: "rgba(0, 102, 255, 0.15)",
          outline: {
            color: "#0066ff",
            width: 2
          }
        } as any,
        attributes: {
          id: parcelId,
          name: `Selected Feature ${parcelLayer.graphics.length + 1}`
        }
      });
      parcelLayer.add(highlightGraphic);
      activeGraphic = highlightGraphic;
    }
    styleParcels();
    updateParcelsListUI();
  }
}

// ---------------------------------------------------------------------------
// Step-by-Step Wizard Layout & Form Generation
// ---------------------------------------------------------------------------
let currentStep = 1;

function initWizard() {
  goToStep(1);

  document.getElementById("btn-draw-mode")?.addEventListener("click", () => {
    disableSelectionMode();
    document.getElementById("btn-draw-mode")?.classList.add("active");
    showSketchComponent();
    if (sketchComponent) {
      sketchComponent.create("polygon");
    }
  });

  document.getElementById("btn-select-mode")?.addEventListener("click", () => {
    enableSelectionMode();
  });

  document.getElementById("btn-goto-step-2")?.addEventListener("click", () => {
    disableSelectionMode();
    document.getElementById("btn-draw-mode")?.classList.remove("active");
    goToStep(2);
  });

  document.getElementById("btn-back-to-step-1")?.addEventListener("click", () => goToStep(1));
  document.getElementById("btn-goto-step-3")?.addEventListener("click", () => goToStep(3));

  document.getElementById("btn-back-to-step-2")?.addEventListener("click", () => goToStep(2));
  document.getElementById("btn-goto-step-4")?.addEventListener("click", () => goToStep(4));

  document.getElementById("btn-back-to-step-3")?.addEventListener("click", () => goToStep(3));

  document.getElementById("btn-restart-wizard")?.addEventListener("click", () => {
    activeGraphic = null;
    selectedRpkName = "";
    rpkAttributes = [];
    currentParamValues = {};
    styleParcels();
    updateParcelsListUI();

    hideSketchComponent();
    if (sketchComponent) sketchComponent.cancel();
    disableSelectionMode();

    // Clear select
    (document.getElementById("select-rpk") as HTMLSelectElement).value = "";
    document.getElementById("rpk-info-box")?.classList.add("hidden");

    // Clear status
    const statusBox = document.getElementById("footprint-status-box") as HTMLDivElement;
    statusBox.className = "selection-status-box empty";
    statusBox.innerHTML = `
      <div class="status-icon-container">
        <svg class="status-icon" viewBox="0 0 24 24" width="24" height="24" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
        </svg>
      </div>
      <div class="status-text">No footprint selected or drawn yet.</div>
    `;

    (document.getElementById("btn-goto-step-2") as HTMLButtonElement).disabled = true;
    (document.getElementById("btn-goto-step-3") as HTMLButtonElement).disabled = true;

    goToStep(1);
  });

  document.getElementById("btn-generate-model")?.addEventListener("click", generate3DModel);
}

async function goToStep(stepNum: number) {
  currentStep = stepNum;

  if (stepNum !== 1) {
    hideSketchComponent();
    if (sketchComponent) {
      sketchComponent.cancel();
    }
  }

  // Progress indicators
  const nodes = document.querySelectorAll(".step-node");
  nodes.forEach(node => {
    const s = parseInt(node.getAttribute("data-step") || "1");
    node.classList.remove("active", "completed");
    if (s === currentStep) {
      node.classList.add("active");
    } else if (s < currentStep) {
      node.classList.add("completed");
    }
  });

  const percent = ((currentStep - 1) / 3) * 100;
  const progressLine = document.getElementById("wizard-progress-line") as HTMLDivElement;
  if (progressLine) progressLine.style.width = `${percent}%`;

  // Panel swaps
  document.querySelectorAll(".wizard-panel").forEach(p => p.classList.remove("active"));
  document.getElementById(`step-panel-${currentStep}`)?.classList.add("active");

  // Custom logic
  if (currentStep === 3) {
    buildParametersForm();
  } else if (currentStep === 4) {
    if (activeGraphic) {
      if (!geodeticAreaOperator.isLoaded()) {
        await geodeticAreaOperator.load();
      }
      const areaVal = Math.round(geodeticAreaOperator.execute(activeGraphic.geometry as Polygon, { unit: "square-meters" }));
      document.getElementById("summary-area")!.innerText = `${areaVal.toLocaleString()} sqm`;
    }
    document.getElementById("summary-rpk")!.innerText = selectedRpkName;
    document.getElementById("summary-params")!.innerText = `${Object.keys(currentParamValues).length} attributes`;
  }
}

async function loadRpksList() {
  const selectRpk = document.getElementById("select-rpk") as HTMLSelectElement;
  try {
    const response = await fetch(`${API_BASE}/rpks`);
    const data = await response.json();
    availableRpks = data.rpks || [];

    selectRpk.innerHTML = '<option value="" disabled selected>Select an RPK rule...</option>';
    availableRpks.forEach(rpk => {
      const opt = document.createElement("option");
      opt.value = rpk;
      opt.innerText = rpk;
      selectRpk.appendChild(opt);
    });
  } catch (error) {
    console.warn("API list_rpks failed, using config fallbacks:", error);
    selectRpk.innerHTML = '<option value="" disabled selected>Select an RPK rule...</option>';
    Object.keys(RPK_CONFIG).forEach(rpk => {
      const opt = document.createElement("option");
      opt.value = rpk;
      opt.innerText = rpk;
      selectRpk.appendChild(opt);
    });
  }
}

let availableRpks: string[] = [];

document.getElementById("select-rpk")?.addEventListener("change", async (e: any) => {
  const rpkName = e.target.value;
  selectedRpkName = rpkName;

  const infoBox = document.getElementById("rpk-info-box") as HTMLDivElement;
  const infoTitle = document.getElementById("rpk-info-title") as HTMLDivElement;
  const infoDesc = document.getElementById("rpk-info-desc") as HTMLParagraphElement;
  const gotoStep3Btn = document.getElementById("btn-goto-step-3") as HTMLButtonElement;

  infoTitle.innerText = rpkName;
  infoDesc.innerText = `Procedural parameters configured for ${rpkName}. Use step 3 to configure Heights, Setbacks, and Materials.`;
  infoBox.classList.remove("hidden");

  try {
    const response = await fetch(`${API_BASE}/rpk/${rpkName}/info`);
    const data = await response.json();
    rpkAttributes = data.attributes || [];
  } catch (error) {
    console.warn("Dynamic RPK info query failed, loading from local RpkConfig:", error);
    rpkAttributes = RPK_CONFIG[rpkName] || [];
  }

  gotoStep3Btn.disabled = false;
});

function buildParametersForm() {
  const form = document.getElementById("rpk-params-form") as HTMLDivElement;
  form.innerHTML = "";
  currentParamValues = {};

  // Merge dynamic attributes with pre-mapped parameters in configuration
  const localConfigs = RPK_CONFIG[selectedRpkName] || [];
  const localLookup: Record<string, RpkAttributeDefinition> = {};
  localConfigs.forEach(c => { localLookup[c.name] = c; });

  const paramsToRender = rpkAttributes.map(attr => {
    const local = localLookup[attr.name];
    return {
      name: attr.name,
      type: local?.type || (attr.type === "bool" ? "bool" : attr.type === "color" ? "color" : "float"),
      defaultValue: attr.defaultValue !== undefined ? attr.defaultValue : (local?.defaultValue),
      min: local?.min,
      max: local?.max,
      step: local?.step,
      options: local?.options || attr.options,
      uiType: local?.uiType,
      description: local?.description,
      group: local?.group || 'other',
      order: local?.order !== undefined ? local.order : 999
    };
  });

  // Sort by group weight (primary -> detailed -> material -> other), then by order, then alphabetically by name
  const groupWeights: Record<string, number> = {
    'primary': 1,
    'detailed': 2,
    'material': 3,
    'other': 4
  };

  paramsToRender.sort((a, b) => {
    const weightA = groupWeights[a.group] || 4;
    const weightB = groupWeights[b.group] || 4;
    if (weightA !== weightB) {
      return weightA - weightB;
    }
    if (a.order !== b.order) {
      return a.order - b.order;
    }
    return a.name.localeCompare(b.name);
  });

  if (paramsToRender.length === 0) {
    form.innerHTML = '<div class="empty-state-small">No parameters configured for this RPK.</div>';
    return;
  }

  let currentGroup = "";

  paramsToRender.forEach(param => {
    // Inject group headers when transition occurs
    if (param.group !== currentGroup) {
      currentGroup = param.group;
      const groupHeader = document.createElement("div");
      groupHeader.className = "param-group-header";
      
      let label = "Other Parameters";
      if (currentGroup === 'primary') label = "Primary Parameters";
      else if (currentGroup === 'detailed') label = "Detailed Specifications";
      else if (currentGroup === 'material') label = "Materials & Aesthetics";
      
      groupHeader.innerText = label;
      form.appendChild(groupHeader);
    }

    const item = document.createElement("div");
    item.className = "param-item";

    let val = param.defaultValue;
    if (val === undefined || val === null) {
      if (param.type === "bool") val = false;
      else if (param.type === "color") val = "#ffffff";
      else if (param.type === "float") val = 10.0;
      else val = "";
    }
    currentParamValues[param.name] = val;

    const header = document.createElement("div");
    header.className = "param-header";

    const label = document.createElement("span");
    label.className = "param-label";
    label.innerText = param.name.replace(/_/g, " ");

    const valueDisplay = document.createElement("span");
    valueDisplay.className = "param-value";

    header.appendChild(label);
    header.appendChild(valueDisplay);
    item.appendChild(header);

    if (param.type === "bool") {
      valueDisplay.innerText = val ? "ON" : "OFF";

      const labelCheck = document.createElement("label");
      labelCheck.className = "form-checkbox-container";

      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.className = "form-checkbox";
      checkbox.checked = !!val;

      checkbox.addEventListener("change", (e: any) => {
        const checked = e.target.checked;
        currentParamValues[param.name] = checked;
        valueDisplay.innerText = checked ? "ON" : "OFF";
      });

      labelCheck.appendChild(checkbox);
      labelCheck.appendChild(document.createTextNode("Enable"));
      item.appendChild(labelCheck);

    } else if (param.type === "color") {
      valueDisplay.innerText = String(val);

      const pickerContainer = document.createElement("div");
      pickerContainer.className = "form-color-picker";

      const colorInput = document.createElement("input");
      colorInput.type = "color";
      colorInput.className = "input-color";
      colorInput.value = String(val).startsWith("#") ? String(val) : "#ffffff";

      colorInput.addEventListener("input", (e: any) => {
        const hex = e.target.value;
        currentParamValues[param.name] = hex;
        valueDisplay.innerText = hex;
      });

      pickerContainer.appendChild(colorInput);
      item.appendChild(pickerContainer);

    } else if (param.options && param.options.length > 0) {
      valueDisplay.innerText = String(val);

      const selectWrap = document.createElement("div");
      selectWrap.className = "select-wrapper";

      const select = document.createElement("select");
      select.className = "form-control";

      param.options.forEach((opt: any) => {
        const option = document.createElement("option");
        option.value = String(opt);
        option.innerText = String(opt);
        if (String(opt) === String(val)) option.selected = true;
        select.appendChild(option);
      });

      select.addEventListener("change", (e: any) => {
        const selectedOpt = e.target.value;
        if (param.type === "float") {
          currentParamValues[param.name] = parseFloat(selectedOpt);
        } else if (param.type === "bool") {
          currentParamValues[param.name] = selectedOpt === "true";
        } else {
          currentParamValues[param.name] = selectedOpt;
        }
        valueDisplay.innerText = selectedOpt;
      });

      selectWrap.appendChild(select);
      item.appendChild(selectWrap);

    } else if (param.type === "string") {
      valueDisplay.innerText = val ? String(val) : "(empty)";

      const input = document.createElement("input");
      input.type = "text";
      input.className = "form-control";
      input.value = String(val);

      input.addEventListener("input", (e: any) => {
        const text = e.target.value;
        currentParamValues[param.name] = text;
        valueDisplay.innerText = text || "(empty)";
      });

      item.appendChild(input);

    } else {
      const minVal = param.min !== undefined ? param.min : 0;
      const maxVal = param.max !== undefined ? param.max : (typeof val === "number" ? Math.max(val * 3, 100) : 100);
      const stepVal = param.step !== undefined ? param.step : (maxVal - minVal > 200 ? 5 : maxVal - minVal > 20 ? 1 : 0.1);

      valueDisplay.innerText = typeof val === "number" ? val.toFixed(1) : String(val);

      const slider = document.createElement("input");
      slider.type = "range";
      slider.className = "form-range";
      slider.min = String(minVal);
      slider.max = String(maxVal);
      slider.step = String(stepVal);
      slider.value = String(val);

      slider.addEventListener("input", (e: any) => {
        const num = parseFloat(e.target.value);
        currentParamValues[param.name] = num;
        valueDisplay.innerText = num.toFixed(1);
      });

      item.appendChild(slider);
    }

    form.appendChild(item);
  });
}

// ---------------------------------------------------------------------------
// FastAPI Integration & 3D Model Placement (ArcGIS Mesh Class)
// ---------------------------------------------------------------------------
async function generate3DModel() {
  if (!activeGraphic) {
    alert("Please select or draw a footprint boundary first.");
    return;
  }

  const spinner = document.getElementById("generate-spinner") as HTMLElement;
  const btnText = document.getElementById("generate-btn-text") as HTMLSpanElement;
  const btnGen = document.getElementById("btn-generate-model") as HTMLButtonElement;

  btnGen.disabled = true;
  spinner.classList.remove("hidden");
  btnText.innerText = "Generating procedural assets...";

  try {
    let mercatorPoly = activeGraphic.geometry as Polygon;
    if (!mercatorPoly.spatialReference.isWebMercator) {
      mercatorPoly = webMercatorUtils.geographicToWebMercator(mercatorPoly) as Polygon;
    }

    // Compute original centroid on Web Mercator geometry first
    const originalCentroid = mercatorPoly ? centroidOperator.execute(mercatorPoly) as Point : null;
    if (!originalCentroid) throw new Error("Footprint centroid calculation failed.");
    originalCentroid.spatialReference = mercatorPoly.spatialReference;

    // Get latitude to calculate the Web Mercator scale factor cos(latitude)
    let geoCentroid = originalCentroid.clone();
    if (!geoCentroid.spatialReference.isGeographic) {
      geoCentroid = webMercatorUtils.webMercatorToGeographic(geoCentroid) as Point;
    }
    const lat = geoCentroid.y;
    const cosLat = Math.cos((lat * Math.PI) / 180);

    const ring = mercatorPoly.rings[0];
    let coords = ring.map(p => [p[0], p[1]]);
    if (coords[0][0] !== coords[coords.length - 1][0] || coords[0][1] !== coords[coords.length - 1][1]) {
      coords.push([coords[0][0], coords[0][1]]);
    }

    // Scale coords relative to the centroid by cosLat.
    // This scales down the Web Mercator coordinates to actual ground meters.
    // PyPRT will generate the model in actual meters, and when loaded,
    // ArcGIS will automatically scale it up to match Web Mercator units perfectly.
    const centroidX = originalCentroid.x;
    const centroidY = originalCentroid.y;
    let coordsScaled = coords.map(p => {
      const dx = p[0] - centroidX;
      const dy = p[1] - centroidY;
      return [centroidX + dx * cosLat, centroidY + dy * cosLat];
    });

    // Ensure coordinates have CCW winding order in XY plane (negative Shoelace sum)
    // When mapped to X-Z (with Z = -Y), this becomes CW, directing the face normal UP (+Y)
    // and ensuring PyPRT extrudes the building upright directly.
    let sum = 0;
    for (let i = 0; i < coordsScaled.length - 1; i++) {
      sum += (coordsScaled[i + 1][0] - coordsScaled[i][0]) * (coordsScaled[i + 1][1] + coordsScaled[i][1]);
    }
    if (sum > 0) {
      coordsScaled = coordsScaled.reverse();
    }

    const geojsonPolygon = {
      type: "Polygon",
      coordinates: [coordsScaled]
    };

    const payload = {
      rpk_name: selectedRpkName,
      geometry: geojsonPolygon,
      attributes: currentParamValues
    };

    const response = await fetch(`${API_BASE}/generate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      let errMsg = `Status code: ${response.status}`;
      try {
        const errJson = await response.json();
        if (errJson && errJson.detail) {
          errMsg = errJson.detail;
        } else if (errJson && typeof errJson === "object") {
          errMsg = JSON.stringify(errJson);
        }
      } catch (e) {
        try {
          const errText = await response.text();
          if (errText) errMsg = errText;
        } catch (e2) {}
      }
      throw new Error(errMsg);
    }

    const data = await response.json();
    const modelGlbUrl = `${API_BASE}${data.url}`;
    const reports = data.reports || {};

    const elevationResult = await view.map.ground.queryElevation(originalCentroid);
    const centroidWithZ = originalCentroid.clone();
    centroidWithZ.z = elevationResult.geometry.z || 0;

    // Project placement point to match the active SceneView's spatial reference
    let placementCentroid = centroidWithZ.clone();
    if (placementCentroid.spatialReference.wkid !== view.spatialReference.wkid) {
      if (view.spatialReference.isWebMercator) {
        placementCentroid = webMercatorUtils.geographicToWebMercator(placementCentroid) as Point;
      } else if (view.spatialReference.isGeographic) {
        placementCentroid = webMercatorUtils.webMercatorToGeographic(placementCentroid) as Point;
      } else {
        console.warn("[Mesh Placement] View spatial reference is custom. Using auto-projection.");
      }
    }

    const mesh = await Mesh.createFromGLTF(placementCentroid, modelGlbUrl, { vertexSpace: "local" });
    await mesh.load();

    // Model is now generated upright directly due to the CCW winding order alignment.
    // No rotation or mirroring is required.

    const modelId = "model_" + Date.now();
    const parcelId = activeGraphic.attributes?.id;

    if (parcelId) {
      const existingModel = placedModels.find(m => m.parcelId === parcelId);
      if (existingModel) {
        modelsLayer.remove(existingModel.graphic);
        placedModels = placedModels.filter(m => m.id !== existingModel.id);
      }
    }

    const modelGraphic = new Graphic({
      geometry: mesh,
      symbol: {
        type: "mesh-3d",
        symbolLayers: [{ type: "fill" }]
      } as any,
      attributes: { id: modelId, type: "model" }
    });

    const placedModel: PlacedModel = {
      id: modelId,
      parcelId: parcelId,
      rpkName: selectedRpkName,
      glbUrl: modelGlbUrl,
      centroid: placementCentroid,
      graphic: modelGraphic,
      baseMesh: mesh.clone(),
      reports: reports,
      parameters: { ...currentParamValues },
      transform: {
        heading: 0,
        pitch: 0,
        roll: 0,
        scale: 1.0,
        offsetX: 0,
        offsetY: 0,
        offsetZ: 0
      }
    };

    modelsLayer.add(modelGraphic);
    placedModels.push(placedModel);

    updateModelsListUI();
    selectModel(modelId);

    goToStep(1);

  } catch (error) {
    console.error("Procedural generation failed:", error);
    alert(`Generation failed:\n${error instanceof Error ? error.message : String(error)}`);
  } finally {
    btnGen.disabled = false;
    spinner.classList.add("hidden");
    btnText.innerText = "Generate 3D Model";
  }
}

// ---------------------------------------------------------------------------
// Layers & Models Manager
// ---------------------------------------------------------------------------
function initLayersManager() {
  document.getElementById("btn-toggle-parcels")?.addEventListener("click", (e: any) => {
    parcelLayer.visible = !parcelLayer.visible;
    e.currentTarget.classList.toggle("active", parcelLayer.visible);
  });

  document.getElementById("btn-add-layer")?.addEventListener("click", () => {
    const input = document.getElementById("input-layer-url") as HTMLInputElement;
    addAGOLLayer(input.value);
  });

  updateParcelsListUI();
  updateModelsListUI();
}

async function addAGOLLayer(urlOrItem: string) {
  if (!urlOrItem.trim()) return;

  try {
    let layer: FeatureLayer;
    if (urlOrItem.length === 32 && !urlOrItem.includes("/")) {
      layer = new FeatureLayer({
        portalItem: {
          id: urlOrItem
        },
        outFields: ["*"],
        elevationInfo: {
          mode: "on-the-ground"
        }
      });
    } else if (urlOrItem.startsWith("http")) {
      layer = new FeatureLayer({
        url: urlOrItem,
        outFields: ["*"],
        elevationInfo: {
          mode: "on-the-ground"
        }
      });
    } else {
      alert("Please enter a valid AGOL Feature Layer URL or 32-character Item ID.");
      return;
    }

    await layer.load();
    view.map.add(layer);

    if (layer.fullExtent) {
      view.goTo(layer.fullExtent);
    }

    const selectBt = document.getElementById("select-bt-layer") as HTMLSelectElement;
    const opt = document.createElement("option");
    opt.value = layer.id;
    opt.innerText = layer.title || "External Feature Layer";
    selectBt.appendChild(opt);

    // Auto-select the newly added layer
    selectBt.value = layer.id;

    addLayerToManagerUI(layer);

    (document.getElementById("input-layer-url") as HTMLInputElement).value = "";
  } catch (error) {
    console.error("Failed loading layer:", error);
    alert("Could not load Feature Layer. Verify authentication accessibility and CORS headers.");
  }
}

function addLayerToManagerUI(layer: FeatureLayer) {
  const list = document.getElementById("layers-manager-list") as HTMLDivElement;
  let refSection = list.querySelector(".manager-section") as HTMLDivElement;

  const item = document.createElement("div");
  item.className = "manager-item";
  item.dataset.layerId = layer.id;

  const label = document.createElement("div");
  label.className = "manager-item-label";
  label.innerText = layer.title || "External Layer";

  const actions = document.createElement("div");
  actions.className = "manager-item-actions";

  const btnVis = document.createElement("button");
  btnVis.className = "btn-icon active";
  btnVis.title = "Toggle Visibility";
  btnVis.innerHTML = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
      <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
    </svg>
  `;
  btnVis.addEventListener("click", () => {
    layer.visible = !layer.visible;
    btnVis.classList.toggle("active", layer.visible);
  });

  const btnDel = document.createElement("button");
  btnDel.className = "btn-icon danger";
  btnDel.title = "Remove Layer";
  btnDel.innerHTML = `
    <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
      <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
    </svg>
  `;
  btnDel.addEventListener("click", () => {
    layer.destroy();
    item.remove();
    const selectBt = document.getElementById("select-bt-layer") as HTMLSelectElement;
    for (let i = 0; i < selectBt.options.length; i++) {
      if (selectBt.options[i].value === layer.id) {
        selectBt.remove(i);
        break;
      }
    }
  });

  actions.appendChild(btnVis);
  actions.appendChild(btnDel);
  item.appendChild(label);
  item.appendChild(actions);
  refSection.appendChild(item);
}

function updateModelsListUI() {
  const container = document.getElementById("models-list-container") as HTMLDivElement;
  container.innerHTML = "";

  if (placedModels.length === 0) {
    container.innerHTML = '<div class="empty-state-small">No 3D models placed.</div>';
    return;
  }

  placedModels.forEach(model => {
    const item = document.createElement("div");
    item.className = "manager-item";
    if (selectedModelId === model.id) {
      item.classList.add("active");
    }

    item.addEventListener("click", (e: any) => {
      if (e.target.closest("button") || e.target.closest("svg")) return;
      selectModel(model.id);
    });

    const label = document.createElement("div");
    label.className = "manager-item-label";
    label.innerText = `${model.rpkName} (${model.id.split("_")[1].slice(-4)})`;

    const actions = document.createElement("div");
    actions.className = "manager-item-actions";

    const btnVis = document.createElement("button");
    btnVis.className = `btn-icon ${model.graphic.visible ? "active" : ""}`;
    btnVis.title = "Toggle Visibility";
    btnVis.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
        ${model.graphic.visible
        ? '<path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>'
        : '<path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.82l2.92 2.92c1.51-1.26 2.7-2.89 3.44-4.74-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.34-4.3l1.83 1.83C13.2 7.12 12.62 7 12 7c-2.76 0-5 2.24-5 5 0 .62.12 1.2.33 1.7l1.83 1.83c-.1-.28-.16-.58-.16-.9 0-1.66 1.34-3 3-3 .32 0 .62.06.9.16z"/>'}
      </svg>
    `;
    btnVis.addEventListener("click", () => {
      model.graphic.visible = !model.graphic.visible;
      updateModelsListUI();
    });

    const btnDel = document.createElement("button");
    btnDel.className = "btn-icon danger";
    btnDel.title = "Delete Model";
    btnDel.innerHTML = `
      <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor">
        <path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/>
      </svg>
    `;
    btnDel.addEventListener("click", () => {
      modelsLayer.remove(model.graphic);
      placedModels = placedModels.filter(m => m.id !== model.id);
      if (selectedModelId === model.id) {
        selectedModelId = null;
        document.getElementById("insights-content")?.classList.add("hidden");
        document.querySelector("#insights-panel .empty-state")?.classList.remove("hidden");
        document.getElementById("insight-active-dot")?.classList.add("hidden");
      }
      updateModelsListUI();
    });

    actions.appendChild(btnVis);
    actions.appendChild(btnDel);
    item.appendChild(label);
    item.appendChild(actions);
    container.appendChild(item);
  });
}

function selectModel(modelId: string) {
  selectedModelId = modelId;
  updateModelsListUI();

  const model = placedModels.find(m => m.id === modelId);
  if (!model) return;

  if (model.parcelId) {
    const parcelGraphic = parcelLayer.graphics.find(g => g.attributes?.id === model.parcelId);
    if (parcelGraphic && (!activeGraphic || activeGraphic.attributes?.id !== model.parcelId)) {
      activeGraphic = parcelGraphic;
      styleParcels();
      updateParcelsListUI();
      updateFootprintStatus("drawn", activeGraphic);
    }
  }

  displayModelReports(model);
}

// ---------------------------------------------------------------------------
// Model Insights Report Display (Left Sidebar)
// ---------------------------------------------------------------------------
function displayModelReports(model: PlacedModel) {
  const emptyState = document.querySelector("#insights-panel .empty-state") as HTMLDivElement;
  const content = document.getElementById("insights-content") as HTMLDivElement;
  const rpkName = document.getElementById("insight-rpk-name") as HTMLDivElement;
  const tableBody = document.getElementById("insights-table-body") as HTMLTableSectionElement;
  const mainVal = document.getElementById("insight-main-val") as HTMLSpanElement;
  const mainUnit = document.getElementById("insight-main-unit") as HTMLSpanElement;
  const mainLabel = document.getElementById("insight-main-label") as HTMLDivElement;
  const activeDot = document.getElementById("insight-active-dot") as HTMLSpanElement;

  emptyState.classList.add("hidden");
  content.classList.remove("hidden");
  activeDot.classList.remove("hidden");

  rpkName.innerText = model.rpkName;
  tableBody.innerHTML = "";

  const reports = model.reports || {};
  const reportKeys = Object.keys(reports);

  if (reportKeys.length === 0) {
    mainVal.innerText = "N/A";
    mainLabel.innerText = "No metrics reported";
    tableBody.innerHTML = '<tr><td colspan="2" style="text-align: center; color: #64748b; padding: 20px 0;">This rule did not emit any CGA reports.</td></tr>';
    return;
  }

  let primaryKey = reportKeys.find(k => k.toLowerCase().includes("gfa") || k.toLowerCase().includes("gross floor area"));
  if (!primaryKey) primaryKey = reportKeys.find(k => k.toLowerCase().includes("area"));
  if (!primaryKey) primaryKey = reportKeys.find(k => k.toLowerCase().includes("volume"));
  if (!primaryKey) primaryKey = reportKeys[0];

  const primaryVal = reports[primaryKey];

  if (Array.isArray(primaryVal)) {
    const sum = primaryVal.reduce((a, b) => a + b, 0);
    mainVal.innerText = typeof sum === "number" ? sum.toLocaleString(undefined, { maximumFractionDigits: 1 }) : String(sum);
  } else {
    mainVal.innerText = typeof primaryVal === "number" ? primaryVal.toLocaleString(undefined, { maximumFractionDigits: 1 }) : String(primaryVal);
  }

  mainLabel.innerText = primaryKey.replace(/_/g, " ");

  if (primaryKey.toLowerCase().includes("area") || primaryKey.toLowerCase().includes("gfa")) {
    mainUnit.innerText = "sqm";
  } else if (primaryKey.toLowerCase().includes("volume")) {
    mainUnit.innerText = "m³";
  } else if (primaryKey.toLowerCase().includes("height")) {
    mainUnit.innerText = "m";
  } else {
    mainUnit.innerText = "";
  }

  reportKeys.forEach(key => {
    const row = document.createElement("tr");
    const labelCell = document.createElement("td");
    labelCell.innerText = key.replace(/_/g, " ");

    const valCell = document.createElement("td");
    const val = reports[key];

    if (Array.isArray(val)) {
      if (val.length > 5) {
        const sum = val.reduce((a, b) => a + b, 0);
        valCell.innerText = `Sum: ${sum.toLocaleString(undefined, { maximumFractionDigits: 1 })} (${val.length} items)`;
      } else {
        valCell.innerText = val.map(v => typeof v === "number" ? v.toFixed(1) : String(v)).join(", ");
      }
    } else if (typeof val === "number") {
      valCell.innerText = val.toLocaleString(undefined, { maximumFractionDigits: 1 });
    } else {
      valCell.innerText = String(val);
    }

    row.appendChild(labelCell);
    row.appendChild(valCell);
    tableBody.appendChild(row);
  });
}

// Bind auth action and check login status
if (btnLogin) {
  btnLogin.addEventListener("click", triggerLogin);
}
checkAuth();
