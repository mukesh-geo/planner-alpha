export interface RpkAttributeDefinition {
    name: string;
    type: 'float' | 'string' | 'bool' | 'color';
    uiType?: 'texture'; // renders material library picker icon
    defaultValue: any;
    min?: number;
    max?: number;
    step?: number;
    options?: string[]; // For enums
    description?: string;
}

export const RPK_CONFIG: Record<string, RpkAttributeDefinition[]> = {
    "BLDG_Units.rpk": [

        { name: "Building_Height", type: "float", defaultValue: 100, min: 3, max: 300 },
        { name: "Ground_Floor_Height", type: "float", defaultValue: 4.5, min: 3, max: 15 },
        { name: "Typical_Floor_Height", type: "float", defaultValue: 3.5, min: 3, max: 15 },
        { name: "Corridor_Width", type: "float", defaultValue: 9.0, min: 3.0, max: 30.0 },
        { name: "Area_1BHK", type: "float", defaultValue: 200, min: 0, max: 500 },
        { name: "Area_2BHK", type: "float", defaultValue: 300, min: 0, max: 500 },
        { name: "Area_3BHK", type: "float", defaultValue: 400, min: 0, max: 500 },
        { name: "Area_4BHK", type: "float", defaultValue: 500, min: 0, max: 500 },
        { name: "Area_Studio", type: "float", defaultValue: 900, min: 0, max: 900 },
        { name: "Gap_Horizontal", type: "float", defaultValue: 0.5, min: 0, max: 1 },
        { name: "Gap_Vertical", type: "float", defaultValue: 0.5, min: 0, max: 1 },

    ],

    "candler.rpk": [
        { name: "BuildingHeight", type: "float", defaultValue: 62.0, min: 10, max: 200, step: 1.0 },
        { name: "Mode", type: "string", defaultValue: "Visualization", options: ["Visualization", "Massing"] },
        { name: "FloorHeight", type: "float", defaultValue: 3.5, min: 2.0, max: 6.0, step: 0.1 },
        { name: "GroundfloorHeight", type: "float", defaultValue: 4.3, min: 2.0, max: 8.0, step: 0.1 },
        { name: "TileWidth", type: "float", defaultValue: 3.55, min: 1.0, max: 10.0, step: 0.05 },
        { name: "CorniceOverhang", type: "float", defaultValue: 1.2, min: 0.0, max: 5.0, step: 0.1 },
        { name: "WindowHeight", type: "float", defaultValue: 2.05, min: 0.5, max: 5.0, step: 0.05 },
        { name: "FrontWindowWidth", type: "float", defaultValue: 2.15, min: 0.5, max: 5.0, step: 0.05 },
        { name: "RearWindowWidth", type: "float", defaultValue: 1.2, min: 0.5, max: 5.0, step: 0.05 },
        { name: "SillSize", type: "float", defaultValue: 0.26, min: 0.0, max: 1.0, step: 0.01 },
        { name: "CornerWallWidth", type: "float", defaultValue: 1.0, min: 0.0, max: 5.0, step: 0.1 },
        { name: "WallTexture", type: "string", uiType: "texture", defaultValue: "facade/walls/bricks.jpg" },
        { name: "ColorizeWall", type: "color", defaultValue: "#FCEFE2" }
    ],
    "envelope2002.rpk": [
        { name: "Density_bonus_height", type: "float", defaultValue: 60.0, min: 0, max: 200 },
        { name: "shape_of_building", type: "float", defaultValue: 1.0, options: ["1", "2", "3", "4"] },
        { name: "lot_coverage_parameter", type: "float", defaultValue: 60.0, min: 0, max: 100 },
        { name: "height_first_tier", type: "float", defaultValue: 12.2, min: 0, max: 100, step: 0.5 },
        { name: "first_setback_size", type: "float", defaultValue: 3.0, min: 0, max: 30, step: 0.5 },
        { name: "height_second_tier", type: "float", defaultValue: 40.0, min: 0, max: 200, step: 1 },
        { name: "second_setback_size", type: "float", defaultValue: 3.0, min: 0, max: 30, step: 0.5 },
        { name: "ground_floors_use", type: "string", defaultValue: "commercial", options: ["commercial", "residential", "office"] },
        { name: "main_building_use", type: "string", defaultValue: "residential", options: ["commercial", "residential", "office"] },
        { name: "create_green_spaces", type: "bool", defaultValue: false },
        { name: "create_facade", type: "bool", defaultValue: true },
        { name: "create_landscape", type: "bool", defaultValue: true },
        { name: "create_ground_floor_plan", type: "bool", defaultValue: true },
        { name: "create_volume", type: "bool", defaultValue: true },
        { name: "representation_of_plants", type: "string", defaultValue: "realistic", options: ["realistic", "schematic", "none"] },
        { name: "facade_type_for_commercial", type: "string", defaultValue: "glass", options: ["glass", "concrete", "brick"] },
        { name: "slab_material", type: "string", defaultValue: "concrete", options: ["concrete", "wood", "paving"] },
        { name: "window_type", type: "string", defaultValue: "standard", options: ["standard", "panoramic"] }
    ],

    "extrusion_rule.rpk": [
        { name: "minBuildingHeight", type: "float", defaultValue: 10.0, min: 0, max: 100 },
        { name: "maxBuildingHeight", type: "float", defaultValue: 30.0, min: 0, max: 100 },
        { name: "buildingColor", type: "color", defaultValue: "#FF00FF" },
        { name: "text", type: "string", defaultValue: "salut" }
    ],
    "Building_From_Footprint.rpk": [

    ],


    "translateModel.rpk": [

        { name: "vec_x", type: "float", defaultValue: 0.0, min: -100, max: 100 },
        { name: "vec_y", type: "float", defaultValue: 0.0, min: -100, max: 100 },
        { name: "vec_z", type: "float", defaultValue: 0.0, min: -100, max: 100 }
    ]
};
