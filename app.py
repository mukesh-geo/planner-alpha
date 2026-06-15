import os
import logging
import json
import tempfile
import shapely.geometry
import pyprt
import glob
import shutil
import pyproj
import gc
from shapely.ops import transform
from shapely.affinity import translate
import functools
import math
from fastapi import FastAPI, HTTPException, Body, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import List, Dict, Any, Optional

from fastapi.staticfiles import StaticFiles
import uuid

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Allow all origins for now
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
    expose_headers=["X-Centroid-Lat", "X-Centroid-Lon", "X-Convergence-Angle"]
)

# Mount static directory for I3S layers
# Ensure directory exists
LAYERS_DIR = os.path.join(os.path.dirname(__file__), "static", "layers")
if not os.path.exists(LAYERS_DIR):
    os.makedirs(LAYERS_DIR)

app.mount("/layers", StaticFiles(directory=LAYERS_DIR), name="layers")

RPK_DIR = os.path.join(os.path.dirname(__file__), "rpk")

# Ensure RPK directory exists
if not os.path.exists(RPK_DIR):
    os.makedirs(RPK_DIR)

class GenerateRequest(BaseModel):
    rpk_name: str
    geometry: Dict[str, Any]  # GeoJSON Feature or Geometry
    attributes: Dict[str, Any] = {}

class GenerateI3SRequest(BaseModel):
    rpk_name: str
    coordinates: List[float] # [lon, lat, alt, lon, lat, alt, ...]
    attributes: Dict[str, Any] = {}

def get_rpk_path(filename: str):
    path = os.path.join(RPK_DIR, filename)
    if not os.path.exists(path):
        return None
    return path

# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------

def _clean_attributes(raw: Dict[str, Any]) -> Dict[str, Any]:
    """
    Sanitise attribute values for PyPRT.

    PyPRT's CGA engine only accepts ``float | bool | str`` per attribute.
    Any value that is ``None``, a complex type (list/dict/set), or otherwise
    un-serialisable is dropped so PyPRT falls back to the CGA default value
    rather than raising an internal ``AttributeError: 'NoneType' …``.
    """
    cleaned: Dict[str, Any] = {}
    for k, v in raw.items():
        if v is None:
            continue  # drop – PyPRT will use the CGA rule default
        if isinstance(v, bool):
            cleaned[k] = bool(v)
        elif isinstance(v, float):
            cleaned[k] = float(v)
        elif isinstance(v, int):
            cleaned[k] = float(v)  # PyPRT requires float, not int
        elif isinstance(v, str):
            if v == '':
                continue  # drop empty strings – PyPRT can't handle them
            cleaned[k] = str(v)
        else:
            # Skip lists, dicts, sets, etc. — not valid CGA attribute types
            logger.warning(f"Dropping attribute '{k}' with unsupported type {type(v).__name__}")
    return cleaned


# RPKs that control report emission via boolean attributes — always force them ON.
_RPK_REPORT_FORCE_ATTRS: Dict[str, Dict[str, Any]] = {
    "BLDG_Units.rpk": {"Reports": True, "report": True},
}

# RPKs that are geometry-only and crash PyEncoder / ignore user attributes.
# For these: skip the report-extraction pass and always generate with {} attrs.
GEOMETRY_ONLY_RPKS: set = {
    "translateModel.rpk",
}


def _ensure_report_attrs(rpk_name: str, attrs: Dict[str, Any]) -> Dict[str, Any]:
    """Merge any mandatory report-enabling attributes for the given RPK.

    Some RPKs gate their ``report()`` calls behind boolean attributes
    (``Reports``, ``report``).  This helper ensures those are always
    ``True`` so the PyEncoder pass reliably returns data.
    """
    forced = _RPK_REPORT_FORCE_ATTRS.get(rpk_name, {})
    if not forced:
        return attrs
    merged = dict(attrs)  # shallow copy
    merged.update(forced)  # override / inject
    return merged


def _extract_reports(
    initial_shape: "pyprt.InitialShape",
    clean_attrs: Dict[str, Any],
    rpk_path: str,
) -> Dict[str, Any]:
    """
    Run a dedicated PyEncoder pass (emitGeometry=False, emitReport=True) to
    collect the CGA report dictionary.

    Background
    ----------
    ``GeneratedModel.get_report()`` is **only** populated when the
    ``com.esri.pyprt.PyEncoder`` is used.  File-based encoders such as
    ``GLTFEncoder`` and ``I3SEncoder`` write geometry to disk and return an
    *empty* list from ``generate_model()``, so iterating over that list
    never reaches ``get_report()``.

    Reference: https://esri.github.io/pyprt/apidoc/pyprt.pyprt.html
    """
    reports: Dict[str, Any] = {}
    mg = None
    try:
        mg = pyprt.ModelGenerator([initial_shape])
        report_models = mg.generate_model(
            [clean_attrs],
            rpk_path,
            "com.esri.pyprt.PyEncoder",
            {"emitReport": True, "emitGeometry": False},
        )
        for m in report_models:
            rep = m.get_report()
            if rep:
                reports.update(rep)
        logger.info(f"CGA reports extracted: {list(reports.keys())}")
    except Exception as exc:
        logger.warning(f"Report extraction failed (non-fatal): {exc}")
    finally:
        if mg is not None:
            del mg
        gc.collect()
    return reports

@app.get("/rpks")
async def list_rpks():
    """List available RPK files."""
    files = [f for f in os.listdir(RPK_DIR) if f.endswith(".rpk")]
    return {"rpks": files}

@app.get("/rpk/{filename}/info")
async def get_rpk_info(filename: str):
    """Get attribute information for a specific RPK."""
    rpk_path = get_rpk_path(filename)
    if not rpk_path:
        raise HTTPException(status_code=404, detail="RPK not found")

    try:
        # Get RPK attributes info using PyPRT
        attrs_info = pyprt.get_rpk_attributes_info(rpk_path)
        
        formatted_attrs = []
        
        # Handle List of Objects return type (standard PyPRT)
        if hasattr(attrs_info, '__iter__'):
             for attr in attrs_info:
                if hasattr(attr, 'get_name'):
                    name = attr.get_name()
                    attr_type = str(attr.get_type())
                    default_val = attr.get_default_value()
                    annotations = []
                    
                    if hasattr(attr, 'get_annotations'):
                        try:
                            py_annotations = attr.get_annotations()
                            logger.info(f"Attr {name} annotations: {py_annotations}")
                            for anno in py_annotations:
                                key = None
                                args = []
                                if hasattr(anno, 'get_key'):
                                    key = anno.get_key()
                                elif hasattr(anno, 'key'):
                                    key = anno.key
                                    
                                if hasattr(anno, 'get_arguments'):
                                    args = anno.get_arguments()
                                elif hasattr(anno, 'arguments'):
                                    args = anno.arguments

                                if key:
                                    annotations.append({"key": key, "arguments": args})
                        except Exception as e:
                            logger.error(f"Error fetching annotations for {name}: {e}")

                    formatted_attrs.append({
                        "name": name,
                        "type": attr_type, 
                        "defaultValue": default_val,
                        "annotations": annotations
                    })
                elif isinstance(attr, str):
                    # Fallback if list of strings
                    formatted_attrs.append({
                        "name": attr,
                        "type": "string",
                        "defaultValue": ""
                    })

        return {"attributes": formatted_attrs}
    except Exception as e:
        logger.error(f"Error inspecting RPK: {e}")
        # Return empty attributes instead of 500 if inspection fails
        return {"attributes": []}

@app.post("/generate")
async def generate_model(request: GenerateRequest):
    """Generate a 3D model from geometry and RPK."""
    rpk_path = get_rpk_path(request.rpk_name)
    if not rpk_path:
        raise HTTPException(status_code=404, detail="RPK not found")

    initial_shape = None
    model_generator = None
    temp_dir = None
    try:
        # Parse Geometry
        # Expected input is a GeoJSON Feature or Geometry
        geom_dict = request.geometry
        if geom_dict.get("type") == "Feature":
            geom_dict = geom_dict.get("geometry")
        
        shape = shapely.geometry.shape(geom_dict)
        
        if geom_dict.get("type") != "Polygon":
             raise HTTPException(status_code=400, detail="Only Polygons are supported")

        # 1. Validate geometry (repair if needed)
        if not shape.is_valid:
             shape = shape.buffer(0)

        if shape.is_empty:
             raise HTTPException(status_code=400, detail="Provided geometry is invalid or empty.")

        # 1. Force CCW winding order (sign=1.0)
        # This guarantees that when mapped to X-Z as [x, 0, -y], the winding order
        # in the X-Z plane is CW, which makes the initial shape face normal point UP (+Y).
        # This prevents the procedural model from being extruded downwards (upside down).
        shape = shapely.ops.orient(shape, sign=1.0)
        
        # 2. Re-center Geometry
        # PyPRT generates at (0,0,0). We need to shift the polygon so its centroid is at (0,0).
        centroid = shape.centroid
        logger.info(f"Geometry Centroid: {centroid.x}, {centroid.y}")
        
        # Translate shape so centroid is at (0,0)
        shape_centered = translate(shape, xoff=-centroid.x, yoff=-centroid.y)
        
        coords = list(shape_centered.exterior.coords)
        # Remove last point if duplicate (closed loop)
        if coords[0] == coords[-1]:
            coords = coords[:-1]
            
        # 3. Flatten coordinates for PyPRT InitialShape
        # Frontend ENU convention:  x = east,  y = north
        # PyPRT/CGA convention:     X = east,  Y = height (up),  Z = south (depth, negated)
        # CGA Z increases southward, but ENU Y increases northward — negate to align.
        # Mapping: [enu_x, 0, -enu_y]  →  [CGA_X, CGA_Y=0, CGA_Z]
        flattened_coords = []
        for p in coords:
            flattened_coords.extend([p[0], 0, -p[1]])


        indices = list(range(len(coords)))
        face_counts = [len(coords)]

        initial_shape = pyprt.InitialShape(flattened_coords, indices, face_counts)

        # Setup Model Generator
        # Prepare Options
        # We use OBJ encoder then convert to GLB.
        # "emitReport": True is needed to get the attributes back? No, that's get_attributes.
        temp_dir = tempfile.mkdtemp()
        export_options = {
            "outputPath": temp_dir, # Create a unique temp directory
            "outputFilename": "model",    # GLTFEncoder defaults to building model.glb if we pass proper flags
            "emitReport": True,
            "emitGeometry": True
        }
        
        # Generate
        logger.info(f"Generating with RPK: {rpk_path}")
        logger.info(f"Using attributes: {request.attributes}")
        
        # Sanitise attributes
        clean_attributes = _clean_attributes(request.attributes)
        logger.info(f"Clean attributes: {clean_attributes}")

        is_geometry_only = request.rpk_name in GEOMETRY_ONLY_RPKS

        try:
            if is_geometry_only:
                # Geometry-only RPKs (e.g. translateModel) crash PyEncoder.
                # Skip report extraction entirely and always use empty attrs.
                reports_dict = {}
                model_generator = pyprt.ModelGenerator([initial_shape])
                model_generator.generate_model(
                    [{}],
                    rpk_path,
                    "com.esri.prt.codecs.GLTFEncoder",
                    export_options,
                )
            else:
                # Pass 1 – extract CGA reports via PyEncoder
                report_attrs = _ensure_report_attrs(request.rpk_name, clean_attributes)
                reports_dict = _extract_reports(initial_shape, report_attrs, rpk_path)

                # Pass 2 – generate the actual GLB geometry
                model_generator = pyprt.ModelGenerator([initial_shape])
                models = model_generator.generate_model(
                    [clean_attributes],
                    rpk_path,
                    "com.esri.prt.codecs.GLTFEncoder",
                    export_options,
                )

        except Exception as e:
            # Any PyPRT error (AttributeError, TypeError, RuntimeError…)
            # Retry with empty attrs so the CGA rule uses its defaults.
            logger.warning(
                f"PyPRT error with supplied attrs ({type(e).__name__}: {e}). "
                "Retrying with CGA defaults (empty attrs)."
            )
            if model_generator is not None:
                del model_generator
                model_generator = None
            try:
                reports_dict = {} if is_geometry_only else _extract_reports(
                    initial_shape,
                    _ensure_report_attrs(request.rpk_name, {}),
                    rpk_path,
                )
                model_generator = pyprt.ModelGenerator([initial_shape])
                model_generator.generate_model(
                    [{}],
                    rpk_path,
                    "com.esri.prt.codecs.GLTFEncoder",
                    export_options,
                )
            except Exception as e2:
                logger.error(f"PyPRT Generation Error (retry failed): {e2}")
                import traceback; traceback.print_exc()
                raise HTTPException(status_code=500, detail=f"PyPRT Generation Failed: {str(e2)}")

        output_path = export_options["outputPath"]
        
        # PyPRT GLTFEncoder usually spits out .glb by default, or .gltf
        generated_files = glob.glob(os.path.join(output_path, "*.glb"))
        if not generated_files:
            generated_files = glob.glob(os.path.join(output_path, "*.gltf"))
            
        if generated_files:
            glb_path = generated_files[0]
            logger.info(f"Found GLTF/GLB at {glb_path}")
            
            uuid_folder = str(uuid.uuid4())
            serve_dir = os.path.join(LAYERS_DIR, uuid_folder)
            os.makedirs(serve_dir, exist_ok=True)
            
            final_glb_path = os.path.join(serve_dir, "model.glb")
            shutil.copy(glb_path, final_glb_path)
            
            return JSONResponse(content={
                "url": f"/layers/{uuid_folder}/model.glb",
                "reports": reports_dict,
                "message": "GLB Generated Natively"
            })
            
        else:
             logger.error(f"No GLB/GLTF file found in {output_path}")
             raise HTTPException(status_code=500, detail="PyPRT Generation failed: No GLB file created")

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"Generation error: {e}")
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if model_generator is not None:
            del model_generator
        if initial_shape is not None:
            del initial_shape
        if temp_dir is not None:
            logger.info(f"Cleaning up temp directory: {temp_dir}")
            shutil.rmtree(temp_dir, ignore_errors=True)
        gc.collect()

@app.post("/generate_i3s")
async def generate_i3s(request: GenerateRequest):
    """Generate an I3S Layer (SLPK unpacked) using same logic as GLB generation."""
    
    # 0. Cleanup Old Layers
    try:
        import time
        if os.path.exists(LAYERS_DIR):
            now = time.time()
            for item in os.listdir(LAYERS_DIR):
                item_path = os.path.join(LAYERS_DIR, item)
                if os.path.isdir(item_path):
                    mtime = os.path.getmtime(item_path)
                    if now - mtime > 3600: # older than 1 hour
                        shutil.rmtree(item_path, ignore_errors=True)
                        logger.info(f"Pruned expired layer folder: {item_path}")
    except Exception as e:
        logger.warning(f"Cleanup of old layers failed: {e}")

    rpk_path = get_rpk_path(request.rpk_name)
    if not rpk_path:
        raise HTTPException(status_code=404, detail="RPK not found")
    initial_shape = None
    model_generator = None
    try:
        # 1. Parse Geometry
        geom_dict = request.geometry
        if geom_dict.get("type") == "Feature":
             geom_dict = geom_dict.get("geometry")
        
        shape = shapely.geometry.shape(geom_dict)
        if geom_dict.get("type") != "Polygon":
             raise HTTPException(status_code=400, detail="Only Polygons are supported")

        # Re-orient to CCW for consistency
        if not shape.is_valid: shape = shape.buffer(0)
        if shape.is_empty:
             raise HTTPException(status_code=400, detail="Provided geometry is invalid or empty.")
        shape = shapely.ops.orient(shape, sign=1.0) # CCW
        
        # 2. Project to ECEF (EPSG:4978) - Earth Centered Earth Fixed
        # Why?
        # - Units are METERS (Fixes "Needle" building).
        # - Global System (Fixes "Africa Sea" / UTM Zone issues).
        # - Native to Cesium/3D Tiles.
        
        target_epsg = 4978
        logger.info(f"Projecting to ECEF (EPSG:{target_epsg})")
        
        # Transformer: 4326 (Lon/Lat) -> 4978 (X/Y/Z)
        # Note: 4326 order depends on pyproj version (Lat/Lon vs Lon/Lat). 
        # "always_xy=True" ensures Lon, Lat convention.
        projector = pyproj.Transformer.from_crs("EPSG:4326", f"EPSG:{target_epsg}", always_xy=True)
        
        # Calculate ECEF Centroid
        # We need to project all points first to find generic 3D centroid
        coords_deg = list(shape.exterior.coords)
        ecef_coords_all = []
        for p in coords_deg:
            # p is (lon, lat)
            x, y, z = projector.transform(p[0], p[1], 0) # Assume Alt=0 for footprint
            ecef_coords_all.append((x, y, z))
            
        # Compute Centroid (Average)
        avg_x = sum(c[0] for c in ecef_coords_all) / len(ecef_coords_all)
        avg_y = sum(c[1] for c in ecef_coords_all) / len(ecef_coords_all)
        avg_z = sum(c[2] for c in ecef_coords_all) / len(ecef_coords_all)
        
        anchor_ecef = [avg_x, avg_y, avg_z]
        logger.info(f"ECEF Anchor: {anchor_ecef}")
        
        # 3. Localize (Subtract Anchor)
        flattened_coords = []
        for c in ecef_coords_all:
             flattened_coords.extend([c[0] - avg_x, c[1] - avg_y, c[2] - avg_z])

        # PyPRT InitialShape expects [x, y, z, ...]
        indices = list(range(len(ecef_coords_all)))
        face_counts = [len(ecef_coords_all)]
        
        initial_shape = pyprt.InitialShape(flattened_coords, indices, face_counts)

        # 4. Encoder Options
        layer_id = str(uuid.uuid4())
        output_dir = os.path.join(LAYERS_DIR, layer_id)
        os.makedirs(output_dir, exist_ok=True)
        
        enc_options = {
            'sceneType': 'Global', 
            'sceneWkid': str(target_epsg), # 4978
            'baseName': 'SceneLayer',
            'sceneName': 'SceneLayer',
            'writePackage': False, 
            'compression': False, 
            'outputPath': output_dir,
            
            # Global Offset is the ECEF Anchor
            'globalOffset': anchor_ecef 
        }
        
        # Sanitise attributes
        clean_attributes = _clean_attributes(request.attributes)
        logger.info(f"Generating I3S to {output_dir}")

        # Pass 1 – extract CGA reports via PyEncoder
        # (I3SEncoder returns an empty list, so get_report() never fires)
        report_attrs = _ensure_report_attrs(request.rpk_name, clean_attributes)
        reports_dict = _extract_reports(initial_shape, report_attrs, rpk_path)

        # Pass 2 – generate the actual I3S scene layer
        model_generator = pyprt.ModelGenerator([initial_shape])
        models = model_generator.generate_model(
            [clean_attributes],
            rpk_path,
            'com.esri.prt.codecs.I3SEncoder',
            enc_options,
        )
        # (models is empty for file encoders — that is expected)
        
        # Verify output
        # The encoder usually creates a subfolder based on sceneName or baseName, or just dumps in outputPath?
        # With layerType="Path", it usually creates a folder structure like:
        # output_dir/SceneLayer.slpk (if file) OR output_dir/nodepages/... (if Path)
        # Let's check what's inside output_dir
        # Usually for 'Path' it produces 'scenelayer.json' directly in outputPath?
        # Or inside a subdirectory 'baseName'?
        
        # We'll return the URL. 
        # Construction: /layers/{layer_id}/...
        # We might need to find the .json file.
        
        # Search for the I3S entry point (3dSceneLayer.json)
        json_file_path = None
        debug_files = []
        
        for root, dirs, files in os.walk(output_dir):
            for file in files:
                rel_path = os.path.relpath(os.path.join(root, file), output_dir)
                debug_files.append(rel_path)
                if file == "3dSceneLayer.json":
                    # Found it!
                    # Construct URL path relative to /layers mount
                    # e.g. root is .../static/layers/<uuid>/SceneLayer
                    # we need /layers/<uuid>/SceneLayer/3dSceneLayer.json
                    
                    # rel_path_from_layers_dir
                    rel_from_layers = os.path.relpath(os.path.join(root, file), LAYERS_DIR)
                    # replace backslashes if on windows (though usually linux on HF)
                    rel_from_layers = rel_from_layers.replace("\\", "/")
                    json_file_path = f"/layers/{rel_from_layers}"

        if not json_file_path:
             logger.error(f"Could not find 3dSceneLayer.json in {output_dir}")
             # Fallback to just the directory root
             if os.path.exists(os.path.join(output_dir, "SceneLayer")):
                  json_file_path = f"/layers/{layer_id}/SceneLayer"
             else:
                  json_file_path = f"/layers/{layer_id}"
        
        return {
            "layerUrl": json_file_path, 
            "layerId": layer_id,
            "reports": reports_dict,
            "message": "I3S Layer Generated",
            "debug_files": debug_files[:20] # Return first 20 files for debugging
        }

    except HTTPException:
        raise
    except Exception as e:
        logger.error(f"I3S Generation error: {e}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))
    finally:
        if model_generator is not None:
            del model_generator
        if initial_shape is not None:
            del initial_shape
        gc.collect()

@app.middleware("http")
async def i3s_smart_middleware(request: Request, call_next):
    # Intercept requests to /layers/
    if request.url.path.startswith("/layers"):
        path = request.url.path
        
        # Determine local path
        # URL: /layers/<uuid>/...
        # Local: .../static/layers/<uuid>/...
        rel_path = path[len("/layers"):]
        if rel_path.startswith("/"): rel_path = rel_path[1:]
        local_path = os.path.join(LAYERS_DIR, rel_path.replace("/", os.sep))
        
        # Logic to map REST-style I3S requests to File System
        target_file = None
        
        # 1. Check if exact file exists
        if os.path.isfile(local_path):
             pass # Let static handler take it
        else:
            # 2. Handle I3S Conventions
            
            # Case A: Layer Root (e.g. .../layers/0r or .../layers/0r/)
            # If directory exists, check for 3dSceneLayer.json
            if os.path.isdir(local_path):
                 possible_json = os.path.join(local_path, "3dSceneLayer.json")
                 if os.path.isfile(possible_json):
                      target_file = possible_json

            # Case B: Nodes (e.g. .../nodes/root or .../nodes/15)
            # Expects: .../nodes/root/3dNodeIndexDocument.json
            elif "/nodes/" in path:
                # Handle sub-resources of nodes
                clean_path = local_path.rstrip(os.sep)
                
                if "/geometries/" in path:
                    # .../geometries/0 -> .../geometries/0.bin
                    possible_bin = clean_path + ".bin"
                    if os.path.isfile(possible_bin):
                        target_file = possible_bin
                        media_type="application/octet-stream"
                        
                elif "/features/" in path:
                    # .../features/0 -> .../features/0.json
                    possible_json = clean_path + ".json"
                    if os.path.isfile(possible_json):
                        target_file = possible_json
                
                elif "/textures/" in path:
                     # Textures are tricky, often .jpg or .bin.dds
                     # Just try appending extensions
                     for ext in [".jpg", ".png", ".bin.dds", ".dds"]:
                         possible_tex = clean_path + ext
                         if os.path.isfile(possible_tex):
                             target_file = possible_tex
                             break

                else:
                    # It is a Node itself (e.g. .../nodes/1)
                    # If directory, look for 3dNodeIndexDocument.json
                    if os.path.isdir(clean_path):
                         possible_doc = os.path.join(clean_path, "3dNodeIndexDocument.json")
                         if os.path.isfile(possible_doc):
                              target_file = possible_doc

            # Case C: NodePages (e.g. .../nodepages/0 or .../nodepages/0/)
            # Expects: .../nodepages/0.json
            elif "/nodepages/" in path:
                 # Strip trailing slash if present to cleanly append .json
                 clean_local_path = local_path.rstrip(os.sep)
                     
                 # Check if adding .json helps
                 possible_json_page = clean_local_path + ".json"
                 if os.path.isfile(possible_json_page):
                      target_file = possible_json_page

        if target_file:
            logger.info(f"Serving I3S Resource: {path} -> {target_file}")
            return FileResponse(target_file, media_type="application/json")
            
    response = await call_next(request)
    return response

@app.get("/")
async def root():
    return {"message": "CityPyPRT 3D Generation API"}


# ---------------------------------------------------------------------------
# Dedicated report endpoint
# ---------------------------------------------------------------------------

@app.post("/report")
async def get_model_report(request: GenerateRequest):
    """
    Return **only** the CGA report dict for a given geometry + RPK, without
    writing any geometry files to disk.

    This uses ``com.esri.pyprt.PyEncoder`` with ``emitReport=True`` and
    ``emitGeometry=False`` — the only encoder that populates
    ``GeneratedModel.get_report()``.

    Request body (same as /generate)
    ---------------------------------
    .. code-block:: json

        {
          "rpk_name": "Building.rpk",
          "geometry": { "type": "Polygon", "coordinates": [...] },
          "attributes": { "buildingHeight": 30.0 }
        }

    Response
    --------
    .. code-block:: json

        {
          "report": { "Ground Floor Area": 250.0, "Building Volume": 3200.0 },
          "rpk_name": "Building.rpk"
        }
    """
    rpk_path = get_rpk_path(request.rpk_name)
    if not rpk_path:
        raise HTTPException(status_code=404, detail=f"RPK '{request.rpk_name}' not found")

    initial_shape = None
    try:
        # --- Parse geometry (same logic as /generate) ---
        geom_dict = request.geometry
        if geom_dict.get("type") == "Feature":
            geom_dict = geom_dict.get("geometry")

        if geom_dict.get("type") != "Polygon":
            raise HTTPException(status_code=400, detail="Only Polygon geometries are supported")

        shape = shapely.geometry.shape(geom_dict)
        if not shape.is_valid:
            shape = shape.buffer(0)
            
        if shape.is_empty:
             raise HTTPException(status_code=400, detail="Provided geometry is invalid or empty.")
             
        shape = shapely.ops.orient(shape, sign=1.0)  # CCW, consistent with /generate

        centroid = shape.centroid
        shape_centered = translate(shape, xoff=-centroid.x, yoff=-centroid.y)

        coords = list(shape_centered.exterior.coords)
        if coords[0] == coords[-1]:
            coords = coords[:-1]

        # Same CGA Z-axis negation as /generate: ENU Y = north, CGA Z = south
        flattened_coords = []
        for p in coords:
            flattened_coords.extend([p[0], 0, -p[1]])

        indices = list(range(len(coords)))
        face_counts = [len(coords)]
        initial_shape = pyprt.InitialShape(flattened_coords, indices, face_counts)

        # --- Sanitise attributes ---
        clean_attributes = _clean_attributes(request.attributes)

        # --- Run PyEncoder report pass ---
        try:
            report_attrs = _ensure_report_attrs(request.rpk_name, clean_attributes)
            reports_dict = _extract_reports(initial_shape, report_attrs, rpk_path)
        except (AttributeError, TypeError) as e:
            # Same 'NoneType has no attribute lower' guard as /generate.
            # Fall back to CGA defaults so the report endpoint never 500s
            # on RPKs whose attribute metadata PyPRT can't resolve.
            logger.warning(
                f"Report endpoint: attribute error with supplied attrs ({e}). "
                "Retrying with CGA defaults."
            )
            reports_dict = _extract_reports(initial_shape, _ensure_report_attrs(request.rpk_name, {}), rpk_path)

        return JSONResponse(content={
            "report": reports_dict,
            "rpk_name": request.rpk_name,
        })

    except HTTPException:
        raise
    except Exception as exc:
        logger.error(f"Report endpoint error: {exc}")
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(exc))
    finally:
        if initial_shape is not None:
            del initial_shape
        gc.collect()