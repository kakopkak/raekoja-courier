import { Room, Client } from "@colyseus/core";
import { ArraySchema, MapSchema } from "@colyseus/schema";
import {
  GameState, Player, Enemy, Item, LootBag, Projectile,
} from "../schema/GameState.js";
import {
  generateMap, collides, getNpcDefs, getEnemyAnchors, getLootAnchors,
  SAFE_ZONE, isSafeTile, TILE_SIZE, MAP_W, MAP_H,
  PLAYER_SIZE, PLAYER_WALK_SPEED, PLAYER_SPRINT_SPEED,
  STAMINA_MAX, STAMINA_DRAIN, STAMINA_REGEN,
  tileCenterPx, T,
} from "../shared/map.js";
import {
  rollLoot, rollAny, rollWeapon, rollConsumable, makeStarterWeapon, summariseItem,
} from "../game/items.js";

// ---------------------------------------------------------------------------
// Tuning
// ---------------------------------------------------------------------------
const TICK_HZ = 20;
const SIM_DT_MS = 1000 / TICK_HZ;

const PLAYER_HP_MAX_BASE = 100;
const ATTACK_COOLDOWN_DEFAULT = 0.45;  // seconds
const ATTACK_SWING_MS = 160;
const DASH_DURATION_MS = 180;
const DASH_COOLDOWN_MS = 900;
const DASH_SPEED = 520;
const DASH_INVULN_MS = 220;
const RESPAWN_MS = 3500;

const ENEMY_CAP = 22;
const ENEMY_SPAWN_INTERVAL_MS = 2200;
const ENEMY_RESPAWN_DELAY_MS = 8000;
const LOOT_EXPIRE_MS = 90_000;
const LOOT_BAG_CAP = 60;
const LOOT_AUTO_SPAWN_MS = 22_000;
const PACK_MAX = 8;
const STASH_MAX = 32;

const PROJECTILE_TTL_MS = 1600;
const ARCHER_SHOT_COOLDOWN_MS = 2200;
const ARCHER_RANGE = 300;
const ARCHER_ARROW_SPEED = 340;

// Enemy archetype stats
type EnemyKind = "revenant" | "bandit" | "archer" | "rival" | "elite";
const ENEMY_STATS: Record<EnemyKind, { hp: number; dmg: number; speed: number; aggroRange: number; atkRange: number; atkCooldownMs: number; label: string; }> = {
  revenant: { hp: 32, dmg: 8,  speed: 80,  aggroRange: 180, atkRange: 32, atkCooldownMs: 1100, label: "Revenant" },
  bandit:   { hp: 60, dmg: 14, speed: 130, aggroRange: 260, atkRange: 36, atkCooldownMs: 900,  label: "Bandit"   },
  archer:   { hp: 44, dmg: 12, speed: 100, aggroRange: 320, atkRange: 320,atkCooldownMs: ARCHER_SHOT_COOLDOWN_MS, label: "Archer" },
  rival:    { hp: 110,dmg: 22, speed: 150, aggroRange: 320, atkRange: 42, atkCooldownMs: 750,  label: "Rival"    },
  elite:    { hp: 220,dmg: 30, speed: 120, aggroRange: 380, atkRange: 52, atkCooldownMs: 900,  label: "Captain"  },
};

const PALETTE = ["#e76f51", "#f4a261", "#e9c46a", "#2a9d8f", "#b5838d", "#ffb4a2", "#457b9d"];

// ---------------------------------------------------------------------------
// Per-client transient state
// ---------------------------------------------------------------------------
interface InputMsg {
  seq: number;
  up?: boolean; down?: boolean; left?: boolean; right?: boolean; sprint?: boolean;
  dt: number;
}

// Persistent stash per nickname (per room, in-memory between sessions in that room).
interface StashEntry { items: Item[]; gold: number; }

export class TallinnRoom extends Room<GameState> {
  maxClients = 8;
  state = new GameState();

  private map: number[][] = [];
  private inputsByClient = new Map<string, InputMsg[]>();
  private paletteIndex = 0;

  // tracking
  private enemyAtkCooldown = new Map<string, number>();   // enemyId → nextAttackAt ms
  private playerAtkCooldown = new Map<string, number>();  // sessionId → nextAttackAt ms
  private playerDashCooldown = new Map<string, number>(); // sessionId → nextDashAt ms
  private deadEnemyClearAt = new Map<string, number>();   // enemyId → delete after ms

  // persistent stash per player name (keeps loot between runs in same room)
  private stashByName = new Map<string, StashEntry>();

  private nextEnemySpawnAt = 0;
  private nextLootSpawnAt = 0;
  private spawnCounter = 0;

  onCreate() {
    this.map = generateMap();
    this.autoDispose = true;

    // Seed flavor NPCs as non-hostile entities in the plaza.
    for (const def of getNpcDefs()) {
      const n = new Enemy();
      n.id = def.id;
      n.kind = "merchant";
      n.shortName = def.shortName;
      const c = tileCenterPx(def.x, def.y);
      n.x = c.x; n.y = c.y;
      n.hp = 9999; n.hpMax = 9999;       // invulnerable
      n.state = "idle";
      this.state.enemies.set(n.id, n);
    }

    // Simulation
    this.setSimulationInterval((_dt) => this.update(), SIM_DT_MS);

    // Seed first enemy spawn wave.
    this.nextEnemySpawnAt = Date.now() + 500;
    this.nextLootSpawnAt = Date.now() + 4_000;

    // ---------------- Message handlers ----------------
    this.onMessage<InputMsg>("input", (client, msg) => {
      if (!msg || typeof msg.seq !== "number") return;
      const q = this.inputsByClient.get(client.sessionId);
      if (!q) return;
      msg.dt = Math.max(0, Math.min(msg.dt ?? 0.05, 0.1));
      q.push(msg);
      if (q.length > 120) q.splice(0, q.length - 120);
    });

    this.onMessage<{ aim: number }>("attack", (client, msg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.deadUntil) return;
      const now = Date.now();
      const next = this.playerAtkCooldown.get(client.sessionId) || 0;
      if (now < next) return;

      const wpn = p.equipped.get("weapon");
      const speed = wpn?.attackSpeed ?? ATTACK_COOLDOWN_DEFAULT;
      this.playerAtkCooldown.set(client.sessionId, now + Math.round(speed * 1000));
      p.attackStart = now;
      p.attackEnd = now + ATTACK_SWING_MS;
      if (typeof msg?.aim === "number") p.aimAngle = msg.aim;
      else p.aimAngle = this.facingToAngle(p.facing);

      this.resolveSwing(p, client.sessionId);
    });

    this.onMessage<{ aim?: number }>("dash", (client, msg) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.deadUntil) return;
      const now = Date.now();
      const next = this.playerDashCooldown.get(client.sessionId) || 0;
      if (now < next) return;
      if (p.stamina < 0.2) return;
      p.stamina = Math.max(0, p.stamina - 0.35);
      this.playerDashCooldown.set(client.sessionId, now + DASH_COOLDOWN_MS);
      p.dashEnd = now + DASH_DURATION_MS;
      p.invulnUntil = Math.max(p.invulnUntil, now + DASH_INVULN_MS);
      if (typeof msg?.aim === "number") p.aimAngle = msg.aim;
    });

    this.onMessage<number>("equip", (client, itemIdx) => {
      // Index into player's pack. Equip to its slot.
      const p = this.state.players.get(client.sessionId);
      if (!p || p.deadUntil) return;
      if (typeof itemIdx !== "number" || itemIdx < 0 || itemIdx >= p.pack.length) return;
      this.equipFromPack(p, itemIdx);
    });

    this.onMessage<number>("use", (client, itemIdx) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.deadUntil) return;
      if (typeof itemIdx !== "number" || itemIdx < 0 || itemIdx >= p.pack.length) return;
      const it = p.pack[itemIdx];
      if (!it || it.slot !== "consumable") return;
      if (it.healAmount > 0) {
        const before = p.hp;
        p.hp = Math.min(p.hpMax, p.hp + it.healAmount);
        this.broadcast("fx", { t: "heal", x: p.x + PLAYER_SIZE / 2, y: p.y, amount: p.hp - before });
      }
      p.pack.splice(itemIdx, 1);
    });

    this.onMessage<string>("unequip", (client, slot) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.deadUntil) return;
      if (typeof slot !== "string") return;
      const eq = p.equipped.get(slot);
      if (!eq) return;
      if (p.pack.length >= PACK_MAX) return;
      p.equipped.delete(slot);
      p.pack.push(eq);
      this.recomputePlayerStats(p);
    });

    this.onMessage<string>("chat", (client, text) => {
      if (typeof text !== "string") return;
      const clean = text.slice(0, 140).trim();
      if (!clean) return;
      const p = this.state.players.get(client.sessionId);
      const from = p?.name || "anon";
      this.broadcast("chat", { from, text: clean, at: Date.now() });
    });

    console.log(`[TallinnRoom] created with ${getNpcDefs().length} flavor NPCs`);
  }

  // =========================================================================
  onJoin(client: Client, options: { name?: string; cls?: string }) {
    const name = (options?.name || "guest").slice(0, 16).replace(/[^\p{L}\p{N}_ -]/gu, "") || "guest";
    const p = new Player();
    p.id = client.sessionId;
    p.name = name;
    p.color = PALETTE[this.paletteIndex++ % PALETTE.length];
    p.className = (options?.cls === "ranger" || options?.cls === "brawler") ? options.cls : "wanderer";

    // Spawn in the plaza, centered near the well.
    const c = tileCenterPx(26 + (Math.floor(Math.random() * 6) - 3), 20);
    p.x = c.x - PLAYER_SIZE / 2;
    p.y = c.y - PLAYER_SIZE / 2;

    // Starter weapon + restore stash
    p.equipped.set("weapon", makeStarterWeapon());
    const stash = this.stashByName.get(name);
    if (stash) {
      p.gold = stash.gold;
      for (const it of stash.items.slice(0, STASH_MAX)) {
        const copy = this.cloneItem(it);
        p.stash.push(copy);
      }
    }
    this.recomputePlayerStats(p);
    p.hp = p.hpMax;

    this.state.players.set(client.sessionId, p);
    this.inputsByClient.set(client.sessionId, []);

    this.broadcast("chat", {
      from: "Raad",
      text: `${name} jõudis Raekoja platsile. Waters are dangerous beyond the gates.`,
      at: Date.now(), kind: "system",
    });
    console.log(`[room ${this.roomId}] ${name} joined`);
  }

  onLeave(client: Client) {
    const p = this.state.players.get(client.sessionId);
    if (p) {
      // Persist stash by name so re-joins pick up where they left off.
      this.stashByName.set(p.name, {
        gold: p.gold,
        items: p.stash.map((i) => this.cloneItem(i)),
      });
    }
    this.state.players.delete(client.sessionId);
    this.inputsByClient.delete(client.sessionId);
    console.log(`[room ${this.roomId}] ${client.sessionId} left (${this.state.players.size} online)`);
  }

  // =========================================================================
  // Main tick
  // =========================================================================
  private update() {
    const now = Date.now();
    this.state.serverNow = now;
    this.state.tick++;
    this.state.dayPhase = ((now / 1000) % 300) / 300;

    for (const [sid, p] of this.state.players.entries()) this.stepPlayer(sid, p, now);
    for (const [id, e] of this.state.enemies.entries()) this.stepEnemy(id, e, now);
    this.stepProjectiles(now);

    // Extraction + safe-zone tagging
    for (const [, p] of this.state.players.entries()) this.updateRunState(p, now);

    // Revive dead
    for (const [sid, p] of this.state.players.entries()) {
      if (p.deadUntil && now >= p.deadUntil) this.respawnPlayer(p);
    }

    // Enemy spawn pacing
    if (now >= this.nextEnemySpawnAt && this.countLiveEnemies() < ENEMY_CAP) {
      this.trySpawnEnemy(now);
      this.nextEnemySpawnAt = now + ENEMY_SPAWN_INTERVAL_MS - Math.floor(Math.random() * 500);
    }

    // Scheduled enemy cleanup
    for (const [id, deleteAt] of this.deadEnemyClearAt.entries()) {
      if (now >= deleteAt) {
        this.state.enemies.delete(id);
        this.deadEnemyClearAt.delete(id);
      }
    }

    // Expire loot bags
    for (const [lid, bag] of this.state.loot.entries()) {
      if (now >= bag.expiresAt) this.state.loot.delete(lid);
    }

    // Auto loot spawn (ambient treasure)
    if (now >= this.nextLootSpawnAt && this.state.loot.size < LOOT_BAG_CAP) {
      this.spawnAmbientLoot(now);
      this.nextLootSpawnAt = now + LOOT_AUTO_SPAWN_MS - Math.floor(Math.random() * 4000);
    }

    // Loot pickup
    for (const [, p] of this.state.players.entries()) this.tryLootPickup(p, now);
  }

  // =========================================================================
  // Player simulation (movement + sprint + dash)
  // =========================================================================
  private stepPlayer(sid: string, p: Player, now: number) {
    if (p.deadUntil) {
      p.vx = 0; p.vy = 0; p.sprinting = false;
      return;
    }

    const q = this.inputsByClient.get(sid);
    if (!q || q.length === 0) {
      p.vx = 0; p.vy = 0; p.sprinting = false;
      p.stamina = Math.min(STAMINA_MAX, p.stamina + STAMINA_REGEN * 0.05);
      return;
    }

    const carrying = p.pack.length > 0;
    let lastVx = 0, lastVy = 0, sprinting = false;
    const weapon = p.equipped.get("weapon");
    const armor = p.equipped.get("armor");
    const ring = p.equipped.get("ring");
    const speedBonus = 1 + (armor?.bonusSpeed ?? 0) + (ring?.bonusSpeed ?? 0) + (weapon?.bonusSpeed ?? 0);

    for (const input of q) {
      let dx = 0, dy = 0;
      if (input.left) dx -= 1;
      if (input.right) dx += 1;
      if (input.up) dy -= 1;
      if (input.down) dy += 1;
      if (dx !== 0 && dy !== 0) {
        const inv = 1 / Math.sqrt(2); dx *= inv; dy *= inv;
      }

      const dashing = now < p.dashEnd;
      const wantSprint = !!input.sprint && !dashing && (dx !== 0 || dy !== 0);
      let speed: number;
      if (dashing) speed = DASH_SPEED;
      else if (wantSprint && p.stamina > 0.02) {
        speed = PLAYER_SPRINT_SPEED;
        p.stamina = Math.max(0, p.stamina - STAMINA_DRAIN * input.dt);
        sprinting = true;
      } else {
        speed = PLAYER_WALK_SPEED;
        p.stamina = Math.min(STAMINA_MAX, p.stamina + STAMINA_REGEN * input.dt);
      }
      speed *= speedBonus;
      if (carrying) speed *= 0.93;

      // For dashing, direction is always current aim if no WASD held.
      if (dashing && dx === 0 && dy === 0) {
        dx = Math.cos(p.aimAngle || 0);
        dy = Math.sin(p.aimAngle || 0);
      }

      const stepX = dx * speed * input.dt;
      const stepY = dy * speed * input.dt;

      const nx = p.x + stepX;
      if (!collides(this.map, nx, p.y, PLAYER_SIZE, PLAYER_SIZE)) p.x = nx;
      const ny = p.y + stepY;
      if (!collides(this.map, p.x, ny, PLAYER_SIZE, PLAYER_SIZE)) p.y = ny;

      lastVx = stepX / Math.max(0.0001, input.dt);
      lastVy = stepY / Math.max(0.0001, input.dt);

      if (dx !== 0 || dy !== 0) {
        if (Math.abs(dx) > Math.abs(dy)) p.facing = dx > 0 ? 3 : 2;
        else p.facing = dy > 0 ? 0 : 1;
        // Keep aim synced when not attacking.
        if (now > p.attackEnd) p.aimAngle = Math.atan2(dy, dx);
      }
      p.lastProcessedInput = input.seq;
    }
    q.length = 0;

    p.x = Math.max(0, Math.min(p.x, MAP_W * TILE_SIZE - PLAYER_SIZE));
    p.y = Math.max(0, Math.min(p.y, MAP_H * TILE_SIZE - PLAYER_SIZE));
    p.vx = lastVx; p.vy = lastVy;
    p.sprinting = sprinting;

    // Slow HP regen in safe zone only.
    const pcx = p.x + PLAYER_SIZE / 2, pcy = p.y + PLAYER_SIZE / 2;
    if (this.isPlayerSafe(pcx, pcy)) {
      if (p.hp < p.hpMax) p.hp = Math.min(p.hpMax, p.hp + 10 * SIM_DT_MS / 1000);
    }
  }

  // =========================================================================
  // Combat — player swing → damage enemies + other players (outside safe zone)
  // =========================================================================
  private resolveSwing(p: Player, sid: string) {
    const weapon = p.equipped.get("weapon");
    const ring = p.equipped.get("ring");
    const baseDmg = (weapon?.damage ?? 5);
    const bonusPct = (weapon?.bonusDamagePct ?? 0) + (ring?.bonusDamagePct ?? 0);
    const dmg = Math.max(1, Math.round(baseDmg * (1 + bonusPct)));
    const range = weapon?.bonusRange ?? 32;
    const arcHalfAngle = 0.9;  // ~100° cone

    const cx = p.x + PLAYER_SIZE / 2;
    const cy = p.y + PLAYER_SIZE / 2;
    const ang = p.aimAngle;
    const now = Date.now();

    // Hit enemies
    for (const [, e] of this.state.enemies.entries()) {
      if (e.kind === "merchant") continue;
      if (e.state === "dead") continue;
      const dx = e.x - cx, dy = e.y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > range + 18) continue;
      const a = Math.atan2(dy, dx);
      let da = Math.abs(a - ang);
      if (da > Math.PI) da = 2 * Math.PI - da;
      if (da > arcHalfAngle) continue;
      this.damageEnemy(e, dmg, p, sid, now);
    }

    // Hit other players (PvP) — both must be OUTSIDE safe zone
    const attackerSafe = this.isPlayerSafe(cx, cy);
    for (const [otherSid, other] of this.state.players.entries()) {
      if (otherSid === sid) continue;
      if (other.deadUntil) continue;
      if (now < other.invulnUntil) continue;
      const ocx = other.x + PLAYER_SIZE / 2, ocy = other.y + PLAYER_SIZE / 2;
      if (attackerSafe || this.isPlayerSafe(ocx, ocy)) continue;
      const dx = ocx - cx, dy = ocy - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > range + 18) continue;
      const a = Math.atan2(dy, dx);
      let da = Math.abs(a - ang);
      if (da > Math.PI) da = 2 * Math.PI - da;
      if (da > arcHalfAngle) continue;
      this.damagePlayer(other, otherSid, dmg, { kind: "player", id: sid, name: p.name }, now);
    }
  }

  private damageEnemy(e: Enemy, dmg: number, attacker: Player, attackerSid: string, now: number) {
    e.hp -= dmg;
    e.hitFlashUntil = now + 160;
    this.broadcast("fx", { t: "hit", x: e.x, y: e.y, amount: dmg });
    if (e.hp <= 0) {
      e.hp = 0;
      e.state = "dead";
      this.dropLootFromEnemy(e, now);
      attacker.killsThisRun += 1;
      this.deadEnemyClearAt.set(e.id, now + 2500);
      // Respawn an enemy later
      setTimeout(() => this.scheduleRespawnEnemy(e), ENEMY_RESPAWN_DELAY_MS).unref?.();
    }
  }

  private damagePlayer(target: Player, sid: string, dmgRaw: number, _src: { kind: string; id: string; name?: string }, now: number) {
    if (target.deadUntil) return;
    if (now < target.invulnUntil) return;
    const armor = target.equipped.get("armor");
    const defense = armor?.defense ?? 0;
    const dmg = Math.max(1, dmgRaw - defense);
    target.hp -= dmg;
    target.hitFlashUntil = now + 220;
    this.broadcast("fx", { t: "hit", x: target.x + PLAYER_SIZE / 2, y: target.y, amount: dmg });
    if (target.hp <= 0) {
      target.hp = 0;
      target.deadUntil = now + RESPAWN_MS;
      this.dropPlayerLootOnDeath(target);
      this.broadcast("fx", { t: "death", x: target.x + PLAYER_SIZE / 2, y: target.y + PLAYER_SIZE / 2, name: target.name });
    }
  }

  private dropLootFromEnemy(e: Enemy, now: number) {
    if (e.kind === "merchant") return;
    const kind = (["revenant", "bandit", "archer", "rival", "elite"].includes(e.kind) ? e.kind : "revenant") as "revenant" | "bandit" | "archer" | "rival" | "elite";
    const { items, gold } = rollLoot(kind);
    if (items.length === 0 && gold === 0) return;
    const bag = new LootBag();
    bag.id = `l_${e.id}_${now}`;
    bag.x = e.x; bag.y = e.y;
    bag.gold = gold;
    for (const it of items) bag.items.push(it);
    bag.expiresAt = now + LOOT_EXPIRE_MS;
    this.state.loot.set(bag.id, bag);
  }

  private dropPlayerLootOnDeath(p: Player) {
    if (p.pack.length === 0 && p.gold < 5) return;
    const now = Date.now();
    const bag = new LootBag();
    bag.id = `l_pd_${p.id}_${now}`;
    bag.x = p.x + PLAYER_SIZE / 2; bag.y = p.y + PLAYER_SIZE / 2;
    // Drop entire pack + a portion of gold.
    for (const it of p.pack) bag.items.push(this.cloneItem(it));
    bag.gold = Math.floor(p.gold * 0.4);
    p.pack.clear();
    p.gold = Math.floor(p.gold * 0.6);
    bag.expiresAt = now + LOOT_EXPIRE_MS * 1.4;
    this.state.loot.set(bag.id, bag);
  }

  // =========================================================================
  // Enemy AI
  // =========================================================================
  private stepEnemy(id: string, e: Enemy, now: number) {
    if (e.kind === "merchant") return; // flavor, static
    if (e.state === "dead") return;

    const stats = (ENEMY_STATS as any)[e.kind] as typeof ENEMY_STATS.revenant;
    if (!stats) return;

    // Find nearest player (non-dead, non-safe).
    let best: Player | null = null;
    let bestId = "";
    let bestD2 = Infinity;
    for (const [sid, p] of this.state.players.entries()) {
      if (p.deadUntil) continue;
      const pcx = p.x + PLAYER_SIZE / 2, pcy = p.y + PLAYER_SIZE / 2;
      if (this.isPlayerSafe(pcx, pcy)) continue;
      const dx = pcx - e.x, dy = pcy - e.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) { bestD2 = d2; best = p; bestId = sid; }
    }

    const dtSec = SIM_DT_MS / 1000;
    const targetDist = best ? Math.sqrt(bestD2) : Infinity;

    if (best && targetDist <= stats.aggroRange) {
      e.state = targetDist <= stats.atkRange + 4 ? "attack" : "chase";
      e.targetId = bestId;

      if (e.state === "chase") {
        const dx = best.x + PLAYER_SIZE / 2 - e.x;
        const dy = best.y + PLAYER_SIZE / 2 - e.y;
        const d = Math.max(0.0001, Math.sqrt(dx * dx + dy * dy));
        const sx = (dx / d) * stats.speed * dtSec;
        const sy = (dy / d) * stats.speed * dtSec;
        // Collide per axis (tile grid).
        if (!collides(this.map, e.x - 11 + sx, e.y - 11, 22, 22)) e.x += sx;
        if (!collides(this.map, e.x - 11, e.y - 11 + sy, 22, 22)) e.y += sy;
        e.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 3 : 2) : (dy > 0 ? 0 : 1);
      } else {
        // Attack
        const nextAtk = this.enemyAtkCooldown.get(id) || 0;
        if (now >= nextAtk) {
          this.enemyAtkCooldown.set(id, now + stats.atkCooldownMs);
          e.attackEnd = now + 220;
          if (e.kind === "archer") {
            // Spawn arrow projectile
            const dx = best.x + PLAYER_SIZE / 2 - e.x;
            const dy = best.y + PLAYER_SIZE / 2 - e.y;
            const d = Math.max(0.0001, Math.sqrt(dx * dx + dy * dy));
            const pr = new Projectile();
            pr.id = `pr_${id}_${now}`;
            pr.ownerKind = "enemy"; pr.ownerId = id;
            pr.x = e.x; pr.y = e.y;
            pr.vx = (dx / d) * ARCHER_ARROW_SPEED;
            pr.vy = (dy / d) * ARCHER_ARROW_SPEED;
            pr.damage = stats.dmg;
            pr.spawnedAt = now;
            pr.expiresAt = now + PROJECTILE_TTL_MS;
            this.state.projectiles.set(pr.id, pr);
          } else {
            // Melee contact
            this.damagePlayer(best, bestId, stats.dmg, { kind: "enemy", id: e.id }, now);
          }
        }
      }
    } else {
      // Patrol near anchor.
      e.state = "patrol";
      const dx = e.anchorX - e.x;
      const dy = e.anchorY - e.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > 10) {
        const sp = stats.speed * 0.4 * dtSec;
        const mx = (dx / d) * sp;
        const my = (dy / d) * sp;
        if (!collides(this.map, e.x - 11 + mx, e.y - 11, 22, 22)) e.x += mx;
        if (!collides(this.map, e.x - 11, e.y - 11 + my, 22, 22)) e.y += my;
      } else if (Math.random() < 0.02) {
        e.anchorX = e.x + (Math.random() - 0.5) * 64;
        e.anchorY = e.y + (Math.random() - 0.5) * 64;
      }
    }
  }

  // Projectiles
  private stepProjectiles(now: number) {
    const dt = SIM_DT_MS / 1000;
    for (const [id, pr] of this.state.projectiles.entries()) {
      if (now >= pr.expiresAt) { this.state.projectiles.delete(id); continue; }
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      // Tile collision
      if (collides(this.map, pr.x - 3, pr.y - 3, 6, 6)) {
        this.state.projectiles.delete(id);
        continue;
      }
      // Hit any player (if enemy projectile)
      if (pr.ownerKind === "enemy") {
        for (const [sid, p] of this.state.players.entries()) {
          if (p.deadUntil) continue;
          if (this.isPlayerSafe(p.x + PLAYER_SIZE / 2, p.y + PLAYER_SIZE / 2)) continue;
          const dx = (p.x + PLAYER_SIZE / 2) - pr.x;
          const dy = (p.y + PLAYER_SIZE / 2) - pr.y;
          if (dx * dx + dy * dy <= 14 * 14) {
            this.damagePlayer(p, sid, pr.damage, { kind: "enemy", id: pr.ownerId }, now);
            this.state.projectiles.delete(id);
            break;
          }
        }
      }
    }
  }

  // =========================================================================
  // Spawning
  // =========================================================================
  private countLiveEnemies(): number {
    let c = 0;
    for (const e of this.state.enemies.values())
      if (e.kind !== "merchant" && e.state !== "dead") c++;
    return c;
  }

  private trySpawnEnemy(now: number) {
    const anchors = getEnemyAnchors();
    const a = anchors[Math.floor(Math.random() * anchors.length)];
    const kind = a.kinds[Math.floor(Math.random() * a.kinds.length)] as EnemyKind;
    // Sometimes promote to elite
    const finalKind: EnemyKind = Math.random() < 0.04 ? "elite" : kind;
    const stats = ENEMY_STATS[finalKind];
    if (!stats) return;

    const e = new Enemy();
    e.id = `e_${now}_${this.spawnCounter++}`;
    e.kind = finalKind;
    e.shortName = stats.label;
    e.hp = stats.hp; e.hpMax = stats.hp;
    const px = a.x * TILE_SIZE + TILE_SIZE / 2 + (Math.random() - 0.5) * 8;
    const py = a.y * TILE_SIZE + TILE_SIZE / 2 + (Math.random() - 0.5) * 8;
    if (collides(this.map, px - 11, py - 11, 22, 22)) return; // abort if anchor is blocked
    e.x = px; e.y = py;
    e.anchorX = px; e.anchorY = py;
    e.state = "patrol";
    this.state.enemies.set(e.id, e);
  }

  private scheduleRespawnEnemy(original: Enemy) {
    // Minimal: just let the normal spawn loop pick a fresh anchor.
  }

  private spawnAmbientLoot(now: number) {
    const anchors = getLootAnchors();
    const a = anchors[Math.floor(Math.random() * anchors.length)];
    const px = a.x * TILE_SIZE + TILE_SIZE / 2 + (Math.random() - 0.5) * 16;
    const py = a.y * TILE_SIZE + TILE_SIZE / 2 + (Math.random() - 0.5) * 16;
    if (collides(this.map, px - 8, py - 8, 16, 16)) return;
    const bag = new LootBag();
    bag.id = `l_a_${now}`;
    bag.x = px; bag.y = py;
    bag.gold = 2 + Math.floor(Math.random() * 8);
    if (Math.random() < 0.6) bag.items.push(rollAny(0));
    if (Math.random() < 0.2) bag.items.push(rollConsumable());
    bag.expiresAt = now + LOOT_EXPIRE_MS;
    this.state.loot.set(bag.id, bag);
  }

  // =========================================================================
  // Loot pickup + extraction
  // =========================================================================
  private tryLootPickup(p: Player, now: number) {
    if (p.deadUntil) return;
    const pcx = p.x + PLAYER_SIZE / 2, pcy = p.y + PLAYER_SIZE / 2;
    for (const [lid, bag] of this.state.loot.entries()) {
      const dx = pcx - bag.x, dy = pcy - bag.y;
      if (dx * dx + dy * dy <= 22 * 22) {
        if (bag.gold > 0) { p.gold += bag.gold; bag.gold = 0; }
        while (bag.items.length > 0 && p.pack.length < PACK_MAX) {
          const it = bag.items.shift();
          if (it) p.pack.push(it);
        }
        if (bag.gold === 0 && bag.items.length === 0) this.state.loot.delete(lid);
      }
    }
  }

  private updateRunState(p: Player, now: number) {
    const pcx = p.x + PLAYER_SIZE / 2, pcy = p.y + PLAYER_SIZE / 2;
    const safe = this.isPlayerSafe(pcx, pcy);
    if (!p.inRun && !safe && !p.deadUntil) {
      p.inRun = true; p.runStartedAt = now;
    } else if (p.inRun && safe) {
      // Extract: move pack → stash, award extraction.
      if (p.pack.length > 0 || p.gold > 0) {
        let moved = 0;
        while (p.pack.length > 0 && p.stash.length < STASH_MAX) {
          const it = p.pack.shift();
          if (it) { p.stash.push(it); moved++; }
        }
        // Persist for reconnection
        this.stashByName.set(p.name, {
          gold: p.gold,
          items: p.stash.map((i) => this.cloneItem(i)),
        });
        p.extractions += 1;
        this.broadcast("chat", {
          from: "📦",
          text: `${p.name} extracted ${moved} item${moved === 1 ? "" : "s"} to the stash.`,
          at: now, kind: "system-good",
        });
      }
      p.inRun = false;
    }
  }

  private respawnPlayer(p: Player) {
    p.deadUntil = 0;
    p.hp = p.hpMax;
    p.invulnUntil = Date.now() + 1500;
    // Respawn at plaza
    const c = tileCenterPx(26 + (Math.floor(Math.random() * 6) - 3), 20);
    p.x = c.x - PLAYER_SIZE / 2;
    p.y = c.y - PLAYER_SIZE / 2;
    p.inRun = false;
    p.killsThisRun = 0;
    // pack was cleared on death
  }

  // =========================================================================
  // Inventory ops
  // =========================================================================
  private equipFromPack(p: Player, idx: number) {
    const it = p.pack[idx];
    if (!it) return;
    if (it.slot === "weapon" || it.slot === "armor" || it.slot === "ring") {
      const prev = p.equipped.get(it.slot);
      p.equipped.set(it.slot, this.cloneItem(it));
      p.pack.splice(idx, 1);
      if (prev) {
        if (p.pack.length < PACK_MAX) p.pack.push(prev);
        else {
          // drop previous at feet
          const now = Date.now();
          const bag = new LootBag();
          bag.id = `l_drop_${p.id}_${now}`;
          bag.x = p.x + PLAYER_SIZE / 2; bag.y = p.y + PLAYER_SIZE / 2;
          bag.items.push(prev);
          bag.expiresAt = now + LOOT_EXPIRE_MS;
          this.state.loot.set(bag.id, bag);
        }
      }
      this.recomputePlayerStats(p);
    } else if (it.slot === "consumable") {
      // Same as "use"
      if (it.healAmount > 0) {
        p.hp = Math.min(p.hpMax, p.hp + it.healAmount);
      }
      p.pack.splice(idx, 1);
    }
  }

  private recomputePlayerStats(p: Player) {
    const armor = p.equipped.get("armor");
    const ring = p.equipped.get("ring");
    const weapon = p.equipped.get("weapon");
    const hpBonus = (armor?.bonusHp ?? 0) + (ring?.bonusHp ?? 0) + (weapon?.bonusHp ?? 0);
    const newMax = PLAYER_HP_MAX_BASE + hpBonus;
    p.hpMax = newMax;
    if (p.hp > p.hpMax) p.hp = p.hpMax;
  }

  private cloneItem(src: Item): Item {
    const c = new Item();
    c.id = src.id; c.name = src.name; c.slot = src.slot; c.rarity = src.rarity; c.kind = src.kind;
    c.damage = src.damage; c.defense = src.defense;
    c.bonusHp = src.bonusHp; c.bonusSpeed = src.bonusSpeed;
    c.bonusDamagePct = src.bonusDamagePct; c.bonusRange = src.bonusRange;
    c.attackSpeed = src.attackSpeed; c.healAmount = src.healAmount;
    return c;
  }

  // =========================================================================
  // Helpers
  // =========================================================================
  private isPlayerSafe(cx: number, cy: number): boolean {
    const tx = Math.floor(cx / TILE_SIZE);
    const ty = Math.floor(cy / TILE_SIZE);
    return isSafeTile(tx, ty);
  }

  private facingToAngle(f: number): number {
    switch (f) {
      case 0: return Math.PI / 2;   // down
      case 1: return -Math.PI / 2;  // up
      case 2: return Math.PI;       // left
      case 3: return 0;             // right
    }
    return 0;
  }
}
