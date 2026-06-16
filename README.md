# Urban 360 - 3D Parametric Urban Planner

A premium 3D procedural planning web application utilizing the **ArcGIS Maps SDK for JavaScript 5.0 (latest version)** and a **Python FastAPI PyPRT (Procedural Runtime) backend**.

This portal allows urban planners to draw parcel footprints or select parcel features from ArcGIS Online, proceduralize them using CityEngine Rule Packages (RPKs), place generated models directly on 3D terrain, and tune dimensions/transformations in real time.

---

## Key Features

1. **OAuth 2.0 User Authentication**:
   - Integrates user authentication via ArcGIS Online.
   - Configured with `popup: false` to complete the authorization flow in the **same browser tab** (no popups or external windows), returning credentials seamlessly via the URL hash.
2. **Modern SDK 5.0 Operators**:
   - Migrated from deprecated `geometryEngine` to `@arcgis/core/geometry/operators/geodeticAreaOperator` for client-side area calculations.
   - Migrated from deprecated `Polygon.centroid` property to `@arcgis/core/geometry/operators/centroidOperator` to compute geometric centers.
3. **3D WebScene with Graceful Fallback**:
   - Loads a default 3D WebScene representing the study area.
   - If the custom scene (e.g., containing Google 3D Tiles) fails to load due to authorization errors (403), the application gracefully falls back to a reliable public WebScene ID (`c656360df94943f789ad69a531bfa2eb`) to maintain full functionality.
4. **FastAPI & PyPRT Integration**:
   - Communicates with a local Python FastAPI service to list Rule Packages (RPKs) and fetch dynamic rule parameter metadata.
   - Generates 3D GLTF models on-the-fly from GeoJSON footprint coordinates.
5. **Default Imagery Basemap**:
   - Switches the 3D WebScene's basemap on startup from the default saved basemap to the high-resolution ArcGIS Satellite Imagery basemap.
6. **Model Insights**:
   - Visualizes detailed CGA report metrics (e.g., Gross Floor Area, volume, floor count) directly in a dedicated analytics panel.
7. **Clean Console Logging**:
   - Cleaned up verbose debug logs from the browser console (OAuth Client ID, redirect URIs, WebScene loading states, basemap queries, geometry transformations, and coordinate metrics).
   - Preserves warning and error levels (`console.warn`, `console.error`) to ensure developers can troubleshoot genuine system failures.

---

## Project Structure

- `app.py`: FastAPI server that integrates with `pyprt` to process geometries and compile RPK configurations.
- `index.html`: Main user interface with sidebars for insights, layers, settings, and stepper wizard.
- `src/main.ts`: Application entry point implementing SDK initialization, drawing widgets, and model placement/tuning logic.
- `src/RpkConfig.ts`: Parameter definitions for fallback forms if the backend configuration is unreachable.
- `src/style.css`: Clean, light-themed user experience (strictly using Black, White, and Blue).

---

## Getting Started

### 1. Prerequisites
- Node.js (v18+)
- Python 3.9 - 3.11 (Note: `pyprt` supports specific python versions, check [PyPRT installation](https://github.com/Esri/pyprt) for compatibility).

### 2. Backend Setup (FastAPI & PyPRT)
1. Install Python packages:
   ```bash
   pip install fastapi uvicorn shapely pyprt pyproj
   ```
2. Put your Rule Packages (`.rpk` files) inside the `/rpk` directory.
3. Run the uvicorn development server:
   ```bash
   uvicorn app:app --reload --port 8000
   ```
   The backend will be running at `http://localhost:8000`.

### 3. Frontend Setup (Vite & TypeScript)
1. Install node dependencies:
   ```bash
   npm install
   ```
2. Run the Vite development server:
   ```bash
   npm run dev
   ```
   The application will be running at `http://localhost:5173`.

---

## Configuration

### OAuth Client ID & Redirect URI
1. Register an application in your **ArcGIS Developer Dashboard** or **ArcGIS Online organization**.
2. Add `http://localhost:5173/` (and/or your production hosting domain) to the **Redirect URIs** list.
3. Set your Client ID in `src/main.ts`:
   ```typescript
   const APP_CLIENT_ID = "YOUR_16_CHARACTER_CLIENT_ID";
   ```
4. If the Client ID remains set to the default template `"2JSOKuomAscBzB4"`, the application automatically corrects it to `"2JSOKuomAscBzB4e"` (Esri standard public sample app ID).
