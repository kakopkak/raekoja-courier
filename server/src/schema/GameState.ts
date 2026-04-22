import { Schema, MapSchema, type } from "@colyseus/schema";

export class Player extends Schema {
  @type("string") id = "";
  @type("string") name = "";
  @type("string") color = "#ffffff";

  // Authoritative position
  @type("number") x = 0;
  @type("number") y = 0;
  @type("number") vx = 0;
  @type("number") vy = 0;

  // Last input processed — client uses this for prediction reconciliation.
  @type("number") lastProcessedInput = 0;

  // Direction 0 down / 1 up / 2 left / 3 right.
  @type("number") facing = 0;

  // Stamina 0..1 (server-authoritative).
  @type("number") stamina = 1;
  @type("boolean") sprinting = false;

  // Delivery game fields
  @type("string") carryingOrderId = "";  // order.id or ""
  @type("number") score = 0;             // marks earned this session
  @type("number") combo = 0;             // current combo multiplier (0,1,2,...)
  @type("number") comboExpiresAt = 0;    // server timestamp ms when combo resets
  @type("number") deliveries = 0;        // total completed this session
}

export class Npc extends Schema {
  @type("string") id = "";
  @type("string") name = "";
  @type("string") shortName = "";
  @type("string") role = "";
  @type("number") x = 0;        // tile center, world px
  @type("number") y = 0;
  @type("string") activeOrderId = "";   // has a pending pickup? (if this NPC is the "from")
}

export class Order extends Schema {
  @type("string") id = "";
  @type("string") fromNpcId = "";
  @type("string") toNpcId = "";
  @type("string") carrierId = "";        // player sessionId
  @type("string") itemName = "";
  @type("string") itemEn = "";
  @type("number") reward = 0;             // base marks
  @type("number") expiresAt = 0;          // server timestamp ms
  @type("number") createdAt = 0;
  @type("string") status = "available";   // "available" | "carried" | "delivered" | "expired"
}

export class GameState extends Schema {
  @type({ map: Player }) players = new MapSchema<Player>();
  @type({ map: Npc }) npcs = new MapSchema<Npc>();
  @type({ map: Order }) orders = new MapSchema<Order>();
  @type("number") tick = 0;
  @type("number") serverNow = 0;           // broadcast time for client timer UI
  @type("number") dayPhase = 0;            // 0..1, used for tinting time-of-day
}
