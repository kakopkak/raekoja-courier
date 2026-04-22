import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";

// ---------------------------------------------------------------------------
// Items — the core of the loot / equipment system.
// ---------------------------------------------------------------------------
export class Item extends Schema {
  @type("string") id = "";              // unique instance id
  @type("string") name = "";            // display name
  @type("string") slot = "none";        // "weapon" | "armor" | "ring" | "consumable" | "none"
  @type("string") rarity = "common";    // common | uncommon | rare | epic
  @type("string") kind = "";            // specific type: "sword" | "axe" | "dagger" | "bow" | "leather" | ...

  // Stats (flat)
  @type("number") damage = 0;
  @type("number") defense = 0;
  @type("number") bonusHp = 0;

  // Percent bonuses (0..1 is 0..100%)
  @type("number") bonusSpeed = 0;
  @type("number") bonusDamagePct = 0;
  @type("number") bonusRange = 0;        // flat px
  @type("number") attackSpeed = 1.0;     // seconds between swings; lower = faster

  // For consumables (e.g. healing potion)
  @type("number") healAmount = 0;
}

// ---------------------------------------------------------------------------
// Player — now includes combat + equipment + run state.
// ---------------------------------------------------------------------------
export class Player extends Schema {
  @type("string") id = "";
  @type("string") name = "";
  @type("string") color = "#ffffff";
  @type("string") className = "wanderer"; // wanderer | brawler | ranger (starter class)

  // Position
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") vx = 0;
  @type("number") vy = 0;
  @type("number") lastProcessedInput = 0;
  @type("number") facing = 0;             // 0 down, 1 up, 2 left, 3 right
  @type("number") aimAngle = 0;            // radians — cursor-based attack direction (fallback: facing)

  // Combat
  @type("number") hp = 100;
  @type("number") hpMax = 100;
  @type("number") stamina = 1;
  @type("boolean") sprinting = false;

  // Swing/dash state (server timestamps ms)
  @type("number") attackStart = 0;
  @type("number") attackEnd = 0;
  @type("number") dashEnd = 0;
  @type("number") invulnUntil = 0;
  @type("number") hitFlashUntil = 0;
  @type("number") deadUntil = 0;           // non-zero while dead (respawn countdown)

  // Run state
  @type("boolean") inRun = false;
  @type("number") runStartedAt = 0;
  @type("number") extractions = 0;
  @type("number") killsThisRun = 0;

  // Meta
  @type("number") gold = 0;

  // Equipment (keys: "weapon", "armor", "ring")
  @type({ map: Item }) equipped = new MapSchema<Item>();

  // Current run inventory (lost on death, stashed on extraction)
  @type([Item]) pack = new ArraySchema<Item>();

  // Stash (persistent between runs, server memory — up to STASH_CAP)
  @type([Item]) stash = new ArraySchema<Item>();
}

// ---------------------------------------------------------------------------
// Entities — a unified type for hostile AI + flavor NPCs.
//   kind "merchant" / "flavor" — plaza hub decoration, non-hostile
//   kind "revenant"|"bandit"|"archer" — regular enemies
//   kind "rival" — PvPvE pressure (humanoid AI, competes for loot)
//   kind "elite" — mini-boss
// ---------------------------------------------------------------------------
export class Enemy extends Schema {
  @type("string") id = "";
  @type("string") kind = "revenant";
  @type("string") shortName = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") facing = 0;
  @type("number") hp = 30;
  @type("number") hpMax = 30;
  @type("string") state = "patrol";  // patrol | chase | attack | dead
  @type("number") attackEnd = 0;
  @type("number") hitFlashUntil = 0;
  @type("string") targetId = "";     // session id of player they're chasing
  @type("number") anchorX = 0;       // "home" tile center for patrol
  @type("number") anchorY = 0;
}

// ---------------------------------------------------------------------------
// LootBag — dropped items on the ground (from enemy kills OR dead players).
// ---------------------------------------------------------------------------
export class LootBag extends Schema {
  @type("string") id = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") gold = 0;
  @type([Item]) items = new ArraySchema<Item>();
  @type("number") expiresAt = 0;
}

// ---------------------------------------------------------------------------
// Projectiles (arrows from archers for now).
// ---------------------------------------------------------------------------
export class Projectile extends Schema {
  @type("string") id = "";
  @type("string") ownerKind = "enemy"; // enemy | player
  @type("string") ownerId = "";
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") vx = 0;
  @type("number") vy = 0;
  @type("number") damage = 6;
  @type("number") spawnedAt = 0;
  @type("number") expiresAt = 0;
}

// ---------------------------------------------------------------------------
// Root state
// ---------------------------------------------------------------------------
export class GameState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Enemy }) enemies = new MapSchema<Enemy>();
  @type({ map: LootBag }) loot = new MapSchema<LootBag>();
  @type({ map: Projectile }) projectiles = new MapSchema<Projectile>();
  @type("number") tick = 0;
  @type("number") serverNow = 0;
  @type("number") dayPhase = 0;
}
