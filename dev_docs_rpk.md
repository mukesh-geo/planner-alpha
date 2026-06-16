# Developer Documentation: RPK Fetching, Attributes & UI Logic

This document describes how Procedural Rule Packages (RPKs) are loaded, inspected, and rendered in the Urban360 Planner App. It also details the prioritization mechanism that groups and sorts parameters so that the most relevant parameters (e.g., Building Height, Setbacks, Density) are placed at the top of the UI.

---

## 1. System Architecture

The RPK handling system follows a classic client-server architecture:

```mermaid
graph TD
    subgraph Frontend (Vite + TypeScript)
        MainTS[src/main.ts]
        RpkConfig[src/RpkConfig.ts]
        UIForm[HTML #rpk-params-form]
        
        MainTS -->|1. List RPKs| API_List
        MainTS -->|2. Fetch Info| API_Info
        MainTS -->|3. Merge & Sort| RpkConfig
        MainTS -->|4. Build UI| UIForm
    end

    subgraph Backend (FastAPI + PyPRT)
        API_List[/rpks]
        API_Info[/rpk/{filename}/info]
        PyPRT[PyPRT Engine]
        RPK_Dir[rpk/ Directory]

        API_List -->|Scan files| RPK_Dir
        API_Info -->|Inspect RPK| PyPRT
        PyPRT -->|Extract CGA Annotations| RPK_Dir
    end
```

---

## 2. Backend Logic (FastAPI)

The FastAPI server (`app.py`) serves two main endpoints related to RPK metadata:

### A. List Rule Packages: `GET /rpks`
Scans the local `rpk/` folder for files ending in `.rpk` and returns them as a JSON list.
- **Python Code**:
  ```python
  @app.get("/rpks")
  async def list_rpks():
      files = [f for f in os.listdir(RPK_DIR) if f.endswith(".rpk")]
      return {"rpks": files}
  ```

### B. Fetch RPK Metadata: `GET /rpk/{filename}/info`
Inspects a specific `.rpk` file using PyPRT (Python bindings for CityEngine Procedural Run-Time) to retrieve its attributes, default values, and CGA annotations.
- **Winding Wires of PyPRT Extraction**:
  1. Calls `pyprt.get_rpk_attributes_info(rpk_path)`.
  2. Iterates over the attribute collection.
  3. Extracts attribute name, data type (float, string, bool), and default value.
  4. Parses CGA Annotations (such as range annotations, enum options, colors) if available.
- **Python Code**:
  ```python
  attrs_info = pyprt.get_rpk_attributes_info(rpk_path)
  formatted_attrs = []
  for attr in attrs_info:
      name = attr.get_name()
      attr_type = str(attr.get_type())
      default_val = attr.get_default_value()
      annotations = []
      
      # Extract annotations (e.g., @Range, @Directory, @Color)
      if hasattr(attr, 'get_annotations'):
          py_annotations = attr.get_annotations()
          for anno in py_annotations:
              key = anno.get_key() if hasattr(anno, 'get_key') else anno.key
              args = anno.get_arguments() if hasattr(anno, 'get_arguments') else anno.arguments
              annotations.append({"key": key, "arguments": args})
              
      formatted_attrs.append({
          "name": name,
          "type": attr_type, 
          "defaultValue": default_val,
          "annotations": annotations
      })
  ```

---

## 3. Frontend Configurations (`src/RpkConfig.ts`)

Because dynamic rule package inspection via PyPRT might not capture fine-tuned UI metadata (like range boundaries, step intervals, material pickers, or custom labels), a local TypeScript configuration file `src/RpkConfig.ts` acts as a descriptor/override registry.

### Attribute Definition Interface
We extend this definition to support **categorized grouping** and **sorting priorities**:
```typescript
export interface RpkAttributeDefinition {
    name: string;
    type: 'float' | 'string' | 'bool' | 'color';
    uiType?: 'texture';                                  // Material library picker
    defaultValue: any;
    min?: number;
    max?: number;
    step?: number;
    options?: string[];                                  // Enum dropdown options
    description?: string;
    group?: 'primary' | 'detailed' | 'material' | 'other'; // Visual grouping category
    order?: number;                                      // Display order within group (ascending)
}
```

### Categorization System
- **`primary`**: High-level structural rules (Heights, Primary Uses, Base Shape modes).
- **`detailed`**: Dimension specifics, setbacks, and sub-shapes (Window dimensions, spacing, offsets).
- **`material`**: Visual texturing and color overlays (Color pickers, texture drops).
- **`other`**: Uncategorized or automatically fetched dynamic attributes.

---

## 4. Frontend UI Logic (`src/main.ts`)

### A. Fetching and Caching
When a user selects an RPK in the dropdown selector:
1. An asynchronous GET request is made to `/rpk/{rpkName}/info`.
2. On success, the response sets the global `rpkAttributes` array.
3. If it fails, the application falls back to `RPK_CONFIG[rpkName]` from `RpkConfig.ts` to ensure offline capability.

### B. Parameter Merging, Sorting & Rendering
In Step 3, the `buildParametersForm()` function maps the RPK attributes, merges them with local config overrides, sorts them by group and priority order, and builds the UI.

#### Step 1: Merge Dynamic & Static Fields
```typescript
const paramsToRender = rpkAttributes.map(attr => {
  const local = localLookup[attr.name];
  return {
    name: attr.name,
    type: local?.type || (attr.type === "bool" ? "bool" : attr.type === "color" ? "color" : "float"),
    defaultValue: attr.defaultValue !== undefined ? attr.defaultValue : local?.defaultValue,
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
```

#### Step 2: Sort by Importance Group and Order
The parameters are sorted based on their group priority, then by their `order` index:
```typescript
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
```

#### Step 3: DOM Rendering with Group Sections
As the list is parsed, transitioning between groups triggers the insertion of a visual `.param-group-header` element:
```typescript
let currentGroup = "";

paramsToRender.forEach(param => {
  // Inject group headers
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

  // Create parameter item element (.param-item)
  const item = document.createElement("div");
  item.className = "param-item";
  
  // Render control based on param.type (slider, input, checkbox, select)
  ...
  form.appendChild(item);
});
```

---

## 5. UI Control Mapping Matrix

Based on the type of RpkAttributeDefinition, the UI logic maps controls as follows:

| Attribute Type | Criteria / UI Type | UI Element | Interaction Behavior |
| :--- | :--- | :--- | :--- |
| **`bool`** | None | Checkbox | Toggles between `true` and `false`. Updates summary as `ON` / `OFF`. |
| **`color`** | None | Color Picker (`<input type="color">`) | Updates color preview hex value dynamically. |
| **Any Type** | Options array present | Dropdown (`<select>`) | Renders pre-defined values. Updates value on selection. Parses to float/bool/string on save. |
| **`string`** | No options | Text Input (`<input type="text">`) | User types custom text value. Defaults to `"(empty)"` if blank. |
| **`float` / `int`** | No options | Range Slider (`<input type="range">`) | User slides value. Utilizes `min`, `max`, `step` boundaries. Displays formatted decimal string. |
