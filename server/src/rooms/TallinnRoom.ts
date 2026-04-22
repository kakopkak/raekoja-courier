import { Room, Client } from "@colyseus/core";
import { GameState, Player, Npc, Order } from "../schema/GameState.js";
import {
  generateMap,
  collides,
  getNpcDefs,
  ITEMS,
  TILE_SIZE,
  MAP_W,
  MAP_H,
  PLAYER_SIZE,
  PLAYER_WALK_SPEED,
  PLAYER_SPRINT_SPEED,
  STAMINA_MAX,
  STAMINA_DRAIN,
  STAMINA_REGEN,
  tileCenterPx,
  T,
} from "../shared/map.js";

interface InputMsg {
  seq: number;
  up?: boolean;
  down?: boolean;
  left?: boolean;
  right?: boolean;
  sprint?: boolean;
  dt: number; // seconds, clamped
}

const PALETTE = [
  "#e76f51", "#f4a261", "#e9c46a", "#2a9d8f",
  "#264653", "#b5838d", "#ffb4a2", "#457b9d",
];

const COMBO_WINDOW_MS = 15_000;
const ORDER_TTL_MS = 60_000;
const MAX_ACTIVE_ORDERS = 6;
const NEW_ORDER_INTERVAL_MS = 6_000;
const INTERACT_RADIUS_PX = 40;

export class TallinnRoom extends Room<GameState> {
  maxClients = 8;
  state = new GameState();

  private map: number[][] = [];
  private inputsByClient = new Map<string, InputMsg[]>();
  private paletteIndex = 0;
  private nextOrderAt = 0;
  private spawnSafeTiles: Array<[number, number]> = [];

  onCreate() {
    this.map = generateMap();
    this.autoDispose = true;

    // Precompute safe spawn tiles: PLAZA tiles, avoiding WELL / STALL.
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        if (this.map[y][x] === T.PLAZA) this.spawnSafeTiles.push([x, y]);
      }
    }

    // Seed NPCs from map defs.
    for (const def of getNpcDefs()) {
      const n = new Npc();
      n.id = def.id;
      n.name = def.name;
      n.shortName = def.shortName;
      n.role = def.role;
      const c = tileCenterPx(def.x, def.y);
      n.x = c.x;
      n.y = c.y;
      this.state.npcs.set(n.id, n);
    }

    // Fixed 20 Hz simulation.
    this.setSimulationInterval((dt) => this.update(dt), 1000 / 20);

    this.onMessage<InputMsg>("input", (client, msg) => {
      if (!msg || typeof msg.seq !== "number") return;
      const q = this.inputsByClient.get(client.sessionId);
      if (!q) return;
      msg.dt = Math.max(0, Math.min(msg.dt ?? 0.05, 0.1));
      q.push(msg);
      if (q.length > 120) q.splice(0, q.length - 120);
    });

    this.onMessage<string>("chat", (client, text) => {
      if (typeof text !== "string") return;
      const clean = text.slice(0, 140).trim();
      if (!clean) return;
      const p = this.state.players.get(client.sessionId);
      const from = p?.name || "anon";
      this.broadcast("chat", { from, text: clean, at: Date.now() });
    });

    console.log(`[TallinnRoom] created with ${this.state.npcs.size} NPCs`);
  }

  onJoin(client: Client, options: { name?: string }) {
    const name =
      (options?.name || "guest")
        .slice(0, 16)
        .replace(/[^\p{L}\p{N}_ -]/gu, "") || "guest";

    const p = new Player();
    p.id = client.sessionId;
    p.name = name;
    p.color = PALETTE[this.paletteIndex++ % PALETTE.length];

    // Random safe tile in the plaza.
    const slot =
      this.spawnSafeTiles[Math.floor(Math.random() * this.spawnSafeTiles.length)];
    const c = tileCenterPx(slot[0], slot[1]);
    p.x = c.x - PLAYER_SIZE / 2;
    p.y = c.y - PLAYER_SIZE / 2;
    p.stamina = STAMINA_MAX;

    this.state.players.set(client.sessionId, p);
    this.inputsByClient.set(client.sessionId, []);

    // Welcome + quick tutorial message.
    this.broadcast("chat", {
      from: "Raad",
      text: `${name} astub Raekoja platsile.`,
      at: Date.now(),
      kind: "system",
    });

    console.log(
      `[TallinnRoom ${this.roomId}] ${name} (${client.sessionId}) joined — ${this.state.players.size} online`
    );
  }

  onLeave(client: Client) {
    // If they were carrying an order, free it.
    const p = this.state.players.get(client.sessionId);
    if (p?.carryingOrderId) {
      const o = this.state.orders.get(p.carryingOrderId);
      if (o) {
        o.status = "available";
        o.carrierId = "";
        const fromNpc = this.state.npcs.get(o.fromNpcId);
        if (fromNpc) fromNpc.activeOrderId = o.id;
      }
    }
    this.state.players.delete(client.sessionId);
    this.inputsByClient.delete(client.sessionId);
    console.log(
      `[TallinnRoom ${this.roomId}] ${client.sessionId} left — ${this.state.players.size} online`
    );
  }

  // =========================================================================
  // Main tick
  // =========================================================================
  private update(_dtMs: number) {
    const now = Date.now();
    this.state.serverNow = now;
    this.state.tick++;

    // Day phase — full cycle every 5 minutes, purely cosmetic.
    this.state.dayPhase = ((now / 1000) % 300) / 300;

    // --- Players: movement + stamina ---
    for (const [sid, player] of this.state.players.entries()) {
      this.stepPlayer(sid, player, now);
    }

    // --- Combo expiration ---
    for (const player of this.state.players.values()) {
      if (player.combo > 0 && now > player.comboExpiresAt) {
        player.combo = 0;
      }
    }

    // --- Order interactions (pickup / dropoff) ---
    for (const player of this.state.players.values()) {
      if (player.carryingOrderId) {
        this.tryDeliver(player, now);
      } else {
        this.tryPickup(player, now);
      }
    }

    // --- Expire old orders ---
    for (const [oid, order] of this.state.orders.entries()) {
      if (order.status === "available" && now > order.expiresAt) {
        order.status = "expired";
        const npc = this.state.npcs.get(order.fromNpcId);
        if (npc && npc.activeOrderId === oid) npc.activeOrderId = "";
        this.broadcast("order_expired", { fromNpc: npc?.shortName, item: order.itemEn });
        // Delete a tick later so the client has time to react.
        setTimeout(() => this.state.orders.delete(oid), 500);
      }
      if (order.status === "delivered") {
        // Delete immediately — the delivery event already fired.
        this.state.orders.delete(oid);
      }
    }

    // --- Spawn new orders ---
    if (now >= this.nextOrderAt && this.countAvailableOrders() < MAX_ACTIVE_ORDERS) {
      this.trySpawnOrder(now);
      this.nextOrderAt = now + NEW_ORDER_INTERVAL_MS - Math.floor(Math.random() * 2000);
    }
  }

  // =========================================================================
  // Player stepping
  // =========================================================================
  private stepPlayer(sid: string, player: Player, _now: number) {
    const q = this.inputsByClient.get(sid);
    if (!q || q.length === 0) {
      player.vx = 0; player.vy = 0; player.sprinting = false;
      // Regen stamina when idle.
      player.stamina = Math.min(STAMINA_MAX, player.stamina + STAMINA_REGEN * 0.05);
      return;
    }

    let lastVx = 0, lastVy = 0, sprinting = false;
    for (const input of q) {
      let dx = 0, dy = 0;
      if (input.left) dx -= 1;
      if (input.right) dx += 1;
      if (input.up) dy -= 1;
      if (input.down) dy += 1;
      if (dx !== 0 && dy !== 0) {
        const inv = 1 / Math.sqrt(2); dx *= inv; dy *= inv;
      }

      // Sprint logic: wanted + stamina available.
      const wantSprint = !!input.sprint && (dx !== 0 || dy !== 0);
      let speed = PLAYER_WALK_SPEED;
      if (wantSprint && player.stamina > 0.02) {
        speed = PLAYER_SPRINT_SPEED;
        player.stamina = Math.max(0, player.stamina - STAMINA_DRAIN * input.dt);
        sprinting = true;
      } else {
        player.stamina = Math.min(STAMINA_MAX, player.stamina + STAMINA_REGEN * input.dt);
      }

      // Carrying a package slows the player slightly (realism + balance).
      if (player.carryingOrderId) speed *= 0.92;

      const stepX = dx * speed * input.dt;
      const stepY = dy * speed * input.dt;

      const nx = player.x + stepX;
      if (!collides(this.map, nx, player.y, PLAYER_SIZE, PLAYER_SIZE)) player.x = nx;
      const ny = player.y + stepY;
      if (!collides(this.map, player.x, ny, PLAYER_SIZE, PLAYER_SIZE)) player.y = ny;

      lastVx = stepX / Math.max(0.0001, input.dt);
      lastVy = stepY / Math.max(0.0001, input.dt);

      if (dx !== 0 || dy !== 0) {
        if (Math.abs(dx) > Math.abs(dy)) player.facing = dx > 0 ? 3 : 2;
        else player.facing = dy > 0 ? 0 : 1;
      }

      player.lastProcessedInput = input.seq;
    }
    q.length = 0;

    player.x = Math.max(0, Math.min(player.x, MAP_W * TILE_SIZE - PLAYER_SIZE));
    player.y = Math.max(0, Math.min(player.y, MAP_H * TILE_SIZE - PLAYER_SIZE));
    player.vx = lastVx;
    player.vy = lastVy;
    player.sprinting = sprinting;
  }

  // =========================================================================
  // Delivery game logic
  // =========================================================================
  private countAvailableOrders(): number {
    let c = 0;
    for (const o of this.state.orders.values())
      if (o.status === "available") c++;
    return c;
  }

  private trySpawnOrder(now: number) {
    // Candidate "from" NPCs: no active order.
    const fromCandidates: Npc[] = [];
    for (const n of this.state.npcs.values())
      if (!n.activeOrderId) fromCandidates.push(n);
    if (fromCandidates.length < 2) return;

    const from = fromCandidates[Math.floor(Math.random() * fromCandidates.length)];
    const others = fromCandidates.filter((n) => n.id !== from.id);
    const to = others[Math.floor(Math.random() * others.length)];
    const item = ITEMS[Math.floor(Math.random() * ITEMS.length)];

    // Reward scales with distance.
    const dxTiles = Math.abs(from.x - to.x) / TILE_SIZE;
    const dyTiles = Math.abs(from.y - to.y) / TILE_SIZE;
    const manhattan = dxTiles + dyTiles;
    const reward = Math.round(6 + manhattan * 0.55);

    const id = `o_${now}_${Math.floor(Math.random() * 9999)}`;
    const o = new Order();
    o.id = id;
    o.fromNpcId = from.id;
    o.toNpcId = to.id;
    o.itemName = item.name;
    o.itemEn = item.en;
    o.reward = reward;
    o.status = "available";
    o.createdAt = now;
    o.expiresAt = now + ORDER_TTL_MS;

    this.state.orders.set(id, o);
    from.activeOrderId = id;

    this.broadcast("order_new", {
      from: from.shortName,
      to: to.shortName,
      item: item.en,
      reward,
    });
  }

  private tryPickup(player: Player, now: number) {
    // Player must be near an NPC that has an activeOrderId with status=available.
    for (const npc of this.state.npcs.values()) {
      if (!npc.activeOrderId) continue;
      const order = this.state.orders.get(npc.activeOrderId);
      if (!order || order.status !== "available") continue;

      const pcx = player.x + PLAYER_SIZE / 2;
      const pcy = player.y + PLAYER_SIZE / 2;
      const dx = pcx - npc.x;
      const dy = pcy - npc.y;
      if (dx * dx + dy * dy <= INTERACT_RADIUS_PX * INTERACT_RADIUS_PX) {
        order.status = "carried";
        order.carrierId = player.id;
        npc.activeOrderId = "";
        player.carryingOrderId = order.id;
        this.broadcast("order_pickup", {
          playerId: player.id, playerName: player.name,
          from: npc.shortName, to: this.state.npcs.get(order.toNpcId)?.shortName,
          item: order.itemEn, reward: order.reward,
        });
        return;
      }
    }
  }

  private tryDeliver(player: Player, now: number) {
    const order = this.state.orders.get(player.carryingOrderId);
    if (!order) {
      player.carryingOrderId = "";
      return;
    }
    const dst = this.state.npcs.get(order.toNpcId);
    if (!dst) return;

    const pcx = player.x + PLAYER_SIZE / 2;
    const pcy = player.y + PLAYER_SIZE / 2;
    const dx = pcx - dst.x;
    const dy = pcy - dst.y;
    if (dx * dx + dy * dy > INTERACT_RADIUS_PX * INTERACT_RADIUS_PX) return;

    // Delivery! Compute payout with combo multiplier.
    const multiplier = 1 + player.combo * 0.25;
    const timeBonus =
      order.expiresAt - now > 20_000
        ? 3  // arrived with plenty of time — +3 flat
        : 0;
    const payout = Math.round((order.reward + timeBonus) * multiplier);

    player.score += payout;
    player.deliveries += 1;
    player.combo += 1;
    player.comboExpiresAt = now + COMBO_WINDOW_MS;
    player.carryingOrderId = "";

    order.status = "delivered";

    this.broadcast("order_delivered", {
      playerId: player.id,
      playerName: player.name,
      to: dst.shortName,
      item: order.itemEn,
      payout,
      multiplier: Number(multiplier.toFixed(2)),
      combo: player.combo,
      score: player.score,
    });
  }
}
