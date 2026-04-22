// ---------------------------------------------------------------------------
// Stylized Tallinn Old Town map.
// Must be byte-identical with client/src/shared/map.ts (collision determinism).
// ---------------------------------------------------------------------------

export const TILE_SIZE = 32;
export const MAP_W = 52;
export const MAP_H = 40;

export const T = {
  GRASS: 0,
  STREET: 1,        // outer cobble street (rougher)
  PLAZA: 2,         // Raekoja plats cobblestone (finer)
  BUILDING: 3,      // generic building interior (solid)
  WALL: 4,          // crenellated city wall
  WATER: 5,
  TREE: 6,
  GATE: 7,          // walkable gate opening
  CHURCH: 8,        // Oleviste-style (solid, very tall visual)
  TOOMPEA_GROUND: 9,
  TOWN_HALL: 10,    // Raekoda (solid)
  TOWER: 11,        // round defense/landmark tower (solid)
  HOUSE: 12,        // merchant house (solid, painted from buildings[])
  WELL: 13,         // Raekoja kaev (solid)
  MARKET_STALL: 14, // walkable decoration (prop)
  LANTERN: 15,      // walkable decoration
  STAIRS: 16,       // Pikk jalg / Lühike jalg (walkable)
  CASTLE_WALL: 17,  // thicker inner walls on Toompea (solid)
} as const;

export type TileId = typeof T[keyof typeof T];

const SOLID = new Set<number>([
  T.BUILDING, T.WALL, T.WATER, T.TREE, T.CHURCH,
  T.TOWN_HALL, T.TOWER, T.HOUSE, T.WELL, T.CASTLE_WALL,
]);
export function isSolid(t: number): boolean { return SOLID.has(t); }

// ---------------------------------------------------------------------------
// Buildings — rich metadata for client rendering.
// Collision still comes from the tile grid above; buildings are a decoration
// layer that knows how to draw pastel facades, Gothic spires, etc.
// ---------------------------------------------------------------------------
export type BuildingStyle =
  | "townhall"
  | "oleviste"
  | "pikkhermann"
  | "domechurch"
  | "merchant"
  | "tower"
  | "gate_tower";

export interface Building {
  id: string;
  name: string;
  /** tile coords (x, y) and span (w, h) */
  x: number; y: number; w: number; h: number;
  style: BuildingStyle;
  facade?: string;
  roof?: string;
  accent?: string;
  /** Gothic stepped gable stripes on top (for merchant/townhall) */
  gable?: "stepped" | "triangle" | "flat";
  /** Extra vertical pixels drawn above the tile footprint (spire height) */
  spire?: number;
  /** render label of this building on the map */
  showLabel?: boolean;
}

// Tallinn Old Town pastel facade palette (real colors of the houses).
const FACADES = [
  { facade: "#d8a785", roof: "#8e3b26", accent: "#5a2f20" }, // salmon
  { facade: "#c5bb94", roof: "#8e3b26", accent: "#5a4f2b" }, // cream
  { facade: "#a3bca1", roof: "#7a3321", accent: "#3f5a3d" }, // mint
  { facade: "#cf8a6b", roof: "#7a2f1f", accent: "#4a2418" }, // terracotta
  { facade: "#c79fa7", roof: "#6d2a1e", accent: "#4a2a2e" }, // dusty pink
  { facade: "#8a9bab", roof: "#5a2a20", accent: "#3a4654" }, // slate blue
  { facade: "#e0c58b", roof: "#8e3b26", accent: "#6a5130" }, // ochre
  { facade: "#b8a992", roof: "#6d2a1e", accent: "#4a4232" }, // stone
];

// ---------------------------------------------------------------------------
// NPC definitions — fixed roster. Positions are walkable tiles next to their
// shop/home building, with the building reference for UI labeling.
// ---------------------------------------------------------------------------
export interface NpcDef {
  id: string;
  name: string;           // display name in Estonian + English flavor
  shortName: string;      // for HUD ("Baker", "Smith")
  role: "baker" | "smith" | "apothecary" | "scribe" | "brewer"
      | "tanner" | "weaver" | "fisherman" | "crier" | "guard" | "priest";
  x: number;  // tile
  y: number;  // tile
  building: string;       // id of their home building
}

// ---------------------------------------------------------------------------
// Deterministic map generator. Same result on server and client.
// ---------------------------------------------------------------------------
export function generateMap(): number[][] {
  const m: number[][] = [];
  for (let y = 0; y < MAP_H; y++) m.push(new Array(MAP_W).fill(T.GRASS));

  // Interior default = cobblestone street.
  for (let y = 2; y < MAP_H - 2; y++)
    for (let x = 2; x < MAP_W - 2; x++)
      m[y][x] = T.STREET;

  // Toompea upper-town ground (warmer paving).
  for (let y = 2; y < 14; y++)
    for (let x = 2; x < 17; x++)
      m[y][x] = T.TOOMPEA_GROUND;

  // Perimeter city walls (double-thick).
  for (let x = 0; x < MAP_W; x++) {
    m[0][x] = T.WALL; m[1][x] = T.WALL;
    m[MAP_H - 1][x] = T.WALL; m[MAP_H - 2][x] = T.WALL;
  }
  for (let y = 0; y < MAP_H; y++) {
    m[y][0] = T.WALL; m[y][1] = T.WALL;
    m[y][MAP_W - 1] = T.WALL; m[y][MAP_W - 2] = T.WALL;
  }

  // Gates (walkable openings, flanked by round gate towers).
  // Viru Gate — north wall
  for (let x = 24; x <= 27; x++) { m[0][x] = T.GATE; m[1][x] = T.GATE; }
  m[0][23] = T.TOWER; m[1][23] = T.TOWER; m[0][28] = T.TOWER; m[1][28] = T.TOWER;
  // Harju Gate — south wall
  for (let x = 14; x <= 17; x++) { m[MAP_H - 1][x] = T.GATE; m[MAP_H - 2][x] = T.GATE; }
  m[MAP_H - 1][13] = T.TOWER; m[MAP_H - 2][13] = T.TOWER;
  m[MAP_H - 1][18] = T.TOWER; m[MAP_H - 2][18] = T.TOWER;
  // Seaward gate — east wall
  for (let y = 21; y <= 24; y++) { m[y][MAP_W - 1] = T.GATE; m[y][MAP_W - 2] = T.GATE; }

  // Round defense towers along the wall at intervals.
  const wallTowerPositions: Array<[number, number]> = [
    [2, 2], [MAP_W - 3, 2], [2, MAP_H - 3], [MAP_W - 3, MAP_H - 3],   // corners
    [10, 2], [40, 2], [2, 12], [2, 25], [MAP_W - 3, 12], [MAP_W - 3, 30], [36, MAP_H - 3],
  ];
  for (const [tx, ty] of wallTowerPositions) {
    m[ty][tx] = T.TOWER;
    if (tx + 1 < MAP_W) m[ty][tx + 1] = T.TOWER;
    if (ty + 1 < MAP_H) m[ty + 1][tx] = T.TOWER;
  }

  // ---- TOOMPEA (upper town) ----
  // Toompea castle + inner walls.
  for (let x = 3; x <= 14; x++) { m[3][x] = T.CASTLE_WALL; m[13][x] = T.CASTLE_WALL; }
  for (let y = 3; y <= 13; y++) { m[y][3] = T.CASTLE_WALL; m[y][14] = T.CASTLE_WALL; }
  // Keep interior courtyard walkable.
  for (let y = 4; y <= 12; y++)
    for (let x = 4; x <= 13; x++)
      m[y][x] = T.TOOMPEA_GROUND;
  // Inner castle gates at south edge of Toompea.
  m[13][7] = T.TOOMPEA_GROUND; m[13][8] = T.TOOMPEA_GROUND;

  // Pikk Hermann — tall round tower at NW corner of Toompea.
  for (let y = 4; y <= 6; y++)
    for (let x = 4; x <= 6; x++)
      m[y][x] = T.TOWER;

  // Dome Church (Toomkirik) — in the middle of Toompea.
  for (let y = 8; y <= 11; y++)
    for (let x = 9; x <= 12; x++)
      m[y][x] = T.CHURCH;

  // Long Leg (Pikk jalg) — street sloping down from Toompea to Lower Town.
  for (let x = 15; x <= 19; x++) m[13][x] = T.STAIRS;
  m[13][14] = T.STAIRS;
  for (let y = 13; y <= 15; y++) m[y][19] = T.STAIRS;

  // Short Leg (Lühike jalg) — a quicker stair connector.
  for (let y = 11; y <= 14; y++) m[y][15] = T.STAIRS;

  // ---- LOWER TOWN — Raekoja plats ----
  // Big plaza: cols 22-34, rows 16-22 — cobblestone.
  for (let y = 16; y <= 22; y++)
    for (let x = 22; x <= 34; x++)
      m[y][x] = T.PLAZA;

  // Raekoja kaev — the well in the middle of the plaza.
  m[19][28] = T.WELL;

  // Market stalls scattered on the square (walkable decoration).
  const stalls: Array<[number, number]> = [
    [24, 17], [30, 17], [23, 21], [32, 21], [26, 22], [33, 18],
  ];
  for (const [sx, sy] of stalls) m[sy][sx] = T.MARKET_STALL;

  // Lanterns on the plaza edge.
  const lanterns: Array<[number, number]> = [
    [22, 16], [34, 16], [22, 22], [34, 22],
  ];
  for (const [lx, ly] of lanterns) m[ly][lx] = T.LANTERN;

  // Town Hall (Raekoda) — south side of plaza, dominating landmark.
  for (let y = 23; y <= 26; y++)
    for (let x = 26; x <= 31; x++)
      m[y][x] = T.TOWN_HALL;
  // Town Hall tower footprint — extends "into" the plaza visually.
  // Keep as TOWN_HALL tiles (solid) but rendered with tall spire client-side.

  // ---- MERCHANT HOUSES ringing the plaza ----
  // North row (Pikk tänav side): rows 13-15, cols 22-34, with access lanes.
  // 3-tile wide houses, 1-tile lane between each → clear paths to Viru värav.
  const northRow = [22, 26, 30, 34];
  for (const bx of northRow) {
    for (let y = 13; y <= 15; y++)
      for (let x = bx; x <= bx + 2; x++)
        if (x < MAP_W - 2) m[y][x] = T.HOUSE;
  }

  // East row (Vene tänav side)
  for (let by = 16; by <= 30; by += 3) {
    for (let y = by; y <= by + 1; y++)
      for (let x = 36; x <= 38; x++)
        m[y][x] = T.HOUSE;
  }

  // West row (between Long Leg and plaza)
  for (let by = 16; by <= 30; by += 3) {
    for (let y = by; y <= by + 1; y++)
      for (let x = 17; x <= 19; x++)
        m[y][x] = T.HOUSE;
  }

  // South merchant row (south of Town Hall)
  for (let bx = 21; bx <= 34; bx += 4) {
    for (let y = 28; y <= 30; y++)
      for (let x = bx; x <= bx + 2; x++)
        m[y][x] = T.HOUSE;
  }

  // ---- OLEVISTE ZONE (north-east): towering church of St. Olaf ----
  // Oleviste kirik itself — 3x4 solid footprint, but its silhouette is much taller on render.
  for (let y = 8; y <= 11; y++)
    for (let x = 42; x <= 44; x++)
      m[y][x] = T.CHURCH;

  // Guild halls nearby.
  for (let y = 13; y <= 14; y++) for (let x = 41; x <= 45; x++) m[y][x] = T.HOUSE;
  for (let y = 6; y <= 7; y++) for (let x = 41; x <= 45; x++) m[y][x] = T.HOUSE;

  // ---- GREEN / TREES — small parks inside the walls ----
  const parks: Array<[number, number]> = [
    // Toompea grounds trees
    [7, 5], [10, 5], [7, 12], [12, 6],
    // Lower town park (Harju side)
    [5, 16], [6, 17], [7, 18], [8, 17], [5, 19], [6, 20],
    // Next to plaza
    [21, 27], [35, 27],
    // South
    [10, 31], [13, 30], [40, 31], [43, 30],
  ];
  for (const [tx, ty] of parks) {
    if (m[ty][tx] === T.STREET || m[ty][tx] === T.TOOMPEA_GROUND) m[ty][tx] = T.TREE;
  }

  // Sand/beach hint near seaward gate (outside but inside walls — grass area)
  // Leaving as STREET is fine for MVP.

  return m;
}

// ---------------------------------------------------------------------------
// Rich building list — same positions as the HOUSE/TOWN_HALL/CHURCH tiles above.
// Renderer uses this to paint pastel facades, stepped gables, spires, etc.
// ---------------------------------------------------------------------------
export function generateBuildings(): Building[] {
  const bs: Building[] = [];
  // Town Hall — centerpiece
  bs.push({
    id: "raekoda",
    name: "Raekoda",
    x: 26, y: 23, w: 6, h: 4,
    style: "townhall",
    facade: "#d8cfae",
    roof: "#8e3b26",
    accent: "#5a4a30",
    gable: "stepped",
    spire: 150,
    showLabel: true,
  });

  // Oleviste — St. Olaf's Church
  bs.push({
    id: "oleviste",
    name: "Oleviste",
    x: 42, y: 8, w: 3, h: 4,
    style: "oleviste",
    facade: "#9b8a78",
    roof: "#3a2418",
    accent: "#e7c258",
    spire: 210,
    showLabel: true,
  });

  // Pikk Hermann
  bs.push({
    id: "pikkhermann",
    name: "Pikk Hermann",
    x: 4, y: 4, w: 3, h: 3,
    style: "pikkhermann",
    facade: "#6a6058",
    roof: "#3a2a20",
    accent: "#e7c258",
    spire: 90,
    showLabel: true,
  });

  // Dome Church (Toomkirik)
  bs.push({
    id: "toomkirik",
    name: "Toomkirik",
    x: 9, y: 8, w: 4, h: 4,
    style: "domechurch",
    facade: "#e4dcc9",
    roof: "#7a3321",
    accent: "#c8a14a",
    showLabel: true,
  });

  // Merchant houses (north row)
  const mh = (id: string, name: string, x: number, y: number, w: number, h: number, paletteIdx: number): Building => {
    const p = FACADES[paletteIdx % FACADES.length];
    return {
      id, name, x, y, w, h,
      style: "merchant",
      facade: p.facade,
      roof: p.roof,
      accent: p.accent,
      gable: (paletteIdx % 2 === 0) ? "stepped" : "triangle",
    };
  };

  const houses: Array<{ id: string, name: string, x: number, y: number, w: number, h: number }> = [
    { id: "pagar", name: "Pagari maja", x: 22, y: 13, w: 3, h: 3 },
    { id: "kangur", name: "Kanguri maja", x: 26, y: 13, w: 3, h: 3 },
    { id: "kaupmees", name: "Suurgildi hoov", x: 30, y: 13, w: 3, h: 3 },
    { id: "kirjutaja", name: "Kirjutaja koda", x: 34, y: 13, w: 3, h: 3 },

    { id: "sepp", name: "Sepa paja", x: 36, y: 16, w: 3, h: 2 },
    { id: "parkal", name: "Parkali koda", x: 36, y: 19, w: 3, h: 2 },
    { id: "ollemeister", name: "Õllemeistri kelder", x: 36, y: 22, w: 3, h: 2 },
    { id: "kalamees", name: "Kalamehe aidad", x: 36, y: 25, w: 3, h: 2 },
    { id: "kollane", name: "Kollane maja", x: 36, y: 28, w: 3, h: 2 },

    { id: "apteek", name: "Raeapteek", x: 17, y: 16, w: 3, h: 2 },
    { id: "trukikoda", name: "Trükikoda", x: 17, y: 19, w: 3, h: 2 },
    { id: "veinikelder", name: "Veinikelder", x: 17, y: 22, w: 3, h: 2 },
    { id: "kunstniku", name: "Kunstniku koda", x: 17, y: 25, w: 3, h: 2 },
    { id: "kohvik", name: "Raekoja Kohvik", x: 17, y: 28, w: 3, h: 2 },

    { id: "sadama", name: "Sadama ait", x: 21, y: 28, w: 3, h: 3 },
    { id: "hansa", name: "Hansa kaubamaja", x: 25, y: 28, w: 3, h: 3 },
    { id: "soolaait", name: "Soolaait", x: 29, y: 28, w: 3, h: 3 },
    { id: "viinapood", name: "Viinapood", x: 33, y: 28, w: 3, h: 3 },

    { id: "oleguild", name: "Oleviste gild", x: 41, y: 6, w: 5, h: 2 },
    { id: "tsunftihoov", name: "Tsunftihoov", x: 41, y: 13, w: 5, h: 2 },
  ];
  houses.forEach((h, i) => bs.push(mh(h.id, h.name, h.x, h.y, h.w, h.h, i)));

  return bs;
}

// Plaza hub NPCs — pure flavor. They stand around for atmosphere, no quests.
// A couple of them are vendors (see room logic); the rest are decoration.
export function getNpcDefs(): NpcDef[] {
  return [
    { id: "npc_sepp",       name: "Sepa Jakob",        shortName: "Smith",        role: "smith",     x: 35, y: 17, building: "sepp" },
    { id: "npc_apteeker",   name: "Apteeker Maria",    shortName: "Apothecary",   role: "apothecary",x: 20, y: 17, building: "apteek" },
    { id: "npc_ollemeister",name: "Õllemeister Peep",  shortName: "Brewer",       role: "brewer",    x: 35, y: 23, building: "ollemeister" },
    { id: "npc_kuulutaja",  name: "Kuulutaja Hendrik", shortName: "Herald",       role: "crier",     x: 28, y: 20, building: "raekoda" },
    { id: "npc_preester",   name: "Preester Erik",     shortName: "Priest",       role: "priest",    x: 11, y: 12, building: "toomkirik" },
  ];
}

// ---------------------------------------------------------------------------
// Safe zone (Raekoja plats + immediate hub). Inside this rectangle:
//   - no enemy spawns
//   - players cannot take damage (PvE or PvP)
//   - extraction happens when a player crosses back in with a pack
// ---------------------------------------------------------------------------
export const SAFE_ZONE = { x0: 20, y0: 14, x1: 36, y1: 24 } as const;  // tile bounds (inclusive)

export function isSafePx(px: number, py: number): boolean {
  const tx = px / TILE_SIZE;
  const ty = py / TILE_SIZE;
  return tx >= SAFE_ZONE.x0 && tx <= SAFE_ZONE.x1 + 1 && ty >= SAFE_ZONE.y0 && ty <= SAFE_ZONE.y1 + 1;
}

export function isSafeTile(tx: number, ty: number): boolean {
  return tx >= SAFE_ZONE.x0 && tx <= SAFE_ZONE.x1 && ty >= SAFE_ZONE.y0 && ty <= SAFE_ZONE.y1;
}

// Enemy spawn anchors — hand-picked walkable street/alley/courtyard tiles
// spread around the city, biased AWAY from the plaza so the hub stays calm.
export function getEnemyAnchors(): Array<{ x: number; y: number; kinds: string[] }> {
  return [
    // Toompea courtyard
    { x: 7,  y: 6,  kinds: ["revenant", "bandit"] },
    { x: 11, y: 5,  kinds: ["revenant"] },
    { x: 5,  y: 9,  kinds: ["revenant", "archer"] },
    { x: 12, y: 10, kinds: ["bandit", "archer"] },
    // Between Toompea and plaza (streets around Pikk jalg)
    { x: 16, y: 16, kinds: ["bandit", "revenant"] },
    { x: 14, y: 22, kinds: ["bandit"] },
    { x: 10, y: 22, kinds: ["revenant"] },
    // South side
    { x: 6,  y: 28, kinds: ["revenant", "bandit"] },
    { x: 13, y: 32, kinds: ["bandit", "archer"] },
    { x: 22, y: 32, kinds: ["revenant", "rival"] },
    { x: 30, y: 32, kinds: ["bandit", "archer"] },
    { x: 40, y: 32, kinds: ["revenant", "bandit"] },
    // East / Oleviste district
    { x: 40, y: 10, kinds: ["revenant", "archer", "rival"] },
    { x: 47, y: 10, kinds: ["bandit", "archer"] },
    { x: 47, y: 22, kinds: ["bandit", "rival"] },
    { x: 47, y: 30, kinds: ["revenant"] },
    // Outer lanes
    { x: 4,  y: 18, kinds: ["bandit"] },
    { x: 4,  y: 26, kinds: ["revenant"] },
  ];
}

// Loot-chest anchors — places where rolls of loot bags can auto-spawn over time
// (random treasure, not tied to enemies).
export function getLootAnchors(): Array<{ x: number; y: number }> {
  return [
    { x: 7,  y: 8 },   // Toompea courtyard
    { x: 11, y: 6 },
    { x: 13, y: 22 },  // alley near Pikk jalg
    { x: 8,  y: 30 },  // south side
    { x: 22, y: 32 },
    { x: 40, y: 6 },   // Oleviste gate area
    { x: 44, y: 18 },  // east wall alley
    { x: 40, y: 30 },
  ];
}

// Player AABB + physical constants (shared so client prediction matches server).
export const PLAYER_SIZE = 22;
export const PLAYER_WALK_SPEED = 170;
export const PLAYER_SPRINT_SPEED = 260;
export const STAMINA_MAX = 1.0;
export const STAMINA_DRAIN = 0.45; // per sec while sprinting
export const STAMINA_REGEN = 0.3;  // per sec while not sprinting

// ---------------------------------------------------------------------------
// AABB tile collision.
// ---------------------------------------------------------------------------
export function collides(map: number[][], px: number, py: number, w: number, h: number): boolean {
  const left = Math.floor(px / TILE_SIZE);
  const right = Math.floor((px + w - 1) / TILE_SIZE);
  const top = Math.floor(py / TILE_SIZE);
  const bottom = Math.floor((py + h - 1) / TILE_SIZE);
  for (let ty = top; ty <= bottom; ty++) {
    for (let tx = left; tx <= right; tx++) {
      if (ty < 0 || ty >= MAP_H || tx < 0 || tx >= MAP_W) return true;
      if (isSolid(map[ty][tx])) return true;
    }
  }
  return false;
}

// World pixel center of a tile.
export function tileCenterPx(tx: number, ty: number): { x: number; y: number } {
  return { x: tx * TILE_SIZE + TILE_SIZE / 2, y: ty * TILE_SIZE + TILE_SIZE / 2 };
}
