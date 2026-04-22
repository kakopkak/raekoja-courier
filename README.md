# Raekoja Courier

A browser-based multiplayer delivery game set in a stylized medieval **Tallinn Old Town**. Run between Raekoja plats, Toompea, Oleviste and the merchant houses, deliver parcels before they expire, chain deliveries to build combo multipliers, and climb from *Õpipoiss* to *Rae sündik*.

**Live:** http://165.245.213.183/

Built solo/session-based, up to 8 players per room. 2–6 is the sweet spot — you compete for the same orders in real time.

## Stack

- **Server** — [Colyseus 0.16](https://colyseus.io) on Node 22 (TypeScript). Authoritative simulation at 20 Hz, WebSocket transport, schema-based delta sync.
- **Client** — [Phaser 3](https://phaser.io) + Vite + TypeScript. Client-side prediction with reconciliation.
- **Shared** — `src/shared/map.ts` is byte-identical on both sides for deterministic collision.
- **Host** — single DigitalOcean Droplet (`s-1vcpu-1gb`, Frankfurt), systemd, port 80. Client static assets served by the same Node process.

## Game design

- Server spawns ~6 orders at a time between 12 NPCs (baker, smith, apothecary, scribe, brewer, tanner, weaver, fisherman, priest, crier, guard, abbot).
- Walk onto an NPC with a golden `!` to accept an order. A waypoint arrow guides you to the destination. Deliver before the timer runs out for marks.
- Combo multiplier `1 + combo × 0.25` stacks with each delivery within 15 s of the last. Time-bonus for early arrival.
- Sprint with **Shift** — drains stamina; regens when walking/idle.
- Carrying a package slows you 8%. Strategic routing > raw speed.

## Layout

```
game4/
├── server/                   Colyseus server (TypeScript, ESM)
│   ├── src/
│   │   ├── index.ts          http + Colyseus bootstrap
│   │   ├── rooms/TallinnRoom.ts   authoritative game logic
│   │   ├── schema/GameState.ts    Player/Npc/Order + MapSchemas
│   │   └── shared/map.ts          tile grid + buildings + NPC defs
│   └── check-map.mjs         BFS reachability assertion
├── client/                   Vite + Phaser 3 (TypeScript)
│   ├── index.html            menu, HUD, score card, minimap
│   └── src/
│       ├── main.ts           scene, prediction, rendering, juice
│       └── shared/map.ts     (copy of server's — must stay in sync)
└── deploy/
    ├── build-local.sh        pre-build both apps + tarball release
    ├── cloud-init-slim.sh    minimal first-boot for the droplet
    ├── deploy2.sh            cold deploy: create droplet → SCP → start
    └── redeploy.sh           hot deploy: rebuild + SCP to existing droplet
```

## Develop

```bash
# Terminal 1 — server
cd server && npm install && npm run dev

# Terminal 2 — client (Vite proxies /matchmake to :2567)
cd client && npm install && npm run dev

# Open http://localhost:5173
```

## Deploy

Cold deploy (fresh droplet):

```bash
export DO_TOKEN=your_digitalocean_pat
bash deploy/deploy2.sh
```

Hot redeploy to existing droplet:

```bash
export DO_TOKEN=your_digitalocean_pat
bash deploy/redeploy.sh
```

## Notable choices

- **No DB** — session-based; all state lives in memory in the Colyseus room.
- **Authoritative server from day 1** — cheap-per-frame because Colyseus handles delta sync, and saves a painful refactor later.
- **Pre-build locally, SCP to box** — a 1 GB droplet can't survive Vite bundling Phaser without thrashing.
- **Map duplicated in two places** — avoids tsconfig path tricks; there's a `check-map.mjs` reachability gate to catch drift.
- **Colyseus monitor** mounted at `/colyseus` — convenient for debugging, lock it down before production traffic.

## License

MIT. Map concept pays homage to Tallinn's Old Town; no OSM data or Google tiles are used.
