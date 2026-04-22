// Verify every NPC is mutually reachable on the map and none stand on solid tiles.
import { generateMap, getNpcDefs, isSolid, MAP_W, MAP_H, TILE_SIZE, PLAYER_SIZE } from "./dist/shared/map.js";

const m = generateMap();
const npcs = getNpcDefs();

function canStand(px, py) {
  // AABB version used by server
  const left = Math.floor(px / TILE_SIZE);
  const right = Math.floor((px + PLAYER_SIZE - 1) / TILE_SIZE);
  const top = Math.floor(py / TILE_SIZE);
  const bottom = Math.floor((py + PLAYER_SIZE - 1) / TILE_SIZE);
  for (let ty = top; ty <= bottom; ty++)
    for (let tx = left; tx <= right; tx++) {
      if (tx < 0 || tx >= MAP_W || ty < 0 || ty >= MAP_H) return false;
      if (isSolid(m[ty][tx])) return false;
    }
  return true;
}

// Flood fill from the first NPC's tile at player-size granularity.
function bfsReachable(startTx, startTy) {
  const seen = new Uint8Array(MAP_W * MAP_H);
  const idx = (x, y) => y * MAP_W + x;
  const q = [[startTx, startTy]];
  seen[idx(startTx, startTy)] = 1;
  while (q.length) {
    const [x, y] = q.pop();
    const n = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
    for (const [nx, ny] of n) {
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
      if (seen[idx(nx, ny)]) continue;
      if (isSolid(m[ny][nx])) continue;
      // Extra check: can a player AABB fit here without clipping.
      const px = nx * TILE_SIZE + (TILE_SIZE - PLAYER_SIZE) / 2;
      const py = ny * TILE_SIZE + (TILE_SIZE - PLAYER_SIZE) / 2;
      if (!canStand(px, py)) continue;
      seen[idx(nx, ny)] = 1;
      q.push([nx, ny]);
    }
  }
  return seen;
}

let fail = 0;
// Start from a plaza tile.
const seen = bfsReachable(25, 19);
for (const n of npcs) {
  const standable = canStand(
    n.x * TILE_SIZE + (TILE_SIZE - PLAYER_SIZE) / 2,
    n.y * TILE_SIZE + (TILE_SIZE - PLAYER_SIZE) / 2,
  );
  const reachable = seen[n.y * MAP_W + n.x] === 1;
  const tileCode = m[n.y][n.x];
  console.log(
    `${reachable && standable ? "OK " : "FAIL"}  ${n.shortName.padEnd(14)} @(${n.x},${n.y}) tile=${tileCode} standable=${standable} reachable=${reachable}`,
  );
  if (!reachable || !standable) fail++;
}
console.log(`---`);
console.log(fail === 0 ? "All NPCs reachable and standable." : `${fail} NPC(s) broken.`);
process.exit(fail === 0 ? 0 : 1);
