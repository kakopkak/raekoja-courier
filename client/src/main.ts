import Phaser from "phaser";
import { Client, Room, getStateCallbacks } from "colyseus.js";

// ---------------------------------------------------------------------------
// Global error surface — if anything throws, we want to SEE it, not get a
// silently black viewport. Runs before anything else.
// ---------------------------------------------------------------------------
const errBanner = (() => {
  const el = document.getElementById("err-banner");
  return {
    show(prefix: string, msg: string) {
      if (!el) return;
      el.style.display = "block";
      el.textContent = `${prefix}\n${msg}\n\n${el.textContent || ""}`.slice(0, 6000);
    },
  };
})();
window.addEventListener("error", (e) => {
  errBanner.show("[error]", `${e.message}\n${e.error?.stack || ""}`);
  // eslint-disable-next-line no-console
  console.error("[tallinn]", e.error || e.message);
});
window.addEventListener("unhandledrejection", (e) => {
  errBanner.show("[unhandled promise]", `${e.reason?.message || e.reason}\n${e.reason?.stack || ""}`);
});
import {
  generateMap,
  generateBuildings,
  MAP_W,
  MAP_H,
  TILE_SIZE,
  T,
  isSolid,
  PLAYER_SIZE,
  PLAYER_WALK_SPEED,
  PLAYER_SPRINT_SPEED,
  STAMINA_MAX,
  STAMINA_DRAIN,
  STAMINA_REGEN,
  rankFor,
  type Building,
} from "./shared/map";

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const menu = document.getElementById("menu") as HTMLDivElement;
const nameInput = document.getElementById("name") as HTMLInputElement;
const playBtn = document.getElementById("play") as HTMLButtonElement;
const errEl = document.getElementById("err") as HTMLDivElement;

const hud = document.getElementById("hud") as HTMLDivElement;
const scoreCard = document.getElementById("score-card") as HTMLDivElement;
const orderCard = document.getElementById("order-card") as HTMLDivElement;
const leaderboard = document.getElementById("leaderboard") as HTMLDivElement;
const stamBarEl = document.getElementById("stamina-bar") as HTMLDivElement;
const staminaWrap = document.getElementById("stamina-wrap") as HTMLDivElement;

const chatWrap = document.getElementById("chat") as HTMLDivElement;
const chatLog = document.getElementById("chat-log") as HTMLDivElement;
const chatInput = document.getElementById("chat-input") as HTMLInputElement;

const minimap = document.getElementById("minimap") as HTMLCanvasElement;

nameInput.value = localStorage.getItem("tallinn.name") || "";
nameInput.focus();
nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") playBtn.click(); });

const bestScoreKey = "tallinn.best";
function getBestScore(): number { return Number(localStorage.getItem(bestScoreKey) || 0); }
function setBestScore(n: number) { localStorage.setItem(bestScoreKey, String(n)); }

playBtn.addEventListener("click", async () => {
  const name = (nameInput.value || "").trim().slice(0, 16) || `guest-${Math.floor(Math.random() * 999)}`;
  localStorage.setItem("tallinn.name", name);
  errEl.textContent = "";
  playBtn.disabled = true;
  try {
    await connect(name);
    menu.style.display = "none";
    hud.style.display = "block";
    scoreCard.style.display = "block";
    leaderboard.style.display = "block";
    staminaWrap.style.display = "block";
    chatWrap.style.display = "block";
    minimap.style.display = "block";
  } catch (err: any) {
    console.error(err);
    errEl.textContent = err?.message || "Connection failed.";
    playBtn.disabled = false;
  }
});

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------
let room: Room | undefined;
let selfId = "";

async function connect(name: string) {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  const endpoint = import.meta.env.DEV ? `ws://${location.hostname}:2567` : `${proto}//${location.host}`;
  const client = new Client(endpoint);
  room = await client.joinOrCreate("tallinn", { name });
  selfId = room.sessionId;

  // Chat + server events.
  room.onMessage("chat", (m: { from: string; text: string; kind?: string }) => addChatLine(m.from, m.text, m.kind));
  room.onMessage("order_new", (m: any) => addChatLine("🧭", `Uus tellimus: ${m.from} → ${m.to} · ${m.item} · +${m.reward}`, "system"));
  room.onMessage("order_pickup", (m: any) => {
    if (m.playerId === selfId) {
      addChatLine("📦", `Võtsid tellimuse: vii ${m.item} → ${m.to}`, "system-good");
    }
  });
  room.onMessage("order_delivered", (m: any) => {
    addChatLine(m.playerId === selfId ? "💰" : "🪙",
      `${m.playerName} toimetas ${m.item} → ${m.to} · +${m.payout} marka${m.combo > 1 ? ` · x${m.combo} combo!` : ""}`,
      m.playerId === selfId ? "system-good" : "system");
    if (m.playerId === selfId) {
      pendingDeliveryEffect = { payout: m.payout, combo: m.combo };
    }
  });
  room.onMessage("order_expired", (m: any) => addChatLine("⏱", `Tellimus aegus: ${m.item} juures ${m.fromNpc}`, "system-bad"));

  new Phaser.Game({
    type: Phaser.AUTO,
    parent: "app",
    backgroundColor: "#120e0a",
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: window.innerWidth,
      height: window.innerHeight,
      autoRound: true,
    },
    pixelArt: true,
    roundPixels: true,
    render: { antialias: false },
    scene: [GameScene],
  });
}

function addChatLine(from: string, text: string, kind?: string) {
  const line = document.createElement("div");
  line.className = "line" + (kind ? " " + kind : "");
  line.innerHTML = `<b>${escapeHtml(from)}</b> ${escapeHtml(text)}`;
  chatLog.appendChild(line);
  while (chatLog.children.length > 10) chatLog.removeChild(chatLog.firstChild!);
}
function escapeHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// Cross-scene queue for juice effects triggered by server events.
let pendingDeliveryEffect: { payout: number; combo: number } | null = null;

// ---------------------------------------------------------------------------
// Visual palettes
// ---------------------------------------------------------------------------
const TILE_BASE_COLORS: Record<number, number> = {
  [T.GRASS]: 0x3e5a32,
  [T.STREET]: 0x615648,
  [T.PLAZA]: 0x8a7962,
  [T.BUILDING]: 0x3a2a22,
  [T.WALL]: 0x453a30,
  [T.WATER]: 0x2c4a65,
  [T.TREE]: 0x1f3b1a,
  [T.GATE]: 0x7c6a54,
  [T.CHURCH]: 0x26201b,
  [T.TOOMPEA_GROUND]: 0x8a7158,
  [T.TOWN_HALL]: 0xcfbc91,
  [T.TOWER]: 0x5a4d3f,
  [T.HOUSE]: 0xb08970,
  [T.WELL]: 0x6b6058,
  [T.MARKET_STALL]: 0x8a7962,
  [T.LANTERN]: 0x8a7962,
  [T.STAIRS]: 0x70604c,
  [T.CASTLE_WALL]: 0x3a3027,
};

// role → small hat / color hint for NPCs
const NPC_STYLE: Record<string, { body: number; hat: number }> = {
  baker:      { body: 0xd2a56a, hat: 0xe9cf9a },
  smith:      { body: 0x5a4538, hat: 0x3a2e25 },
  apothecary: { body: 0x7b4a6a, hat: 0xc6a7be },
  scribe:     { body: 0x3e4a73, hat: 0x2b3558 },
  brewer:     { body: 0x8e6b3a, hat: 0xc49766 },
  tanner:     { body: 0x6f4a32, hat: 0x3b2a1c },
  weaver:     { body: 0x9a7c4a, hat: 0xdcbf8e },
  fisherman:  { body: 0x3a5a68, hat: 0xc7a86b },
  crier:      { body: 0xb4463b, hat: 0xe7c258 },
  guard:      { body: 0x4a5054, hat: 0x8a8f93 },
  priest:     { body: 0x2a2a30, hat: 0xc8a14a },
};

// ---------------------------------------------------------------------------
// GameScene
// ---------------------------------------------------------------------------
class GameScene extends Phaser.Scene {
  private map: number[][] = generateMap();
  private buildings: Building[] = generateBuildings();

  private keys!: Record<"up" | "down" | "left" | "right" | "w" | "a" | "s" | "d" | "shift", Phaser.Input.Keyboard.Key>;

  private selfContainer!: Phaser.GameObjects.Container;
  private selfBody!: Phaser.GameObjects.Rectangle;
  private selfEye1!: Phaser.GameObjects.Rectangle;
  private selfEye2!: Phaser.GameObjects.Rectangle;
  private selfHem!: Phaser.GameObjects.Rectangle;
  private selfShadow!: Phaser.GameObjects.Ellipse;
  private selfPackage!: Phaser.GameObjects.Rectangle;
  private selfLabel!: Phaser.GameObjects.Text;
  private selfSprintFx!: Phaser.GameObjects.Ellipse;

  private selfPredicted = { x: 0, y: 0 };
  private selfStamina = 1;
  private pendingInputs: Array<{ seq: number; up: boolean; down: boolean; left: boolean; right: boolean; sprint: boolean; dt: number }> = [];
  private nextSeq = 1;

  private remotes = new Map<string, {
    container: Phaser.GameObjects.Container;
    body: Phaser.GameObjects.Rectangle;
    pack: Phaser.GameObjects.Rectangle;
    label: Phaser.GameObjects.Text;
    buffer: Array<{ t: number; x: number; y: number; facing: number; sprinting: boolean; carrying: boolean }>;
    color: string;
    name: string;
  }>();

  // NPC rendering
  private npcVisuals = new Map<string, {
    container: Phaser.GameObjects.Container;
    ring: Phaser.GameObjects.Arc;        // pulsing "!" attention ring when has order
    bang: Phaser.GameObjects.Text;
    nameTag: Phaser.GameObjects.Text;
    role: string;
  }>();

  private waypointArrow!: Phaser.GameObjects.Container;
  private waypointGraphics!: Phaser.GameObjects.Graphics;
  private waypointLabel!: Phaser.GameObjects.Text;

  // day/night tint
  private dayTint!: Phaser.GameObjects.Rectangle;

  private selfFootStepPhase = 0; // for bob

  constructor() { super({ key: "GameScene" }); }

  // =======================================================================
  create() {
    try {
      this.createInner();
    } catch (err: any) {
      errBanner.show("[create]", `${err?.message || err}\n${err?.stack || ""}`);
      throw err;
    }
  }

  private createInner() {
    const worldPxW = MAP_W * TILE_SIZE;
    const worldPxH = MAP_H * TILE_SIZE;

    // 1. Render the static world once into a cached texture, then display as Image.
    //    This avoids relying on the deprecated RenderTexture game-object path.
    this.drawWorldInto(worldPxW, worldPxH);

    // 2. Cache NPC defs but wait for state for exact positions.
    //    (NPCs are server-authoritative; they'll be created via onAdd.)

    // 3. Camera bounds.
    this.cameras.main.setBounds(0, 0, worldPxW, worldPxH);
    this.cameras.main.setZoom(1.6);
    this.cameras.main.setBackgroundColor(0x120e0a);
    this.cameras.main.roundPixels = true;

    // 4. Day/night tint layer — follows the camera, covers viewport.
    this.dayTint = this.add.rectangle(0, 0, worldPxW, worldPxH, 0x000020, 0)
      .setOrigin(0, 0).setDepth(1000).setScrollFactor(0);
    this.dayTint.setSize(window.innerWidth, window.innerHeight);

    // 5. Input.
    const kb = this.input.keyboard!;
    this.keys = {
      up: kb.addKey("UP"), down: kb.addKey("DOWN"),
      left: kb.addKey("LEFT"), right: kb.addKey("RIGHT"),
      w: kb.addKey("W"), a: kb.addKey("A"), s: kb.addKey("S"), d: kb.addKey("D"),
      shift: kb.addKey("SHIFT"),
    };

    // 6. Self sprite (built once, updated each frame).
    this.selfContainer = this.add.container(0, 0);
    this.selfShadow = this.add.ellipse(PLAYER_SIZE / 2, PLAYER_SIZE - 1, PLAYER_SIZE * 0.9, 6, 0x000000, 0.45);
    this.selfSprintFx = this.add.ellipse(PLAYER_SIZE / 2, PLAYER_SIZE, PLAYER_SIZE * 1.2, 5, 0xfff0c0, 0.3)
      .setVisible(false);
    this.selfBody = this.add.rectangle(0, 0, PLAYER_SIZE, PLAYER_SIZE, 0xffffff)
      .setStrokeStyle(1, 0x1a1108, 1).setOrigin(0, 0);
    this.selfEye1 = this.add.rectangle(6, 7, 3, 3, 0x1a1108).setOrigin(0, 0);
    this.selfEye2 = this.add.rectangle(13, 7, 3, 3, 0x1a1108).setOrigin(0, 0);
    this.selfHem = this.add.rectangle(0, PLAYER_SIZE - 4, PLAYER_SIZE, 4, 0x000000, 0.4).setOrigin(0, 0);
    this.selfPackage = this.add.rectangle(PLAYER_SIZE / 2, -4, 12, 10, 0xd8c58a)
      .setStrokeStyle(1, 0x5a3a22).setOrigin(0.5, 0).setVisible(false);
    this.selfContainer.add([
      this.selfShadow, this.selfSprintFx, this.selfBody, this.selfEye1, this.selfEye2, this.selfHem, this.selfPackage
    ]);
    this.selfContainer.setDepth(101);

    this.selfLabel = this.add.text(0, 0, "", {
      fontFamily: "monospace", fontSize: "12px", color: "#fff",
      stroke: "#000", strokeThickness: 3,
    }).setOrigin(0.5, 1).setDepth(210);

    // 7. Waypoint arrow (depth above world).
    this.waypointArrow = this.add.container(0, 0).setScrollFactor(0).setDepth(500).setVisible(false);
    this.waypointGraphics = this.add.graphics();
    this.waypointLabel = this.add.text(0, 20, "", {
      fontFamily: "monospace", fontSize: "10px", color: "#1a1108",
      backgroundColor: "#e9c46a", padding: { x: 4, y: 2 },
    }).setOrigin(0.5, 0);
    this.waypointArrow.add([this.waypointGraphics, this.waypointLabel]);

    // 8. Chat input toggle.
    window.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        if (chatInput.style.display === "none" || !chatInput.style.display) {
          chatInput.style.display = "block"; chatInput.focus(); e.preventDefault();
        } else {
          const text = chatInput.value.trim();
          chatInput.value = ""; chatInput.style.display = "none";
          if (text && room) room.send("chat", text);
        }
      } else if (e.key === "Escape" && chatInput.style.display === "block") {
        chatInput.style.display = "none"; chatInput.value = "";
      }
    });

    // 9. Resize handling for day tint.
    this.scale.on("resize", (size: Phaser.Structs.Size) => {
      this.dayTint.setSize(size.width, size.height);
    });

    // 10. Hook Colyseus schema callbacks.
    if (!room) return;
    const $ = getStateCallbacks(room);
    if (!$) {
      console.error("[tallinn] state callbacks unavailable");
      return;
    }

    // Players.
    $(room.state as any).players.onAdd((player: any, sid: string) => {
      if (sid === selfId) {
        this.selfPredicted.x = player.x;
        this.selfPredicted.y = player.y;
        this.selfStamina = player.stamina;
        this.selfBody.fillColor = Phaser.Display.Color.HexStringToColor(player.color).color;
        this.selfLabel.setText(player.name);
        this.selfContainer.setPosition(player.x, player.y);
        this.cameras.main.centerOn(player.x + PLAYER_SIZE / 2, player.y + PLAYER_SIZE / 2);
        this.cameras.main.startFollow(this.selfContainer, true, 0.15, 0.15);
      } else {
        this.addRemote(sid, player);
      }
      $(player).onChange(() => {
        if (sid === selfId) {
          this.selfStamina = player.stamina;
          this.reconcile(player.x, player.y, player.lastProcessedInput);
          this.selfPackage.setVisible(!!player.carryingOrderId);
        } else {
          const r = this.remotes.get(sid);
          if (r) {
            r.buffer.push({
              t: performance.now(),
              x: player.x, y: player.y, facing: player.facing,
              sprinting: player.sprinting, carrying: !!player.carryingOrderId,
            });
            if (r.buffer.length > 30) r.buffer.shift();
          }
        }
      });
    });
    $(room.state as any).players.onRemove((_p: any, sid: string) => {
      const r = this.remotes.get(sid);
      if (r) { r.container.destroy(); r.label.destroy(); this.remotes.delete(sid); }
    });

    // NPCs.
    $(room.state as any).npcs.onAdd((npc: any, id: string) => {
      this.spawnNpc(npc, id);
      $(npc).onChange(() => {
        const v = this.npcVisuals.get(id);
        if (!v) return;
        const hasOrder = !!npc.activeOrderId;
        v.ring.setVisible(hasOrder);
        v.bang.setVisible(hasOrder);
      });
    });
    $(room.state as any).npcs.onRemove((_n: any, id: string) => {
      const v = this.npcVisuals.get(id);
      if (v) { v.container.destroy(); v.nameTag.destroy(); this.npcVisuals.delete(id); }
    });

    // Orders — pop toast on pickup, floater on deliver, flash on expire.
    $(room.state as any).orders.onAdd((_o: any, _id: string) => { /* listener above via order_new message */ });
    $(room.state as any).orders.onRemove((_o: any, _id: string) => { /* ditto */ });
  }

  // =======================================================================
  update(_time: number, deltaMs: number) {
    if (!room) return;
    try { this.updateInner(deltaMs); }
    catch (err: any) { errBanner.show("[update]", `${err?.message}\n${err?.stack || ""}`); throw err; }
  }

  private updateInner(deltaMs: number) {
    if (!room) return;
    const dt = Math.min(0.05, deltaMs / 1000);

    // --- Input gathering ---
    const isTyping = document.activeElement === nameInput || document.activeElement === chatInput;
    let up = false, down = false, left = false, right = false, sprint = false;
    if (!isTyping) {
      up = this.keys.up.isDown || this.keys.w.isDown;
      down = this.keys.down.isDown || this.keys.s.isDown;
      left = this.keys.left.isDown || this.keys.a.isDown;
      right = this.keys.right.isDown || this.keys.d.isDown;
      sprint = this.keys.shift.isDown;
    }

    // --- Local prediction ---
    let dx = 0, dy = 0;
    if (left) dx -= 1; if (right) dx += 1;
    if (up) dy -= 1;   if (down) dy += 1;
    if (dx !== 0 && dy !== 0) { const inv = 1 / Math.sqrt(2); dx *= inv; dy *= inv; }

    const carrying = this.selfPackage.visible;
    const wantSprint = sprint && (dx !== 0 || dy !== 0);
    let speed = PLAYER_WALK_SPEED;
    if (wantSprint && this.selfStamina > 0.02) {
      speed = PLAYER_SPRINT_SPEED;
      this.selfStamina = Math.max(0, this.selfStamina - STAMINA_DRAIN * dt);
    } else {
      this.selfStamina = Math.min(STAMINA_MAX, this.selfStamina + STAMINA_REGEN * dt);
    }
    if (carrying) speed *= 0.92;

    const stepX = dx * speed * dt;
    const stepY = dy * speed * dt;
    let nx = this.selfPredicted.x + stepX;
    if (!this.collidesAt(nx, this.selfPredicted.y)) this.selfPredicted.x = nx;
    let ny = this.selfPredicted.y + stepY;
    if (!this.collidesAt(this.selfPredicted.x, ny)) this.selfPredicted.y = ny;

    const input = { seq: this.nextSeq++, up, down, left, right, sprint: wantSprint && this.selfStamina > 0.02, dt };
    this.pendingInputs.push(input);
    room.send("input", input);

    // --- Self visuals ---
    this.renderSelf(dx, dy, wantSprint, dt);

    // --- Remote interpolation (~100ms behind) ---
    this.renderRemotes();

    // --- NPC idle animation (bang pulse) ---
    for (const [, v] of this.npcVisuals) {
      if (v.bang.visible) {
        const s = 1 + 0.15 * Math.sin(performance.now() / 180);
        v.bang.setScale(s);
        v.ring.setScale(1 + 0.12 * Math.sin(performance.now() / 240));
      }
    }

    // --- Waypoint arrow ---
    this.updateWaypoint();

    // --- Day/night tint ---
    const phase = (room.state as any).dayPhase ?? 0.3;
    const darkness = 0.5 * (1 - Math.cos(phase * Math.PI * 2)) * 0.35; // 0 .. ~0.175
    this.dayTint.setFillStyle(0x10183a, darkness);

    // --- HUD ---
    this.renderHud();

    // --- Delivery juice (queued from server events) ---
    if (pendingDeliveryEffect) {
      const e = pendingDeliveryEffect; pendingDeliveryEffect = null;
      this.burstCoinsAt(this.selfPredicted.x + PLAYER_SIZE / 2, this.selfPredicted.y + PLAYER_SIZE / 2);
      this.floatText(this.selfPredicted.x + PLAYER_SIZE / 2, this.selfPredicted.y - 4,
        `+${e.payout}${e.combo > 1 ? `  ×${e.combo}` : ""}`, e.combo > 1 ? "#ffd166" : "#e9c46a", 16 + e.combo * 2);
      this.cameras.main.shake(180, 0.003 + e.combo * 0.0008);
      if (e.combo > 1) this.screenFlash("#e9c46a", 180);
      this.drawMinimap();
    }

    this.drawMinimap();
    this.selfFootStepPhase += dt * (dx !== 0 || dy !== 0 ? (wantSprint ? 14 : 9) : 0);
  }

  // =======================================================================
  // World render — bake tiles+buildings+props into a cached texture once,
  // then show it as a single Image. No RenderTexture dependency.
  // =======================================================================
  private drawWorldInto(worldPxW: number, worldPxH: number) {
    const gfx = this.add.graphics({ x: 0, y: 0 });
    gfx.setVisible(false);

    // Base tiles.
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const tile = this.map[y][x];
        this.drawTile(gfx, x, y, tile);
      }
    }

    // Buildings (on top of base tiles).
    for (const b of this.buildings) this.drawBuilding(gfx, b);

    // Static prop details: well, stalls, lanterns, trees, stairs.
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const tile = this.map[y][x];
        if (tile === T.WELL)          this.drawWell(gfx, x, y);
        else if (tile === T.MARKET_STALL) this.drawMarketStall(gfx, x, y);
        else if (tile === T.LANTERN)  this.drawLantern(gfx, x, y);
        else if (tile === T.TREE)     this.drawTree(gfx, x, y);
        else if (tile === T.STAIRS)   this.drawStairs(gfx, x, y);
      }
    }

    // Bake to a cached texture, then display it as a single Image.
    // generateTexture: async-safe, universally supported across Phaser 3.x.
    const key = "__tallinn_world";
    if (this.textures.exists(key)) this.textures.remove(key);
    gfx.generateTexture(key, worldPxW, worldPxH);
    gfx.destroy();
    this.add.image(0, 0, key).setOrigin(0, 0).setDepth(0);

    // Building labels (drawn as text objects, not baked into RT).
    for (const b of this.buildings) {
      if (!b.showLabel) continue;
      const cx = (b.x + b.w / 2) * TILE_SIZE;
      const cy = (b.y + b.h / 2) * TILE_SIZE;
      this.add.text(cx, cy + b.h * TILE_SIZE / 2 + 8, b.name, {
        fontFamily: "serif", fontSize: "14px", color: "#f4d58d",
        stroke: "#1a1108", strokeThickness: 3,
      }).setOrigin(0.5).setAlpha(0.95).setDepth(50);
    }

    // Decorative area labels for famous streets/squares.
    const areaLabels: Array<{ x: number; y: number; text: string; size?: number }> = [
      { x: 28, y: 19, text: "Raekoja plats", size: 18 },
      { x: 8, y: 8, text: "Toompea", size: 16 },
      { x: 25, y: 1, text: "Viru värav", size: 12 },
      { x: 15, y: 38, text: "Harju värav", size: 12 },
      { x: 17, y: 13, text: "Pikk jalg", size: 11 },
      { x: 15, y: 12, text: "Lühike jalg", size: 10 },
    ];
    for (const l of areaLabels) {
      this.add.text(l.x * TILE_SIZE, l.y * TILE_SIZE, l.text, {
        fontFamily: "serif", fontSize: `${l.size || 13}px`, color: "#f4d58d",
        stroke: "#1a1108", strokeThickness: 3,
      }).setOrigin(0.5).setAlpha(0.75).setDepth(48);
    }
  }

  private drawTile(g: Phaser.GameObjects.Graphics, x: number, y: number, tile: number) {
    const px = x * TILE_SIZE, py = y * TILE_SIZE;
    const base = TILE_BASE_COLORS[tile] ?? 0x000000;
    g.fillStyle(base, 1);
    g.fillRect(px, py, TILE_SIZE, TILE_SIZE);

    switch (tile) {
      case T.STREET: {
        // Rough cobblestone: multiple small stones with slight variation.
        const seed = (x * 73856093) ^ (y * 19349663);
        g.fillStyle(0x4d4335, 1);
        for (let i = 0; i < 5; i++) {
          const rx = ((seed >>> (i * 3)) & 31);
          const ry = ((seed >>> (i * 5 + 3)) & 31);
          g.fillRect(px + rx, py + ry, 3, 3);
        }
        g.fillStyle(0x7a6a54, 0.8);
        g.fillRect(px + 4, py + 6, 4, 3);
        g.fillRect(px + 18, py + 20, 5, 3);
        break;
      }
      case T.PLAZA: {
        // Polished cobblestone — herringbone-ish pattern.
        const seed = (x * 73856093) ^ (y * 19349663);
        g.fillStyle(0x776553, 1);
        for (let i = 0; i < 4; i++) {
          const rx = 2 + ((seed >>> (i * 4)) & 27);
          const ry = 2 + ((seed >>> (i * 5 + 2)) & 27);
          g.fillRect(px + rx, py + ry, 4, 2);
        }
        g.fillStyle(0x9d8e72, 0.9);
        g.fillRect(px + 10, py + 4, 6, 2);
        g.fillRect(px + 2, py + 20, 5, 2);
        g.fillRect(px + 22, py + 14, 5, 2);
        // subtle highlight line
        g.lineStyle(1, 0xc0a87d, 0.18);
        g.beginPath(); g.moveTo(px, py + 16); g.lineTo(px + TILE_SIZE, py + 16); g.strokePath();
        break;
      }
      case T.TOOMPEA_GROUND: {
        // Warmer, bigger stones.
        g.fillStyle(0x6d5a45, 1);
        g.fillRect(px + 3, py + 3, 8, 8);
        g.fillRect(px + 16, py + 6, 10, 8);
        g.fillRect(px + 6, py + 18, 10, 10);
        g.fillStyle(0xa28566, 0.6);
        g.fillRect(px + 8, py + 5, 3, 2);
        g.fillRect(px + 20, py + 10, 3, 2);
        break;
      }
      case T.GRASS: {
        g.fillStyle(0x546b35, 1);
        g.fillRect(px + 4, py + 10, 3, 2);
        g.fillRect(px + 18, py + 20, 3, 2);
        g.fillRect(px + 12, py + 4, 3, 2);
        break;
      }
      case T.WALL: {
        // Medieval stonework with crenellations on the outermost row.
        g.fillStyle(0x554638, 1);
        g.fillRect(px + 1, py + 1, TILE_SIZE - 2, TILE_SIZE - 2);
        g.fillStyle(0x35281e, 1);
        for (let ly = 0; ly < TILE_SIZE; ly += 8) g.fillRect(px, py + ly, TILE_SIZE, 1);
        for (let lx = 0; lx < TILE_SIZE; lx += 10) g.fillRect(px + lx, py, 1, TILE_SIZE);
        // Highlight
        g.fillStyle(0x7a6850, 0.35);
        g.fillRect(px + 2, py + 2, TILE_SIZE - 4, 2);
        // Crenellation on outer rows
        if (y === 0 || x === 0 || y === MAP_H - 1 || x === MAP_W - 1) {
          g.fillStyle(0x1f1a14, 1);
          for (let cx = 0; cx < TILE_SIZE; cx += 8) g.fillRect(px + cx, py, 4, 4);
        }
        break;
      }
      case T.CASTLE_WALL: {
        g.fillStyle(0x3f3227, 1);
        g.fillRect(px + 1, py + 1, TILE_SIZE - 2, TILE_SIZE - 2);
        g.fillStyle(0x26190f, 1);
        g.fillRect(px + 6, py + 4, 4, 5);
        g.fillRect(px + 20, py + 10, 4, 5);
        g.fillRect(px + 12, py + 20, 4, 5);
        g.fillStyle(0x5d4a38, 0.35);
        g.fillRect(px + 2, py + 2, TILE_SIZE - 4, 2);
        break;
      }
      case T.GATE: {
        g.fillStyle(0x5a4232, 1);
        g.fillRect(px + 3, py + 3, TILE_SIZE - 6, TILE_SIZE - 6);
        g.fillStyle(0x1e140c, 1);
        g.fillRect(px + 10, py + 10, TILE_SIZE - 20, TILE_SIZE - 12);
        g.lineStyle(1, 0x7c6449, 1);
        g.strokeRect(px + 10, py + 10, TILE_SIZE - 20, TILE_SIZE - 12);
        break;
      }
      case T.WATER: {
        g.fillStyle(0x294863, 1);
        g.fillRect(px, py, TILE_SIZE, TILE_SIZE);
        g.fillStyle(0x3a6389, 0.9);
        g.fillRect(px + 2, py + 10, TILE_SIZE - 4, 3);
        g.fillStyle(0x4a7a9a, 0.7);
        g.fillRect(px + 4, py + 20, TILE_SIZE - 10, 2);
        break;
      }
      default: break;
    }
  }

  // -------------------- buildings --------------------
  private drawBuilding(g: Phaser.GameObjects.Graphics, b: Building) {
    const px = b.x * TILE_SIZE, py = b.y * TILE_SIZE;
    const w = b.w * TILE_SIZE, h = b.h * TILE_SIZE;

    switch (b.style) {
      case "merchant":     return this.drawMerchantHouse(g, b, px, py, w, h);
      case "townhall":     return this.drawTownHall(g, b, px, py, w, h);
      case "oleviste":     return this.drawOleviste(g, b, px, py, w, h);
      case "pikkhermann":  return this.drawPikkHermann(g, b, px, py, w, h);
      case "domechurch":   return this.drawDomeChurch(g, b, px, py, w, h);
      default:             return;
    }
  }

  private drawMerchantHouse(g: Phaser.GameObjects.Graphics, b: Building, px: number, py: number, w: number, h: number) {
    const facade = Phaser.Display.Color.HexStringToColor(b.facade || "#d8a785").color;
    const roof = Phaser.Display.Color.HexStringToColor(b.roof || "#8e3b26").color;
    const accent = Phaser.Display.Color.HexStringToColor(b.accent || "#5a2f20").color;

    // body
    g.fillStyle(facade, 1);
    g.fillRect(px + 2, py + 6, w - 4, h - 8);
    // vertical facade seams
    g.fillStyle(accent, 0.25);
    for (let sx = 8; sx < w - 4; sx += 10) g.fillRect(px + sx, py + 6, 1, h - 8);

    // windows — diamond panes rows
    const winCols = Math.max(2, Math.floor((w - 6) / 10));
    const winRowsN = Math.max(1, Math.floor((h - 14) / 10));
    for (let r = 0; r < winRowsN; r++) {
      for (let c = 0; c < winCols; c++) {
        const wx = px + 6 + c * ((w - 8) / winCols);
        const wy = py + 10 + r * 10;
        g.fillStyle(0xd9b26a, 0.85);
        g.fillRect(wx, wy, 6, 5);
        g.fillStyle(accent, 0.8);
        g.fillRect(wx + 2, wy, 2, 5);
        g.fillRect(wx, wy + 2, 6, 1);
      }
    }

    // door on ground-floor center
    g.fillStyle(accent, 1);
    g.fillRect(px + w / 2 - 3, py + h - 10, 6, 8);
    g.fillStyle(0xe7c258, 0.9);
    g.fillRect(px + w / 2 - 1, py + h - 6, 1, 1); // door handle

    // roof + gable
    if (b.gable === "stepped") {
      // stepped Gothic gable: rising steps from corners to peak
      const steps = Math.min(4, Math.max(2, Math.floor(w / 12)));
      const stepW = Math.floor((w - 6) / (steps * 2 + 1));
      g.fillStyle(roof, 1);
      g.fillRect(px + 2, py + 2, w - 4, 5);
      for (let i = 0; i < steps; i++) {
        const leftX = px + 2 + stepW * (i + 1);
        const rightX = px + w - 2 - stepW * (i + 1) - stepW;
        const h2 = 4 + i * 3;
        g.fillRect(leftX, py - h2, stepW, h2 + 4);
        g.fillRect(rightX, py - h2, stepW, h2 + 4);
      }
      // peak
      g.fillRect(px + w / 2 - stepW / 2, py - (4 + steps * 3) - 2, stepW, 6);
    } else {
      // triangle gable
      g.fillStyle(roof, 1);
      g.fillRect(px + 2, py + 2, w - 4, 5);
      g.fillTriangle(px + 2, py + 2, px + w - 2, py + 2, px + w / 2, py - 8);
    }

    // subtle dark baseline
    g.fillStyle(0x1b0f09, 0.3);
    g.fillRect(px + 2, py + h - 3, w - 4, 2);
  }

  private drawTownHall(g: Phaser.GameObjects.Graphics, b: Building, px: number, py: number, w: number, h: number) {
    const facade = Phaser.Display.Color.HexStringToColor(b.facade || "#d8cfae").color;
    const roof = Phaser.Display.Color.HexStringToColor(b.roof || "#8e3b26").color;
    const accent = Phaser.Display.Color.HexStringToColor(b.accent || "#5a4a30").color;

    // Main body
    g.fillStyle(facade, 1);
    g.fillRect(px + 2, py + 16, w - 4, h - 18);

    // Gothic arcaded base (pointed arches)
    const archCount = 6;
    const archW = (w - 8) / archCount;
    for (let i = 0; i < archCount; i++) {
      const ax = px + 4 + i * archW;
      g.fillStyle(accent, 0.9);
      g.fillRect(ax + 1, py + h - 18, archW - 2, 16);
      g.fillStyle(0x1b130b, 1);
      g.fillRect(ax + 3, py + h - 15, archW - 6, 10);
      // pointed arch shape hint
      g.fillStyle(accent, 1);
      g.fillTriangle(ax + 3, py + h - 15, ax + archW - 3, py + h - 15, ax + archW / 2, py + h - 20);
    }

    // Two rows of tall narrow windows on the body
    for (let r = 0; r < 2; r++) {
      for (let i = 0; i < 8; i++) {
        const wx = px + 5 + i * ((w - 10) / 8);
        const wy = py + 20 + r * 14;
        g.fillStyle(0xd9b26a, 0.9);
        g.fillRect(wx, wy, 4, 10);
        g.fillStyle(accent, 0.9);
        g.fillRect(wx + 2, wy, 1, 10);
        g.fillRect(wx, wy + 4, 4, 1);
      }
    }

    // Stepped gable on main roof
    g.fillStyle(roof, 1);
    g.fillRect(px + 2, py + 12, w - 4, 6);
    const steps = 5;
    const stepW = Math.floor((w - 4) / (steps * 2 + 1));
    for (let i = 0; i < steps; i++) {
      const leftX = px + 2 + stepW * (i + 1);
      const rightX = px + w - 2 - stepW * (i + 1) - stepW;
      const hUp = 4 + i * 4;
      g.fillRect(leftX, py + 12 - hUp, stepW, hUp + 4);
      g.fillRect(rightX, py + 12 - hUp, stepW, hUp + 4);
    }

    // -------- Tall Gothic tower on the left (iconic) --------
    const towerX = px + w * 0.18;
    const towerW = Math.max(22, Math.floor(w * 0.17));
    const spireH = b.spire || 140;
    const towerTopY = py - spireH;
    // tower shaft
    g.fillStyle(facade, 1);
    g.fillRect(towerX - towerW / 2, towerTopY + 34, towerW, spireH - 34);
    g.fillStyle(accent, 0.3);
    g.fillRect(towerX - towerW / 2, towerTopY + 34, 2, spireH - 34);
    g.fillRect(towerX + towerW / 2 - 2, towerTopY + 34, 2, spireH - 34);

    // clock face
    g.fillStyle(0xe7c258, 1);
    g.fillCircle(towerX, towerTopY + 80, 7);
    g.fillStyle(0x1b130b, 1);
    g.fillCircle(towerX, towerTopY + 80, 5);
    g.lineStyle(1, 0xe7c258, 1);
    g.beginPath(); g.moveTo(towerX, towerTopY + 80); g.lineTo(towerX + 3, towerTopY + 78); g.strokePath();
    g.beginPath(); g.moveTo(towerX, towerTopY + 80); g.lineTo(towerX, towerTopY + 76); g.strokePath();

    // tower windows
    for (let i = 0; i < 3; i++) {
      g.fillStyle(0x1b130b, 1);
      g.fillRect(towerX - 2, towerTopY + 40 + i * 20, 4, 6);
    }

    // Octagonal base platform
    g.fillStyle(0x8a7050, 1);
    g.fillRect(towerX - towerW / 2 - 2, towerTopY + 30, towerW + 4, 6);

    // Tall green copper spire (slim)
    g.fillStyle(0x3a6b5a, 1);
    g.fillTriangle(
      towerX - towerW / 2 + 2, towerTopY + 34,
      towerX + towerW / 2 - 2, towerTopY + 34,
      towerX, towerTopY - 6,
    );
    // Spire highlight
    g.fillStyle(0x5a8e77, 0.7);
    g.fillTriangle(
      towerX - towerW / 2 + 4, towerTopY + 34,
      towerX, towerTopY + 34,
      towerX - 1, towerTopY - 2,
    );
    // Weathervane (Vana Toomas): flag pole + silhouette
    g.fillStyle(0x2a1408, 1);
    g.fillRect(towerX - 1, towerTopY - 20, 2, 18);
    g.fillStyle(0xd9a74a, 1);
    // simple knight figure silhouette
    g.fillRect(towerX - 5, towerTopY - 26, 10, 3);   // banner
    g.fillRect(towerX - 2, towerTopY - 30, 3, 5);    // body
    g.fillRect(towerX - 3, towerTopY - 32, 5, 3);    // hat

    // Base shadow
    g.fillStyle(0x0f0907, 0.4);
    g.fillRect(px + 2, py + h - 3, w - 4, 2);
  }

  private drawOleviste(g: Phaser.GameObjects.Graphics, b: Building, px: number, py: number, w: number, h: number) {
    const facade = Phaser.Display.Color.HexStringToColor(b.facade || "#9b8a78").color;
    const roof = Phaser.Display.Color.HexStringToColor(b.roof || "#3a2418").color;

    // base hall
    g.fillStyle(facade, 1);
    g.fillRect(px + 2, py + 24, w - 4, h - 26);
    // pointed arch windows
    for (let i = 0; i < 3; i++) {
      const wx = px + 4 + i * ((w - 8) / 3);
      g.fillStyle(0x1b130b, 1);
      g.fillRect(wx, py + 30, 4, 14);
      g.fillTriangle(wx, py + 30, wx + 4, py + 30, wx + 2, py + 26);
    }
    // massive central tower
    const centerX = px + w / 2;
    const towerW = Math.max(24, w * 0.4);
    const spireH = b.spire || 200;
    const baseTop = py + 18;
    // tower body
    g.fillStyle(facade, 1);
    g.fillRect(centerX - towerW / 2, baseTop - spireH + 40, towerW, spireH + 10);
    // tower bands
    g.fillStyle(0x6a5a48, 1);
    for (let i = 0; i < 6; i++) g.fillRect(centerX - towerW / 2, baseTop - spireH + 60 + i * 22, towerW, 2);
    // arched windows on tower
    for (let i = 0; i < 4; i++) {
      g.fillStyle(0x1b130b, 1);
      g.fillRect(centerX - 3, baseTop - spireH + 70 + i * 30, 6, 10);
    }
    // tall pointy spire (the tallest building in world once)
    g.fillStyle(roof, 1);
    g.fillTriangle(
      centerX - towerW / 2 + 2, baseTop - spireH + 40,
      centerX + towerW / 2 - 2, baseTop - spireH + 40,
      centerX, baseTop - spireH - 30,
    );
    // spire highlight
    g.fillStyle(0x5a3a28, 0.7);
    g.fillTriangle(
      centerX - towerW / 2 + 4, baseTop - spireH + 40,
      centerX, baseTop - spireH + 40,
      centerX - 2, baseTop - spireH - 20,
    );
    // cross on top
    g.fillStyle(0xd9a74a, 1);
    g.fillRect(centerX - 1, baseTop - spireH - 40, 2, 14);
    g.fillRect(centerX - 5, baseTop - spireH - 32, 10, 2);

    // small side roof
    g.fillStyle(roof, 1);
    g.fillRect(px + 2, py + 20, w - 4, 4);
    g.fillTriangle(px + 2, py + 20, px + w - 2, py + 20, px + w / 2, py + 14);

    g.fillStyle(0x0f0907, 0.4);
    g.fillRect(px + 2, py + h - 3, w - 4, 2);
  }

  private drawPikkHermann(g: Phaser.GameObjects.Graphics, b: Building, px: number, py: number, w: number, h: number) {
    const facade = Phaser.Display.Color.HexStringToColor(b.facade || "#6a6058").color;
    const spireH = b.spire || 80;
    const centerX = px + w / 2;
    const baseW = w - 6;

    // round-ish tower body (approximate round with stacked rectangles)
    g.fillStyle(facade, 1);
    g.fillRect(px + 3, py + 6, baseW, h - 8);
    g.fillRect(centerX - baseW / 2 - 2, py + 10, baseW + 4, h - 14); // slight bulge
    // stone bands
    g.fillStyle(0x3e3730, 1);
    for (let i = 0; i < 6; i++) g.fillRect(px + 3, py + 8 + i * 10, baseW, 1);
    // arrow slits
    for (let i = 0; i < 4; i++) {
      g.fillStyle(0x15110d, 1);
      g.fillRect(centerX - 1, py + 14 + i * 14, 2, 8);
    }

    // tall tower extension upward
    g.fillStyle(facade, 1);
    g.fillRect(centerX - 8, py + 6 - spireH, 16, spireH + 6);
    // battlements
    g.fillStyle(0x25201a, 1);
    for (let cx = -8; cx < 10; cx += 4) g.fillRect(centerX + cx, py + 6 - spireH - 4, 2, 6);

    // Flagpole + Estonian flag (blue-black-white)
    g.fillStyle(0x1b130b, 1);
    g.fillRect(centerX - 1, py - spireH - 14, 2, 10);
    g.fillStyle(0x0f4da2, 1);   // blue
    g.fillRect(centerX + 1, py - spireH - 14, 14, 3);
    g.fillStyle(0x111111, 1);   // black
    g.fillRect(centerX + 1, py - spireH - 11, 14, 3);
    g.fillStyle(0xf0efe8, 1);   // white
    g.fillRect(centerX + 1, py - spireH - 8, 14, 3);
  }

  private drawDomeChurch(g: Phaser.GameObjects.Graphics, b: Building, px: number, py: number, w: number, h: number) {
    const facade = Phaser.Display.Color.HexStringToColor(b.facade || "#e4dcc9").color;
    const roof = Phaser.Display.Color.HexStringToColor(b.roof || "#7a3321").color;

    g.fillStyle(facade, 1);
    g.fillRect(px + 2, py + 10, w - 4, h - 12);
    // white-wash highlight
    g.fillStyle(0xffffff, 0.15);
    g.fillRect(px + 2, py + 12, w - 4, 2);

    // Stepped roof
    g.fillStyle(roof, 1);
    g.fillRect(px + 2, py + 6, w - 4, 6);
    g.fillTriangle(px + 2, py + 6, px + w - 2, py + 6, px + w / 2, py - 6);

    // Small squat tower in center with baroque dome
    const centerX = px + w / 2;
    g.fillStyle(facade, 1);
    g.fillRect(centerX - 8, py - 26, 16, 30);
    g.fillStyle(0x7a3321, 1);
    // onion dome-ish
    g.fillEllipse(centerX, py - 32, 20, 16);
    g.fillStyle(0xd9a74a, 1);
    g.fillRect(centerX - 1, py - 46, 2, 12);
    // cross
    g.fillStyle(0xd9a74a, 1);
    g.fillRect(centerX - 1, py - 54, 2, 8);
    g.fillRect(centerX - 4, py - 50, 8, 2);

    // arched windows
    for (let i = 0; i < 3; i++) {
      const wx = px + 4 + i * ((w - 8) / 3);
      g.fillStyle(0x1b130b, 1);
      g.fillRect(wx, py + 14, 5, 10);
      g.fillTriangle(wx, py + 14, wx + 5, py + 14, wx + 2, py + 10);
    }
  }

  // -------------------- tile decorations --------------------
  private drawWell(g: Phaser.GameObjects.Graphics, x: number, y: number) {
    const cx = x * TILE_SIZE + TILE_SIZE / 2;
    const cy = y * TILE_SIZE + TILE_SIZE / 2;
    g.fillStyle(0x4a4138, 1);
    g.fillCircle(cx, cy, 11);
    g.fillStyle(0x1a1510, 1);
    g.fillCircle(cx, cy, 7);
    g.fillStyle(0x5a4b3b, 1);
    g.fillRect(cx - 2, cy - 16, 4, 10);  // upright
    g.fillRect(cx - 10, cy - 16, 20, 3); // cross beam
    g.fillStyle(0x2a1a10, 1);
    g.fillRect(cx - 2, cy - 10, 4, 6);  // bucket
  }

  private drawMarketStall(g: Phaser.GameObjects.Graphics, x: number, y: number) {
    const px = x * TILE_SIZE, py = y * TILE_SIZE;
    const tarp = [0xa3786a, 0xb8914a, 0x6b8a6a, 0x7b6a9a][(x + y) % 4];
    g.fillStyle(0x3e2a1c, 1);
    g.fillRect(px + 4, py + 10, TILE_SIZE - 8, 8);  // table
    g.fillStyle(tarp, 1);
    g.fillRect(px + 2, py + 4, TILE_SIZE - 4, 8);    // canopy
    g.fillStyle(0x1a1108, 0.5);
    for (let i = 0; i < 5; i++) g.fillRect(px + 4 + i * 5, py + 12, 2, 2); // goods
  }

  private drawLantern(g: Phaser.GameObjects.Graphics, x: number, y: number) {
    const cx = x * TILE_SIZE + TILE_SIZE / 2;
    const py = y * TILE_SIZE;
    g.fillStyle(0x2a1a10, 1);
    g.fillRect(cx - 1, py + 10, 2, 18);
    g.fillStyle(0xe7c258, 1);
    g.fillRect(cx - 4, py + 6, 8, 6);
    g.fillStyle(0x2a1a10, 1);
    g.fillRect(cx - 1, py + 4, 2, 3);
  }

  private drawTree(g: Phaser.GameObjects.Graphics, x: number, y: number) {
    const cx = x * TILE_SIZE + TILE_SIZE / 2;
    const cy = y * TILE_SIZE + TILE_SIZE / 2;
    g.fillStyle(0x1f3b1a, 1);
    g.fillCircle(cx, cy, 12);
    g.fillStyle(0x2f5a24, 1);
    g.fillCircle(cx - 3, cy - 3, 8);
    g.fillStyle(0x2a1a10, 1);
    g.fillRect(cx - 2, cy + 8, 4, 6);
  }

  private drawStairs(g: Phaser.GameObjects.Graphics, x: number, y: number) {
    const px = x * TILE_SIZE, py = y * TILE_SIZE;
    g.fillStyle(0x7e6a50, 1);
    g.fillRect(px, py, TILE_SIZE, TILE_SIZE);
    g.fillStyle(0x4a3a28, 1);
    for (let i = 0; i < 4; i++) g.fillRect(px + 2, py + 4 + i * 7, TILE_SIZE - 4, 2);
    g.fillStyle(0xaa9070, 0.5);
    g.fillRect(px + 2, py + 2, TILE_SIZE - 4, 1);
  }

  // =======================================================================
  // NPC visuals
  // =======================================================================
  private spawnNpc(npc: any, id: string) {
    const style = NPC_STYLE[npc.role] || { body: 0x7b6a58, hat: 0x3a2a20 };
    const c = this.add.container(npc.x - 10, npc.y - 10).setDepth(95);

    // shadow
    const shadow = this.add.ellipse(10, 22, 22, 6, 0x000000, 0.4);
    // body
    const body = this.add.rectangle(2, 2, 16, 22, style.body).setOrigin(0, 0).setStrokeStyle(1, 0x1a1108);
    // head
    const head = this.add.rectangle(4, -6, 12, 10, 0xf0c89a).setOrigin(0, 0).setStrokeStyle(1, 0x1a1108);
    // hat
    const hat = this.add.rectangle(3, -10, 14, 5, style.hat).setOrigin(0, 0);
    // eyes
    const e1 = this.add.rectangle(7, -2, 2, 2, 0x111).setOrigin(0, 0);
    const e2 = this.add.rectangle(12, -2, 2, 2, 0x111).setOrigin(0, 0);

    c.add([shadow, body, head, hat, e1, e2]);

    // Attention ring (visible when this NPC has an active order)
    const ring = this.add.circle(10, 2, 18, 0xe9c46a, 0).setStrokeStyle(2, 0xe9c46a, 0.8).setVisible(false);
    const bang = this.add.text(10, -26, "!", {
      fontFamily: "Georgia,serif", fontSize: "22px", color: "#ffd166",
      stroke: "#1a1108", strokeThickness: 3, fontStyle: "bold",
    }).setOrigin(0.5).setVisible(false);
    c.add([ring, bang]);

    // Nametag below
    const nameTag = this.add.text(npc.x, npc.y + 18, npc.shortName, {
      fontFamily: "monospace", fontSize: "10px", color: "#f4d58d",
      stroke: "#1a1108", strokeThickness: 3,
    }).setOrigin(0.5, 0).setDepth(96).setAlpha(0.85);

    this.npcVisuals.set(id, { container: c, ring, bang, nameTag, role: npc.role });
  }

  // =======================================================================
  // Remote players
  // =======================================================================
  private addRemote(sid: string, player: any) {
    const c = this.add.container(player.x, player.y);
    const shadow = this.add.ellipse(PLAYER_SIZE / 2, PLAYER_SIZE - 1, PLAYER_SIZE * 0.9, 6, 0x000000, 0.45);
    const body = this.add.rectangle(0, 0, PLAYER_SIZE, PLAYER_SIZE,
      Phaser.Display.Color.HexStringToColor(player.color).color).setStrokeStyle(1, 0x1a1108, 1).setOrigin(0, 0);
    const e1 = this.add.rectangle(6, 7, 3, 3, 0x1a1108).setOrigin(0, 0);
    const e2 = this.add.rectangle(13, 7, 3, 3, 0x1a1108).setOrigin(0, 0);
    const hem = this.add.rectangle(0, PLAYER_SIZE - 4, PLAYER_SIZE, 4, 0x000000, 0.4).setOrigin(0, 0);
    const pack = this.add.rectangle(PLAYER_SIZE / 2, -4, 12, 10, 0xd8c58a)
      .setStrokeStyle(1, 0x5a3a22).setOrigin(0.5, 0).setVisible(!!player.carryingOrderId);
    c.add([shadow, body, e1, e2, hem, pack]);
    c.setDepth(100);
    const label = this.add.text(player.x + PLAYER_SIZE / 2, player.y - 2, player.name, {
      fontFamily: "monospace", fontSize: "11px", color: "#fff",
      stroke: "#000", strokeThickness: 3,
    }).setOrigin(0.5, 1).setDepth(199);
    this.remotes.set(sid, {
      container: c, body, pack, label,
      buffer: [{ t: performance.now(), x: player.x, y: player.y, facing: player.facing, sprinting: !!player.sprinting, carrying: !!player.carryingOrderId }],
      color: player.color, name: player.name,
    });
  }

  // =======================================================================
  // Rendering self + remotes
  // =======================================================================
  private renderSelf(dx: number, dy: number, wantSprint: boolean, dt: number) {
    const x = Math.round(this.selfPredicted.x);
    const y = Math.round(this.selfPredicted.y);
    this.selfContainer.setPosition(x, y);
    this.selfLabel.setPosition(x + PLAYER_SIZE / 2, y - 2);

    // Foot bob: vertical squash during walk.
    const moving = (dx !== 0 || dy !== 0);
    const bob = moving ? Math.sin(this.selfFootStepPhase) * 1.2 : 0;
    this.selfBody.y = bob;
    this.selfEye1.y = 7 + bob;
    this.selfEye2.y = 7 + bob;
    this.selfHem.y = PLAYER_SIZE - 4 + bob;
    this.selfPackage.y = -4 + bob;

    // Eye direction — shift eyes a hair in facing direction.
    // Infer facing from input (we don't wait for server).
    let facing = 0;
    if (Math.abs(dx) > Math.abs(dy)) facing = dx > 0 ? 3 : dx < 0 ? 2 : 0;
    else if (dy !== 0) facing = dy > 0 ? 0 : 1;
    const ox = facing === 3 ? 1 : facing === 2 ? -1 : 0;
    const oy = facing === 0 ? 1 : facing === 1 ? -1 : 0;
    this.selfEye1.x = 6 + ox; this.selfEye1.y = 7 + oy + bob;
    this.selfEye2.x = 13 + ox; this.selfEye2.y = 7 + oy + bob;

    // Sprint speed lines.
    const sprinting = wantSprint && this.selfStamina > 0.02 && moving;
    this.selfSprintFx.setVisible(sprinting);
    if (sprinting) {
      this.selfSprintFx.fillAlpha = 0.25 + 0.25 * Math.sin(this.selfFootStepPhase * 1.6);
    }
  }

  private renderRemotes() {
    const renderT = performance.now() - 100;
    for (const [, r] of this.remotes) {
      const buf = r.buffer;
      if (buf.length === 0) continue;
      let a = buf[0], b = buf[buf.length - 1];
      for (let i = 0; i < buf.length - 1; i++) {
        if (buf[i].t <= renderT && buf[i + 1].t >= renderT) { a = buf[i]; b = buf[i + 1]; break; }
      }
      const span = Math.max(1, b.t - a.t);
      const alpha = Math.max(0, Math.min(1, (renderT - a.t) / span));
      const rx = a.x + (b.x - a.x) * alpha;
      const ry = a.y + (b.y - a.y) * alpha;
      r.container.setPosition(Math.round(rx), Math.round(ry));
      r.label.setPosition(rx + PLAYER_SIZE / 2, ry - 2);
      r.pack.setVisible(b.carrying);
    }
  }

  // =======================================================================
  // Collision (client prediction)
  // =======================================================================
  private collidesAt(px: number, py: number): boolean {
    const w = PLAYER_SIZE, h = PLAYER_SIZE;
    const left = Math.floor(px / TILE_SIZE);
    const right = Math.floor((px + w - 1) / TILE_SIZE);
    const top = Math.floor(py / TILE_SIZE);
    const bottom = Math.floor((py + h - 1) / TILE_SIZE);
    for (let ty = top; ty <= bottom; ty++) {
      for (let tx = left; tx <= right; tx++) {
        if (ty < 0 || ty >= MAP_H || tx < 0 || tx >= MAP_W) return true;
        if (isSolid(this.map[ty][tx])) return true;
      }
    }
    return false;
  }

  private reconcile(serverX: number, serverY: number, lastProcessedInput: number) {
    this.pendingInputs = this.pendingInputs.filter((i) => i.seq > lastProcessedInput);
    let x = serverX, y = serverY;
    for (const input of this.pendingInputs) {
      let dx = 0, dy = 0;
      if (input.left) dx -= 1; if (input.right) dx += 1;
      if (input.up) dy -= 1; if (input.down) dy += 1;
      if (dx !== 0 && dy !== 0) { const inv = 1 / Math.sqrt(2); dx *= inv; dy *= inv; }
      const speed = (input.sprint ? PLAYER_SPRINT_SPEED : PLAYER_WALK_SPEED) * (this.selfPackage.visible ? 0.92 : 1);
      const stepX = dx * speed * input.dt;
      const stepY = dy * speed * input.dt;
      let nx = x + stepX;
      if (!this.collidesAt(nx, y)) x = nx;
      let ny = y + stepY;
      if (!this.collidesAt(x, ny)) y = ny;
    }
    const dx = x - this.selfPredicted.x, dy = y - this.selfPredicted.y;
    const err = Math.sqrt(dx * dx + dy * dy);
    if (err > 60) { this.selfPredicted.x = x; this.selfPredicted.y = y; }
    else { this.selfPredicted.x += dx * 0.3; this.selfPredicted.y += dy * 0.3; }
  }

  // =======================================================================
  // HUD / Waypoint / Minimap
  // =======================================================================
  private renderHud() {
    if (!room) return;
    const state: any = room.state;
    if (!state?.players?.get) return;
    const self = state.players.get(selfId);
    if (!self) return;

    const rank = rankFor(self.score || 0);
    const best = getBestScore();
    if (self.score > best) setBestScore(self.score);

    scoreCard.innerHTML = `
      <div class="score-num">${self.score || 0}<span class="unit">marka</span></div>
      <div class="score-rank">${rank}</div>
      <div class="score-sub">deliveries: ${self.deliveries || 0} · best: ${Math.max(best, self.score || 0)}${self.combo > 0 ? ` · <span class="combo">×${self.combo} combo</span>` : ""}</div>
    `;

    // Active order card
    let activeOrder: any = null;
    if (self.carryingOrderId && state.orders?.get) activeOrder = state.orders.get(self.carryingOrderId);
    if (activeOrder) {
      const toNpc = state.npcs?.get?.(activeOrder.toNpcId);
      const timeLeft = Math.max(0, Math.floor((activeOrder.expiresAt - (state.serverNow || Date.now())) / 1000));
      const pct = Math.max(0, Math.min(100, (timeLeft / 60) * 100));
      orderCard.style.display = "block";
      orderCard.innerHTML = `
        <div class="order-head">CARRYING</div>
        <div class="order-body">${activeOrder.itemEn} → <b>${toNpc?.shortName || "?"}</b></div>
        <div class="timer-bar"><div class="fill" style="width:${pct}%; background:${timeLeft < 10 ? "#ef476f" : timeLeft < 20 ? "#f4a261" : "#2a9d8f"}"></div></div>
        <div class="order-foot">${timeLeft}s · +${activeOrder.reward} marka</div>
      `;
    } else {
      // Show available orders summary (nearest)
      const ordersMap: any[] = state.orders?.values ? Array.from(state.orders.values()) : [];
      const availableCount = ordersMap.filter((o: any) => o.status === "available").length;
      if (availableCount > 0) {
        orderCard.style.display = "block";
        orderCard.innerHTML = `
          <div class="order-head">AVAILABLE</div>
          <div class="order-body">${availableCount} NPC${availableCount === 1 ? "" : "s"} with <b>!</b> — walk up to accept</div>
        `;
      } else {
        orderCard.style.display = "none";
      }
    }

    // Stamina
    stamBarEl.style.width = `${Math.max(0, Math.min(100, self.stamina * 100))}%`;
    if (self.stamina < 0.15) stamBarEl.classList.add("low"); else stamBarEl.classList.remove("low");

    // Leaderboard
    const rows: Array<{ name: string; score: number; mine: boolean }> = [];
    if (state.players?.forEach) {
      state.players.forEach((p: any, sid: string) => {
        rows.push({ name: p.name || sid.slice(0, 4), score: p.score || 0, mine: sid === selfId });
      });
    }
    rows.sort((a, b) => b.score - a.score);
    leaderboard.innerHTML = `
      <div class="lb-head">Kaupmehed</div>
      ${rows.slice(0, 6).map((r, i) => `
        <div class="lb-row ${r.mine ? "me" : ""}">
          <span class="rank">${i + 1}</span>
          <span class="name">${escapeHtml(r.name)}</span>
          <span class="pts">${r.score}</span>
        </div>`).join("")}
    `;

    hud.innerHTML = `
      <div class="hud-help">
        <b>WASD</b> move · <b>Shift</b> sprint · <b>Enter</b> chat · walk onto <span class="hud-bang">!</span> NPCs to take orders
      </div>`;
  }

  private updateWaypoint() {
    if (!room) { this.waypointArrow.setVisible(false); return; }
    const players = (room.state as any)?.players;
    const orders = (room.state as any)?.orders;
    const npcs = (room.state as any)?.npcs;
    if (!players?.get || !orders?.get || !npcs?.get) { this.waypointArrow.setVisible(false); return; }
    const self = players.get(selfId);
    if (!self || !self.carryingOrderId) { this.waypointArrow.setVisible(false); return; }
    const order = orders.get(self.carryingOrderId);
    if (!order) { this.waypointArrow.setVisible(false); return; }
    const dst = npcs.get(order.toNpcId);
    if (!dst) { this.waypointArrow.setVisible(false); return; }

    const cam = this.cameras.main;
    const viewX = cam.scrollX + cam.width / 2 / cam.zoom;
    const viewY = cam.scrollY + cam.height / 2 / cam.zoom;

    const dx = dst.x - viewX, dy = dst.y - viewY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    // If near, hide arrow (player can see destination)
    if (dist < 220) { this.waypointArrow.setVisible(false); return; }

    const angle = Math.atan2(dy, dx);
    const margin = 50;
    const viewW = cam.width;
    const viewH = cam.height;
    const halfW = viewW / 2 - margin, halfH = viewH / 2 - margin;
    const tan = Math.abs(Math.tan(angle));
    let ax = 0, ay = 0;
    if (halfH / Math.max(0.0001, halfW) > tan) {
      ax = Math.sign(Math.cos(angle)) * halfW;
      ay = Math.tan(angle) * ax;
    } else {
      ay = Math.sign(Math.sin(angle)) * halfH;
      ax = ay / Math.tan(angle);
    }

    this.waypointArrow.setVisible(true);
    this.waypointArrow.setPosition(viewW / 2 + ax, viewH / 2 + ay);
    this.waypointArrow.setRotation(angle);

    this.waypointGraphics.clear();
    this.waypointGraphics.fillStyle(0xe9c46a, 1);
    this.waypointGraphics.beginPath();
    this.waypointGraphics.moveTo(14, 0);
    this.waypointGraphics.lineTo(-8, -8);
    this.waypointGraphics.lineTo(-4, 0);
    this.waypointGraphics.lineTo(-8, 8);
    this.waypointGraphics.closePath();
    this.waypointGraphics.fillPath();
    this.waypointGraphics.lineStyle(1, 0x1a1108, 1);
    this.waypointGraphics.strokePath();

    this.waypointLabel.setText(`${dst.shortName} · ${Math.floor(dist / TILE_SIZE)}t`);
    this.waypointLabel.setRotation(-angle);
  }

  private drawMinimap() {
    const ctx = minimap.getContext("2d");
    if (!ctx) return;
    const sx = minimap.width / MAP_W;
    const sy = minimap.height / MAP_H;

    // Background by tile category for readability
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const t = this.map[y][x];
        let c = "#1a1108";
        if (t === T.PLAZA) c = "#cfb088";
        else if (t === T.TOOMPEA_GROUND) c = "#8a7158";
        else if (t === T.STREET) c = "#5a4a3a";
        else if (t === T.STAIRS) c = "#7a6a54";
        else if (t === T.WALL || t === T.CASTLE_WALL) c = "#1a1108";
        else if (t === T.TOWER) c = "#3a2d22";
        else if (t === T.HOUSE) c = "#a6806a";
        else if (t === T.CHURCH) c = "#1e1814";
        else if (t === T.TOWN_HALL) c = "#c2a06e";
        else if (t === T.GATE) c = "#e9c46a";
        else if (t === T.GRASS) c = "#3a5a2b";
        else if (t === T.TREE) c = "#213a19";
        else c = "#3e342a";
        ctx.fillStyle = c;
        ctx.fillRect(x * sx, y * sy, Math.ceil(sx), Math.ceil(sy));
      }
    }

    if (!room) return;
    const state: any = room.state;
    // NPCs with orders
    if (state?.npcs?.forEach) {
      state.npcs.forEach((n: any) => {
        if (!n.activeOrderId) return;
        ctx.fillStyle = "#ffd166";
        ctx.fillRect(((n.x / TILE_SIZE) * sx) - 1, ((n.y / TILE_SIZE) * sy) - 1, 3, 3);
      });
    }
    // Self destination
    const self = state?.players?.get?.(selfId);
    if (self?.carryingOrderId) {
      const o = state.orders?.get?.(self.carryingOrderId);
      const dst = o ? state.npcs?.get?.(o.toNpcId) : null;
      if (dst) {
        ctx.strokeStyle = "#e9c46a";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(((dst.x / TILE_SIZE) * sx) - 2, ((dst.y / TILE_SIZE) * sy) - 2, 5, 5);
      }
    }
    // Remote players
    for (const [, r] of this.remotes) {
      const last = r.buffer[r.buffer.length - 1];
      if (!last) continue;
      ctx.fillStyle = r.color;
      ctx.fillRect(((last.x / TILE_SIZE) * sx) - 1, ((last.y / TILE_SIZE) * sy) - 1, 2, 2);
    }
    // Self
    ctx.fillStyle = "#fff";
    ctx.fillRect(((this.selfPredicted.x / TILE_SIZE) * sx) - 1, ((this.selfPredicted.y / TILE_SIZE) * sy) - 1, 3, 3);
  }

  // =======================================================================
  // Juice helpers
  // =======================================================================
  private burstCoinsAt(x: number, y: number) {
    for (let i = 0; i < 10; i++) {
      const p = this.add.rectangle(x, y, 4, 4, 0xe9c46a).setStrokeStyle(1, 0x5a3a22).setDepth(180);
      const angle = (i / 10) * Math.PI * 2 + Math.random() * 0.4;
      const dist = 28 + Math.random() * 20;
      this.tweens.add({
        targets: p,
        x: x + Math.cos(angle) * dist,
        y: y + Math.sin(angle) * dist - 12,
        alpha: 0,
        scale: 0.3,
        duration: 600,
        ease: "Cubic.easeOut",
        onComplete: () => p.destroy(),
      });
    }
  }

  private floatText(x: number, y: number, text: string, color: string, size = 14) {
    const t = this.add.text(x, y, text, {
      fontFamily: "Georgia,serif", fontSize: `${size}px`, color,
      stroke: "#1a1108", strokeThickness: 4, fontStyle: "bold",
    }).setOrigin(0.5, 1).setDepth(220);
    this.tweens.add({
      targets: t,
      y: y - 40,
      alpha: 0,
      duration: 1100,
      ease: "Sine.easeOut",
      onComplete: () => t.destroy(),
    });
  }

  private screenFlash(color: string, duration = 150) {
    const cam = this.cameras.main;
    const r = this.add.rectangle(cam.scrollX, cam.scrollY, cam.width / cam.zoom, cam.height / cam.zoom,
      Phaser.Display.Color.HexStringToColor(color).color, 0.35)
      .setOrigin(0, 0).setDepth(400).setScrollFactor(0);
    r.setSize(this.scale.width, this.scale.height);
    this.tweens.add({ targets: r, alpha: 0, duration, onComplete: () => r.destroy() });
  }
}
