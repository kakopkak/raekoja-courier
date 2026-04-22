// Loot generation. Kept simple: rarity rolls, weapon/armor/ring templates,
// rarity-scaled stats, and evocative Baltic-flavor names.
import { Item } from "../schema/GameState.js";

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------
type Template = {
  kind: string;
  slot: "weapon" | "armor" | "ring" | "consumable";
  baseName: string;
  base: Partial<Pick<Item, "damage" | "defense" | "bonusHp" | "bonusSpeed" | "bonusDamagePct" | "bonusRange" | "attackSpeed" | "healAmount">>;
};

const WEAPONS: Template[] = [
  // Melee — range is swing reach in px (32px tile = 1 tile per 32 range).
  { kind: "dagger",  slot: "weapon", baseName: "Dagger",     base: { damage: 9,  bonusRange: 34, attackSpeed: 0.32 } },
  { kind: "sword",   slot: "weapon", baseName: "Shortsword", base: { damage: 14, bonusRange: 46, attackSpeed: 0.42 } },
  { kind: "mace",    slot: "weapon", baseName: "Mace",       base: { damage: 18, bonusRange: 42, attackSpeed: 0.55 } },
  { kind: "axe",     slot: "weapon", baseName: "War Axe",    base: { damage: 24, bonusRange: 48, attackSpeed: 0.70 } },
  { kind: "spear",   slot: "weapon", baseName: "Spear",      base: { damage: 16, bonusRange: 62, attackSpeed: 0.55 } },
  { kind: "hammer",  slot: "weapon", baseName: "War Hammer", base: { damage: 30, bonusRange: 44, attackSpeed: 0.85 } },
];

const ARMORS: Template[] = [
  { kind: "leather", slot: "armor", baseName: "Leather Jerkin", base: { defense: 3,  bonusHp: 15, bonusSpeed: 0.02 } },
  { kind: "chain",   slot: "armor", baseName: "Chain Hauberk",  base: { defense: 7,  bonusHp: 25 } },
  { kind: "plate",   slot: "armor", baseName: "Plate Cuirass",  base: { defense: 12, bonusHp: 40, bonusSpeed: -0.05 } },
];

const RINGS: Template[] = [
  { kind: "ring_vigor",   slot: "ring", baseName: "Ring of Vigor",    base: { bonusHp: 20 } },
  { kind: "ring_fury",    slot: "ring", baseName: "Ring of Fury",     base: { bonusDamagePct: 0.12 } },
  { kind: "ring_swift",   slot: "ring", baseName: "Ring of Swiftness",base: { bonusSpeed: 0.10 } },
  { kind: "ring_ward",    slot: "ring", baseName: "Ring of Ward",     base: { defense: 3 } },
];

const CONSUMABLES: Template[] = [
  { kind: "potion_minor", slot: "consumable", baseName: "Minor Healing Draught", base: { healAmount: 35 } },
  { kind: "potion_major", slot: "consumable", baseName: "Healing Draught",       base: { healAmount: 70 } },
];

// Rarity → stat multiplier + an extra modifier
export const RARITY = {
  common:    { weight: 60, mult: 1.00, prefix: "" },
  uncommon:  { weight: 25, mult: 1.25, prefix: "Fine" },
  rare:      { weight: 12, mult: 1.55, prefix: "Masterwork" },
  epic:      { weight:  3, mult: 2.00, prefix: "Runed" },
} as const;
export type Rarity = keyof typeof RARITY;

function rollRarity(luckBoost = 0): Rarity {
  const entries = (Object.entries(RARITY) as [Rarity, typeof RARITY.common][]);
  const total = entries.reduce((a, [, v]) => a + v.weight, 0) + luckBoost;
  let r = Math.random() * total;
  for (const [name, v] of entries) {
    r -= v.weight + (name !== "common" ? luckBoost / 3 : 0);
    if (r <= 0) return name;
  }
  return "common";
}

// Prefixes that add flavor affixes based on rarity
const AFFIX_PREFIX = [
  { name: "Blooded",   ok: (t: Template) => t.slot === "weapon", apply: (i: Item) => { i.damage += 4; } },
  { name: "Venomed",   ok: (t: Template) => t.slot === "weapon", apply: (i: Item) => { i.damage += 3; i.bonusDamagePct += 0.08; } },
  { name: "Swift",     ok: () => true, apply: (i: Item) => { i.bonusSpeed += 0.05; } },
  { name: "Stalwart",  ok: (t: Template) => t.slot === "armor", apply: (i: Item) => { i.defense += 3; } },
  { name: "Gilded",    ok: () => true, apply: (i: Item) => { i.bonusHp += 15; } },
  { name: "Ruinous",   ok: (t: Template) => t.slot === "weapon", apply: (i: Item) => { i.bonusDamagePct += 0.15; } },
];
const AFFIX_SUFFIX = [
  { name: "of the Bear",     apply: (i: Item) => { i.bonusHp += 20; } },
  { name: "of the Hawk",     apply: (i: Item) => { i.bonusSpeed += 0.05; } },
  { name: "of the Wolf",     apply: (i: Item) => { i.bonusDamagePct += 0.10; } },
  { name: "of the Guard",    apply: (i: Item) => { i.defense += 2; } },
  { name: "of Old Tallinn",  apply: (i: Item) => { i.bonusHp += 10; i.bonusSpeed += 0.02; } },
  { name: "of the Hanse",    apply: (i: Item) => { i.bonusDamagePct += 0.08; i.defense += 1; } },
  { name: "of Toompea",      apply: (i: Item) => { i.defense += 4; i.bonusHp += 10; } },
];

function pick<T>(arr: T[]): T { return arr[Math.floor(Math.random() * arr.length)]; }
function uid(prefix: string): string { return `${prefix}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`; }

function applyBase(item: Item, tmpl: Template, mult: number) {
  const b = tmpl.base;
  item.kind = tmpl.kind;
  item.slot = tmpl.slot;
  if (b.damage)          item.damage = Math.max(1, Math.round(b.damage * mult));
  if (b.defense)         item.defense = Math.max(0, Math.round((b.defense ?? 0) * mult));
  if (b.bonusHp)         item.bonusHp = Math.round((b.bonusHp ?? 0) * mult);
  if (b.bonusSpeed !== undefined) item.bonusSpeed = (b.bonusSpeed ?? 0) * (mult > 1 ? 1 : 1); // speed is flat-ish
  if (b.bonusDamagePct)  item.bonusDamagePct = (b.bonusDamagePct ?? 0) * mult;
  if (b.bonusRange)      item.bonusRange = Math.round((b.bonusRange ?? 0) * (1 + (mult - 1) * 0.35));
  if (b.attackSpeed)     item.attackSpeed = b.attackSpeed;
  if (b.healAmount)      item.healAmount = Math.round((b.healAmount ?? 0) * mult);
}

function decorate(item: Item, rarity: Rarity, tmpl: Template) {
  const r = RARITY[rarity];
  let name = tmpl.baseName;
  if (rarity !== "common") {
    const prefix = pick(AFFIX_PREFIX.filter((p) => p.ok(tmpl)));
    if (prefix) { prefix.apply(item); name = `${prefix.name} ${name}`; }
    if (rarity === "rare" || rarity === "epic") {
      const suffix = pick(AFFIX_SUFFIX);
      if (suffix) { suffix.apply(item); name = `${name} ${suffix.name}`; }
    }
    if (rarity === "epic") name = `${r.prefix} ${name}`.replace(/^\s+/, "");
  }
  item.name = name;
  item.rarity = rarity;
}

export function rollWeapon(rarity?: Rarity): Item {
  const r = rarity ?? rollRarity();
  const tmpl = pick(WEAPONS);
  const item = new Item();
  item.id = uid("it");
  applyBase(item, tmpl, RARITY[r].mult);
  decorate(item, r, tmpl);
  return item;
}

export function rollArmor(rarity?: Rarity): Item {
  const r = rarity ?? rollRarity();
  const tmpl = pick(ARMORS);
  const item = new Item();
  item.id = uid("it");
  applyBase(item, tmpl, RARITY[r].mult);
  decorate(item, r, tmpl);
  return item;
}

export function rollRing(rarity?: Rarity): Item {
  const r = rarity ?? rollRarity();
  const tmpl = pick(RINGS);
  const item = new Item();
  item.id = uid("it");
  applyBase(item, tmpl, RARITY[r].mult);
  decorate(item, r, tmpl);
  return item;
}

export function rollConsumable(): Item {
  const tmpl = pick(CONSUMABLES);
  const item = new Item();
  item.id = uid("it");
  applyBase(item, tmpl, 1.0);
  item.name = tmpl.baseName;
  item.rarity = "common";
  return item;
}

/** Roll a random item from any table. */
export function rollAny(luckBoost = 0): Item {
  const pool = Math.random();
  if (pool < 0.45) return rollWeapon(rollRarity(luckBoost));
  if (pool < 0.75) return rollArmor(rollRarity(luckBoost));
  if (pool < 0.92) return rollRing(rollRarity(luckBoost));
  return rollConsumable();
}

/** Loot table per enemy kind. */
export function rollLoot(enemyKind: string): { items: Item[]; gold: number } {
  const items: Item[] = [];
  let gold = 0;
  switch (enemyKind) {
    case "revenant":
      gold = 2 + Math.floor(Math.random() * 4);
      if (Math.random() < 0.55) items.push(rollAny(0));
      break;
    case "bandit":
      gold = 5 + Math.floor(Math.random() * 8);
      if (Math.random() < 0.80) items.push(rollAny(4));
      break;
    case "archer":
      gold = 4 + Math.floor(Math.random() * 7);
      if (Math.random() < 0.65) items.push(rollAny(2));
      break;
    case "rival":
      gold = 15 + Math.floor(Math.random() * 20);
      items.push(rollAny(10));
      if (Math.random() < 0.45) items.push(rollAny(6));
      break;
    case "elite":
      gold = 40 + Math.floor(Math.random() * 40);
      items.push(rollAny(20));
      if (Math.random() < 0.60) items.push(rollAny(15));
      if (Math.random() < 0.30) items.push(rollAny(25));
      break;
  }
  return { items, gold };
}

export function makeStarterWeapon(): Item {
  const item = new Item();
  item.id = uid("it");
  item.kind = "sword";
  item.slot = "weapon";
  item.rarity = "common";
  item.damage = 10;
  item.bonusRange = 42;
  item.attackSpeed = 0.45;
  item.name = "Wanderer's Sword";
  return item;
}

export function summariseItem(it: Item): string {
  const parts: string[] = [];
  if (it.damage) parts.push(`DMG ${it.damage}`);
  if (it.defense) parts.push(`DEF ${it.defense}`);
  if (it.bonusHp) parts.push(`HP +${it.bonusHp}`);
  if (it.bonusSpeed) parts.push(`SPD ${it.bonusSpeed > 0 ? "+" : ""}${Math.round(it.bonusSpeed * 100)}%`);
  if (it.bonusDamagePct) parts.push(`DMG +${Math.round(it.bonusDamagePct * 100)}%`);
  if (it.healAmount) parts.push(`HEAL ${it.healAmount}`);
  return parts.join(" · ");
}
