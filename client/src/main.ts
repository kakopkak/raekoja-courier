import Phaser from "phaser";
import { Client, Room, getStateCallbacks } from "colyseus.js";

// ---------------------------------------------------------------------------
// Error banner (runs before anything else) so we never silent-fail again.
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
  console.error("[tallinn]", e.error || e.message);
});
window.addEventListener("unhandledrejection", (e: any) => {
  errBanner.show("[unhandled promise]", `${e.reason?.message || e.reason}\n${e.reason?.stack || ""}`);
});

import {
  generateMap, generateBuildings, MAP_W, MAP_H, TILE_SIZE, T, isSolid,
  isSafeTile, SAFE_ZONE,
  PLAYER_SIZE, PLAYER_WALK_SPEED, PLAYER_SPRINT_SPEED,
  STAMINA_MAX, STAMINA_DRAIN, STAMINA_REGEN,
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
const hpWrap = document.getElementById("hp-wrap") as HTMLDivElement;
const hpBar = document.getElementById("hp-bar") as HTMLDivElement;
const hpText = document.getElementById("hp-text") as HTMLDivElement;
const stamBarEl = document.getElementById("stamina-bar") as HTMLDivElement;
const staminaWrap = document.getElementById("stamina-wrap") as HTMLDivElement;
const equipPanel = document.getElementById("equip-panel") as HTMLDivElement;
const packPanel = document.getElementById("pack-panel") as HTMLDivElement;
const leaderboard = document.getElementById("leaderboard") as HTMLDivElement;

const chatWrap = document.getElementById("chat") as HTMLDivElement;
const chatLog = document.getElementById("chat-log") as HTMLDivElement;
const chatInput = document.getElementById("chat-input") as HTMLInputElement;

const minimap = document.getElementById("minimap") as HTMLCanvasElement;

nameInput.value = localStorage.getItem("tallinn.name") || "";
nameInput.focus();
nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") playBtn.click(); });

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
    hpWrap.style.display = "block";
    equipPanel.style.display = "block";
    packPanel.style.display = "block";
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

  room.onMessage("chat", (m: { from: string; text: string; kind?: string }) => addChatLine(m.from, m.text, m.kind));
  room.onMessage("fx", (m: any) => {
    pendingFx.push({ ...m, at: performance.now() });
    if (pendingFx.length > 40) pendingFx.shift();
  });

  new Phaser.Game({
    type: Phaser.AUTO,
    parent: "app",
    backgroundColor: "#0f0b08",
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

// Queue of server-originated FX to animate client-side.
interface Fx { t: string; x: number; y: number; amount?: number; name?: string; at: number; }
const pendingFx: Fx[] = [];

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

const RARITY_COLORS: Record<string, string> = {
  common: "#c7b99a",
  uncommon: "#7fc17a",
  rare: "#7eb8ff",
  epic: "#c89bff",
};
const RARITY_HEX: Record<string, number> = {
  common: 0xc7b99a, uncommon: 0x7fc17a, rare: 0x7eb8ff, epic: 0xc89bff,
};

const ENEMY_STYLE: Record<string, { body: number; hat: number; size: number }> = {
  revenant: { body: 0x6a6a5a, hat: 0x3a2418, size: 20 },
  bandit:   { body: 0x5a4538, hat: 0x2a1c10, size: 22 },
  archer:   { body: 0x3a5a40, hat: 0x283a22, size: 22 },
  rival:    { body: 0x6a3838, hat: 0x2a1520, size: 24 },
  elite:    { body: 0x4a3028, hat: 0xc8a14a, size: 28 },
  merchant: { body: 0x7b6a58, hat: 0x3a2a20, size: 22 },
};

// ---------------------------------------------------------------------------
// GameScene
// ---------------------------------------------------------------------------
class GameScene extends Phaser.Scene {
  private map = generateMap();
  private buildings: Building[] = generateBuildings();

  private keys!: Record<"up"|"down"|"left"|"right"|"w"|"a"|"s"|"d"|"shift"|"space"|"e"|"q", Phaser.Input.Keyboard.Key>;
  private mouseDown = false;
  private lastAim = 0;

  private selfContainer!: Phaser.GameObjects.Container;
  private selfBody!: Phaser.GameObjects.Rectangle;
  private selfHem!: Phaser.GameObjects.Rectangle;
  private selfShadow!: Phaser.GameObjects.Ellipse;
  private selfLabel!: Phaser.GameObjects.Text;
  private selfSwingGfx!: Phaser.GameObjects.Graphics;

  private selfPredicted = { x: 0, y: 0 };
  private selfStamina = 1;
  private pendingInputs: Array<{ seq: number; up: boolean; down: boolean; left: boolean; right: boolean; sprint: boolean; dt: number }> = [];
  private nextSeq = 1;

  private remotes = new Map<string, {
    container: Phaser.GameObjects.Container;
    body: Phaser.GameObjects.Rectangle;
    label: Phaser.GameObjects.Text;
    hpBar: Phaser.GameObjects.Graphics;
    swingGfx: Phaser.GameObjects.Graphics;
    buffer: Array<{ t: number; x: number; y: number; facing: number; hp: number; hpMax: number; aim: number; attackEnd: number; deadUntil: number }>;
    color: string;
    name: string;
  }>();

  private enemies = new Map<string, {
    kind: string;
    container: Phaser.GameObjects.Container;
    body: Phaser.GameObjects.Rectangle;
    label: Phaser.GameObjects.Text;
    hpBar: Phaser.GameObjects.Graphics;
    x: number; y: number; hp: number; hpMax: number; hitFlashUntil: number; deadFade: number;
  }>();

  private lootBags = new Map<string, {
    container: Phaser.GameObjects.Container;
    label: Phaser.GameObjects.Text | null;
  }>();

  private projectiles = new Map<string, Phaser.GameObjects.Rectangle>();

  private dayTint!: Phaser.GameObjects.Rectangle;
  private selfFootStepPhase = 0;
  private safeHighlight!: Phaser.GameObjects.Graphics;

  constructor() { super({ key: "GameScene" }); }

  create() {
    try { this.createInner(); }
    catch (err: any) { errBanner.show("[create]", `${err?.message}\n${err?.stack || ""}`); throw err; }
  }

  private createInner() {
    const worldPxW = MAP_W * TILE_SIZE;
    const worldPxH = MAP_H * TILE_SIZE;

    this.drawWorldInto(worldPxW, worldPxH);

    // Safe-zone highlight overlay (subtle gold glow)
    this.safeHighlight = this.add.graphics().setDepth(1);
    const sx = SAFE_ZONE.x0 * TILE_SIZE, sy = SAFE_ZONE.y0 * TILE_SIZE;
    const sw = (SAFE_ZONE.x1 - SAFE_ZONE.x0 + 1) * TILE_SIZE;
    const sh = (SAFE_ZONE.y1 - SAFE_ZONE.y0 + 1) * TILE_SIZE;
    this.safeHighlight.lineStyle(2, 0xf4d58d, 0.28);
    this.safeHighlight.strokeRoundedRect(sx, sy, sw, sh, 4);
    this.safeHighlight.fillStyle(0xf4d58d, 0.05);
    this.safeHighlight.fillRect(sx, sy, sw, sh);

    // Camera
    this.cameras.main.setBounds(0, 0, worldPxW, worldPxH);
    this.cameras.main.setZoom(1.6);
    this.cameras.main.setBackgroundColor(0x0f0b08);
    this.cameras.main.roundPixels = true;

    // Day tint overlay
    this.dayTint = this.add.rectangle(0, 0, worldPxW, worldPxH, 0x000020, 0)
      .setOrigin(0, 0).setDepth(1000).setScrollFactor(0);
    this.dayTint.setSize(window.innerWidth, window.innerHeight);

    // Input
    const kb = this.input.keyboard!;
    this.keys = {
      up: kb.addKey("UP"), down: kb.addKey("DOWN"),
      left: kb.addKey("LEFT"), right: kb.addKey("RIGHT"),
      w: kb.addKey("W"), a: kb.addKey("A"), s: kb.addKey("S"), d: kb.addKey("D"),
      shift: kb.addKey("SHIFT"),
      space: kb.addKey("SPACE"),
      e: kb.addKey("E"),
      q: kb.addKey("Q"),
    };

    this.input.mouse?.disableContextMenu();
    this.input.on("pointerdown", (pt: Phaser.Input.Pointer) => {
      if (!room) return;
      if (document.activeElement === chatInput) return;
      if (pt.rightButtonDown()) {
        room.send("dash", { aim: this.computeAim(pt) });
      } else {
        room.send("attack", { aim: this.computeAim(pt) });
      }
      this.mouseDown = true;
    });
    this.input.on("pointerup", () => { this.mouseDown = false; });

    // Space = attack in facing direction / Shift= dash  (alternate keybinds)
    this.keys.space.on("down", () => {
      if (!room) return;
      if (document.activeElement === chatInput) return;
      room.send("attack", { aim: this.computeAim(this.input.activePointer) });
    });
    this.keys.e.on("down", () => {
      if (!room || document.activeElement === chatInput) return;
      // Equip first compatible item in pack.
      const self = this.getSelf(); if (!self) return;
      for (let i = 0; i < self.pack.length; i++) {
        const it = self.pack.at(i);
        if (it && (it.slot === "weapon" || it.slot === "armor" || it.slot === "ring")) {
          room.send("equip", i); return;
        }
      }
    });
    this.keys.q.on("down", () => {
      if (!room || document.activeElement === chatInput) return;
      const self = this.getSelf(); if (!self) return;
      for (let i = 0; i < self.pack.length; i++) {
        const it = self.pack.at(i);
        if (it && it.slot === "consumable") { room!.send("use", i); return; }
      }
    });

    // 1..8 = equip/use pack slot
    for (let i = 1; i <= 8; i++) {
      const k = kb.addKey(String(i));
      k.on("down", () => {
        if (!room || document.activeElement === chatInput) return;
        const self = this.getSelf(); if (!self) return;
        const it = self.pack.at(i - 1);
        if (!it) return;
        if (it.slot === "consumable") room!.send("use", i - 1);
        else room!.send("equip", i - 1);
      });
    }

    // Chat
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

    this.scale.on("resize", (size: Phaser.Structs.Size) => {
      this.dayTint.setSize(size.width, size.height);
    });

    // Self sprite
    this.selfContainer = this.add.container(0, 0).setDepth(101);
    this.selfShadow = this.add.ellipse(PLAYER_SIZE / 2, PLAYER_SIZE - 1, PLAYER_SIZE * 0.9, 6, 0x000000, 0.45);
    this.selfBody = this.add.rectangle(0, 0, PLAYER_SIZE, PLAYER_SIZE, 0xffffff)
      .setStrokeStyle(1, 0x1a1108, 1).setOrigin(0, 0);
    this.selfHem = this.add.rectangle(0, PLAYER_SIZE - 4, PLAYER_SIZE, 4, 0x000000, 0.4).setOrigin(0, 0);
    this.selfContainer.add([this.selfShadow, this.selfBody, this.selfHem]);
    this.selfLabel = this.add.text(0, 0, "", {
      fontFamily: "monospace", fontSize: "12px", color: "#fff",
      stroke: "#000", strokeThickness: 3,
    }).setOrigin(0.5, 1).setDepth(210);
    this.selfSwingGfx = this.add.graphics().setDepth(105);

    if (!room) return;
    const $ = getStateCallbacks(room);
    if (!$) { errBanner.show("[schema]", "no getStateCallbacks proxy"); return; }

    // Players
    $(room.state as any).players.onAdd((player: any, sid: string) => {
      if (sid === selfId) {
        this.selfPredicted.x = player.x; this.selfPredicted.y = player.y;
        this.selfStamina = player.stamina;
        this.selfBody.fillColor = Phaser.Display.Color.HexStringToColor(player.color).color;
        this.selfLabel.setText(player.name);
        this.selfContainer.setPosition(player.x, player.y);
        this.cameras.main.centerOn(player.x + PLAYER_SIZE / 2, player.y + PLAYER_SIZE / 2);
        this.cameras.main.startFollow(this.selfContainer, true, 0.18, 0.18);
      } else {
        this.addRemote(sid, player);
      }
      $(player).onChange(() => {
        if (sid === selfId) {
          this.selfStamina = player.stamina;
          this.reconcile(player.x, player.y, player.lastProcessedInput);
        } else {
          const r = this.remotes.get(sid);
          if (r) {
            r.buffer.push({
              t: performance.now(), x: player.x, y: player.y, facing: player.facing,
              hp: player.hp, hpMax: player.hpMax, aim: player.aimAngle,
              attackEnd: player.attackEnd, deadUntil: player.deadUntil,
            });
            if (r.buffer.length > 30) r.buffer.shift();
          }
        }
      });
    });
    $(room.state as any).players.onRemove((_p: any, sid: string) => {
      const r = this.remotes.get(sid);
      if (r) { r.container.destroy(); r.label.destroy(); r.hpBar.destroy(); r.swingGfx.destroy(); this.remotes.delete(sid); }
    });

    // Enemies
    $(room.state as any).enemies.onAdd((e: any, id: string) => {
      this.spawnEnemyVisual(e, id);
      $(e).onChange(() => {
        const v = this.enemies.get(id); if (!v) return;
        v.x = e.x; v.y = e.y; v.hp = e.hp; v.hpMax = e.hpMax; v.hitFlashUntil = e.hitFlashUntil;
        v.container.setPosition(Math.round(e.x - ENEMY_STYLE[v.kind]?.size / 2), Math.round(e.y - ENEMY_STYLE[v.kind]?.size / 2));
        v.label.setPosition(e.x, e.y + 14);
        if (e.state === "dead") v.deadFade = performance.now();
      });
    });
    $(room.state as any).enemies.onRemove((_e: any, id: string) => {
      const v = this.enemies.get(id);
      if (v) { v.container.destroy(); v.label.destroy(); v.hpBar.destroy(); this.enemies.delete(id); }
    });

    // Loot bags
    $(room.state as any).loot.onAdd((bag: any, id: string) => {
      this.spawnLootVisual(bag, id);
    });
    $(room.state as any).loot.onRemove((_bag: any, id: string) => {
      const l = this.lootBags.get(id);
      if (l) { l.container.destroy(); l.label?.destroy(); this.lootBags.delete(id); }
    });

    // Projectiles
    $(room.state as any).projectiles.onAdd((pr: any, id: string) => {
      const rect = this.add.rectangle(pr.x, pr.y, 10, 3, 0xeeeeaa).setStrokeStyle(1, 0x2a1a10).setDepth(105);
      this.projectiles.set(id, rect);
      $(pr).onChange(() => {
        const r = this.projectiles.get(id); if (!r) return;
        r.setPosition(pr.x, pr.y);
        r.rotation = Math.atan2(pr.vy, pr.vx);
      });
    });
    $(room.state as any).projectiles.onRemove((_pr: any, id: string) => {
      const r = this.projectiles.get(id); if (r) { r.destroy(); this.projectiles.delete(id); }
    });
  }

  // =======================================================================
  private computeAim(pt: Phaser.Input.Pointer): number {
    const cam = this.cameras.main;
    const wx = pt.x / cam.zoom + cam.scrollX;
    const wy = pt.y / cam.zoom + cam.scrollY;
    const cx = this.selfPredicted.x + PLAYER_SIZE / 2;
    const cy = this.selfPredicted.y + PLAYER_SIZE / 2;
    const a = Math.atan2(wy - cy, wx - cx);
    this.lastAim = a;
    return a;
  }

  private getSelf(): any {
    const state: any = room?.state;
    if (!state?.players?.get) return null;
    return state.players.get(selfId);
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
    const now = performance.now();

    const self = this.getSelf();
    const dead = !!self?.deadUntil;

    // Input
    const isTyping = document.activeElement === nameInput || document.activeElement === chatInput;
    let up = false, down = false, left = false, right = false, sprint = false;
    if (!isTyping && !dead) {
      up = this.keys.up.isDown || this.keys.w.isDown;
      down = this.keys.down.isDown || this.keys.s.isDown;
      left = this.keys.left.isDown || this.keys.a.isDown;
      right = this.keys.right.isDown || this.keys.d.isDown;
      sprint = this.keys.shift.isDown;
    }

    // Prediction
    let dx = 0, dy = 0;
    if (left) dx -= 1; if (right) dx += 1;
    if (up) dy -= 1; if (down) dy += 1;
    if (dx !== 0 && dy !== 0) { const inv = 1 / Math.sqrt(2); dx *= inv; dy *= inv; }

    const wantSprint = sprint && (dx !== 0 || dy !== 0);
    let speed = PLAYER_WALK_SPEED;
    if (wantSprint && this.selfStamina > 0.02) {
      speed = PLAYER_SPRINT_SPEED;
      this.selfStamina = Math.max(0, this.selfStamina - STAMINA_DRAIN * dt);
    } else this.selfStamina = Math.min(STAMINA_MAX, this.selfStamina + STAMINA_REGEN * dt);
    if (self?.pack && self.pack.length > 0) speed *= 0.93;

    if (!dead) {
      const stepX = dx * speed * dt;
      const stepY = dy * speed * dt;
      let nx = this.selfPredicted.x + stepX;
      if (!this.collidesAt(nx, this.selfPredicted.y)) this.selfPredicted.x = nx;
      let ny = this.selfPredicted.y + stepY;
      if (!this.collidesAt(this.selfPredicted.x, ny)) this.selfPredicted.y = ny;

      const input = { seq: this.nextSeq++, up, down, left, right, sprint: wantSprint && this.selfStamina > 0.02, dt };
      this.pendingInputs.push(input);
      room.send("input", input);
    }

    // Continuous attack while mouse held (capped by server cooldown)
    if (this.mouseDown && !isTyping && !dead && (now % 50 < 16)) {
      room.send("attack", { aim: this.computeAim(this.input.activePointer) });
    }

    // Self render
    this.renderSelf(dx, dy, wantSprint, dt, self);

    // Remote render + HP bars + swing effects
    this.renderRemotes();

    // Enemy visuals
    this.renderEnemies();

    // HUD / UI
    this.renderHud(self);
    this.renderEquip(self);
    this.renderPack(self);

    // FX queue (hit numbers etc.)
    this.drainFx();

    // Day tint
    const phase = (room.state as any)?.dayPhase ?? 0.3;
    const darkness = 0.5 * (1 - Math.cos(phase * Math.PI * 2)) * 0.25;
    this.dayTint.setFillStyle(0x101830, darkness);

    this.drawMinimap();
    this.selfFootStepPhase += dt * (dx !== 0 || dy !== 0 ? (wantSprint ? 14 : 9) : 0);
  }

  // =======================================================================
  // Self
  // =======================================================================
  private renderSelf(dx: number, dy: number, wantSprint: boolean, _dt: number, self: any) {
    const x = Math.round(this.selfPredicted.x);
    const y = Math.round(this.selfPredicted.y);
    this.selfContainer.setPosition(x, y);
    const moving = (dx !== 0 || dy !== 0);
    const bob = moving ? Math.sin(this.selfFootStepPhase) * 1.2 : 0;
    this.selfBody.y = bob;
    this.selfHem.y = PLAYER_SIZE - 4 + bob;

    const now = Date.now();
    // Damage flash
    if (self && now < self.hitFlashUntil) {
      const t = (self.hitFlashUntil - now) / 220;
      this.selfBody.fillColor = Phaser.Display.Color.Interpolate.ColorWithColor(
        Phaser.Display.Color.HexStringToColor(self.color),
        Phaser.Display.Color.HexStringToColor("#ff5a5a"),
        1, t,
      ).color as any as number;
    } else if (self) {
      this.selfBody.fillColor = Phaser.Display.Color.HexStringToColor(self.color).color;
    }
    // Dead? Make self greyscale-ish
    if (self?.deadUntil) {
      this.selfBody.setAlpha(0.4);
    } else {
      this.selfBody.setAlpha(1);
    }

    this.selfLabel.setPosition(x + PLAYER_SIZE / 2, y - 2);
    this.selfLabel.setText(self ? self.name : "");

    // Swing arc
    this.selfSwingGfx.clear();
    if (self && now < self.attackEnd) {
      const cx = x + PLAYER_SIZE / 2, cy = y + PLAYER_SIZE / 2;
      const wpn = self.equipped?.get?.("weapon");
      const range = (wpn?.bonusRange ?? 30) + 8;
      const ang = self.aimAngle;
      const t = 1 - (self.attackEnd - now) / 160;
      this.selfSwingGfx.fillStyle(0xf4d58d, 0.28);
      this.selfSwingGfx.slice(cx, cy, range, ang - 0.9, ang + 0.9, false);
      this.selfSwingGfx.fillPath();
      // Bright leading edge
      this.selfSwingGfx.lineStyle(2, 0xfff2b3, 0.85 * (1 - t));
      this.selfSwingGfx.beginPath();
      this.selfSwingGfx.arc(cx, cy, range, ang - 0.9 + 1.8 * t, ang - 0.9 + 1.8 * t + 0.05, false);
      this.selfSwingGfx.strokePath();
    }
  }

  // =======================================================================
  // Remotes
  // =======================================================================
  private addRemote(sid: string, player: any) {
    const c = this.add.container(player.x, player.y).setDepth(100);
    const shadow = this.add.ellipse(PLAYER_SIZE / 2, PLAYER_SIZE - 1, PLAYER_SIZE * 0.9, 6, 0x000000, 0.45);
    const body = this.add.rectangle(0, 0, PLAYER_SIZE, PLAYER_SIZE,
      Phaser.Display.Color.HexStringToColor(player.color).color).setStrokeStyle(1, 0x1a1108, 1).setOrigin(0, 0);
    const hem = this.add.rectangle(0, PLAYER_SIZE - 4, PLAYER_SIZE, 4, 0x000000, 0.4).setOrigin(0, 0);
    c.add([shadow, body, hem]);
    const label = this.add.text(player.x + PLAYER_SIZE / 2, player.y - 2, player.name, {
      fontFamily: "monospace", fontSize: "11px", color: "#fff",
      stroke: "#000", strokeThickness: 3,
    }).setOrigin(0.5, 1).setDepth(199);
    const hpBar = this.add.graphics().setDepth(198);
    const swingGfx = this.add.graphics().setDepth(104);
    this.remotes.set(sid, {
      container: c, body, label, hpBar, swingGfx,
      buffer: [{ t: performance.now(), x: player.x, y: player.y, facing: player.facing, hp: player.hp, hpMax: player.hpMax, aim: player.aimAngle, attackEnd: player.attackEnd, deadUntil: player.deadUntil }],
      color: player.color, name: player.name,
    });
  }

  private renderRemotes() {
    const now = performance.now();
    const renderT = now - 100;
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

      // HP bar above head (only if damaged)
      r.hpBar.clear();
      const hpPct = b.hpMax > 0 ? b.hp / b.hpMax : 1;
      if (hpPct < 1 && !b.deadUntil) {
        r.hpBar.fillStyle(0x1a1108, 0.85);
        r.hpBar.fillRect(rx - 4, ry - 10, PLAYER_SIZE + 8, 4);
        r.hpBar.fillStyle(hpPct > 0.6 ? 0x2a9d8f : hpPct > 0.3 ? 0xf4a261 : 0xef476f, 1);
        r.hpBar.fillRect(rx - 3, ry - 9, (PLAYER_SIZE + 6) * hpPct, 2);
      }

      // Swing arc
      r.swingGfx.clear();
      const serverNow = Date.now();
      if (serverNow < b.attackEnd) {
        const cx = rx + PLAYER_SIZE / 2, cy = ry + PLAYER_SIZE / 2;
        const range = 46;
        const ang = b.aim;
        r.swingGfx.fillStyle(0xf4a261, 0.3);
        r.swingGfx.slice(cx, cy, range, ang - 0.9, ang + 0.9, false);
        r.swingGfx.fillPath();
      }

      // Dead fade
      if (b.deadUntil) {
        r.body.setAlpha(0.3);
      } else {
        r.body.setAlpha(1);
      }
    }
  }

  // =======================================================================
  // Enemies
  // =======================================================================
  private spawnEnemyVisual(e: any, id: string) {
    const style = ENEMY_STYLE[e.kind] || ENEMY_STYLE.revenant;
    const size = style.size;
    const c = this.add.container(e.x - size / 2, e.y - size / 2).setDepth(95);
    const shadow = this.add.ellipse(size / 2, size + 1, size * 0.9, 5, 0x000000, 0.45);
    const body = this.add.rectangle(0, 0, size, size, style.body).setOrigin(0, 0).setStrokeStyle(1, 0x1a1108);
    const head = this.add.rectangle(size * 0.2, -6, size * 0.6, 8, 0xf0c89a).setOrigin(0, 0).setStrokeStyle(1, 0x1a1108);
    const hat = this.add.rectangle(size * 0.15, -9, size * 0.7, 4, style.hat).setOrigin(0, 0);
    c.add([shadow, body, head, hat]);
    const label = this.add.text(e.x, e.y + 14, e.shortName || e.kind, {
      fontFamily: "monospace", fontSize: "10px", color: e.kind === "merchant" ? "#f4d58d" : "#ffcfcf",
      stroke: "#1a1108", strokeThickness: 3,
    }).setOrigin(0.5, 0).setDepth(96).setAlpha(0.9);
    const hpBar = this.add.graphics().setDepth(97);
    this.enemies.set(id, {
      kind: e.kind, container: c, body, label, hpBar,
      x: e.x, y: e.y, hp: e.hp, hpMax: e.hpMax, hitFlashUntil: e.hitFlashUntil, deadFade: 0,
    });
  }

  private renderEnemies() {
    const now = performance.now();
    const serverNow = Date.now();
    for (const [, v] of this.enemies) {
      const style = ENEMY_STYLE[v.kind] || ENEMY_STYLE.revenant;
      v.hpBar.clear();
      if (v.kind !== "merchant" && v.hpMax > 0) {
        const pct = Math.max(0, v.hp / v.hpMax);
        if (pct < 1 || serverNow < v.hitFlashUntil) {
          v.hpBar.fillStyle(0x1a1108, 0.85);
          v.hpBar.fillRect(v.x - style.size / 2 - 2, v.y - style.size / 2 - 8, style.size + 4, 3);
          v.hpBar.fillStyle(pct > 0.5 ? 0xef476f : 0x9d2a2a, 1);
          v.hpBar.fillRect(v.x - style.size / 2 - 1, v.y - style.size / 2 - 7, (style.size + 2) * pct, 1);
        }
      }
      // Flash
      if (serverNow < v.hitFlashUntil) {
        v.body.fillColor = 0xffffff;
      } else {
        v.body.fillColor = style.body;
      }
      // Dead fade
      if (v.deadFade > 0) {
        const t = Math.min(1, (now - v.deadFade) / 2500);
        v.container.setAlpha(1 - t);
        v.label.setAlpha((1 - t) * 0.9);
      }
    }
  }

  // =======================================================================
  // Loot bags
  // =======================================================================
  private spawnLootVisual(bag: any, id: string) {
    const rarity: string = (bag.items?.at?.(0)?.rarity) || "common";
    const color = RARITY_HEX[rarity] ?? 0xc7b99a;
    const c = this.add.container(bag.x, bag.y).setDepth(60);
    const pile = this.add.ellipse(0, 2, 14, 6, 0x2a1a0e, 0.85);
    const glow = this.add.ellipse(0, 0, 22, 10, color, 0.22);
    const body = this.add.rectangle(-5, -4, 10, 6, color).setStrokeStyle(1, 0x1a1108);
    const strap = this.add.rectangle(-5, -2, 10, 2, 0x3a2a22);
    c.add([glow, pile, body, strap]);
    this.tweens.add({ targets: glow, scale: 1.15, yoyo: true, repeat: -1, duration: 900, ease: "Sine.easeInOut" });
    let label: Phaser.GameObjects.Text | null = null;
    const first = bag.items?.at?.(0);
    if (first) {
      label = this.add.text(bag.x, bag.y - 14, first.name, {
        fontFamily: "monospace", fontSize: "10px",
        color: RARITY_COLORS[first.rarity] || "#c7b99a",
        stroke: "#1a1108", strokeThickness: 3,
      }).setOrigin(0.5, 1).setDepth(61).setAlpha(0.9);
    }
    this.lootBags.set(id, { container: c, label });
  }

  // =======================================================================
  // HUD
  // =======================================================================
  private renderHud(self: any) {
    if (!self) return;
    hpBar.style.width = `${Math.max(0, Math.min(100, (self.hp / self.hpMax) * 100))}%`;
    hpText.textContent = `${Math.round(self.hp)} / ${self.hpMax}`;
    if (self.hp / self.hpMax < 0.3) hpBar.classList.add("low"); else hpBar.classList.remove("low");

    stamBarEl.style.width = `${Math.max(0, Math.min(100, self.stamina * 100))}%`;
    if (self.stamina < 0.15) stamBarEl.classList.add("low"); else stamBarEl.classList.remove("low");

    const inSafe = this.isSelfSafe();
    const phase = self.deadUntil ? "DEAD" : (self.inRun ? "IN THE WILDS" : inSafe ? "SAFE HUB" : "LEAVING HUB");
    const phaseColor = self.deadUntil ? "#ef476f" : (self.inRun ? "#f4a261" : "#2a9d8f");
    scoreCard.innerHTML = `
      <div class="score-num">${self.gold || 0}<span class="unit">gold</span></div>
      <div class="score-rank" style="color:${phaseColor}">${phase}</div>
      <div class="score-sub">kills: ${self.killsThisRun || 0} · extracts: ${self.extractions || 0}${self.pack?.length ? ` · pack: ${self.pack.length}/8` : ""}</div>
    `;

    const state: any = room?.state;
    const rows: Array<{ name: string; gold: number; kills: number; mine: boolean }> = [];
    if (state?.players?.forEach) {
      state.players.forEach((p: any, sid: string) => {
        rows.push({ name: p.name || sid.slice(0, 4), gold: p.gold || 0, kills: p.killsThisRun || 0, mine: sid === selfId });
      });
    }
    rows.sort((a, b) => (b.gold * 1000 + b.kills) - (a.gold * 1000 + a.kills));
    leaderboard.innerHTML = `
      <div class="lb-head">Adventurers</div>
      ${rows.slice(0, 6).map((r, i) => `
        <div class="lb-row ${r.mine ? "me" : ""}">
          <span class="rank">${i + 1}</span>
          <span class="name">${escapeHtml(r.name)}</span>
          <span class="pts">${r.gold}g · ${r.kills}k</span>
        </div>`).join("")}
    `;

    hud.innerHTML = `
      <div class="hud-help">
        <b>WASD</b> move · <b>LMB</b> attack · <b>Space</b> attack · <b>RMB</b> dash · <b>Shift</b> sprint · <b>1..8</b> use slot · <b>E</b> equip · <b>Q</b> heal
      </div>`;
  }

  private renderEquip(self: any) {
    if (!self?.equipped) return;
    const slots = ["weapon", "armor", "ring"];
    equipPanel.innerHTML = `
      <div class="panel-head">EQUIPPED</div>
      ${slots.map((s) => {
        const it = self.equipped.get ? self.equipped.get(s) : undefined;
        return it ? `
          <div class="equip-row" data-slot="${s}">
            <div class="equip-slot">${s}</div>
            <div class="equip-item" style="color:${RARITY_COLORS[it.rarity] || "#c7b99a"}">${escapeHtml(it.name)}</div>
            <div class="equip-stats">${summariseItem(it)}</div>
          </div>` : `
          <div class="equip-row empty" data-slot="${s}">
            <div class="equip-slot">${s}</div>
            <div class="equip-item">— empty —</div>
          </div>`;
      }).join("")}
    `;
  }

  private renderPack(self: any) {
    if (!self?.pack) return;
    const packLen = self.pack.length;
    packPanel.innerHTML = `
      <div class="panel-head">PACK · ${packLen}/8</div>
      <div class="pack-grid">
        ${Array.from({ length: 8 }).map((_, i) => {
          const it = self.pack.at ? self.pack.at(i) : undefined;
          if (!it) return `<div class="pack-slot empty"><span class="idx">${i + 1}</span></div>`;
          const c = RARITY_COLORS[it.rarity] || "#c7b99a";
          return `
            <div class="pack-slot" data-idx="${i}" title="${escapeHtml(it.name)} · ${summariseItem(it)}">
              <span class="idx">${i + 1}</span>
              <span class="pack-name" style="color:${c}">${escapeHtml(it.name)}</span>
              <span class="pack-stats">${summariseItem(it)}</span>
            </div>`;
        }).join("")}
      </div>
      <div class="panel-foot">Press <b>1..8</b> to equip/use · <b>E</b> equip first · <b>Q</b> use potion</div>
    `;
  }

  // =======================================================================
  // FX queue drain (damage numbers etc.)
  // =======================================================================
  private drainFx() {
    while (pendingFx.length > 0) {
      const fx = pendingFx.shift()!;
      if (fx.t === "hit") {
        this.floatText(fx.x, fx.y, `-${fx.amount}`, "#ffe0a8", 14);
        this.cameras.main.shake(80, 0.002);
      } else if (fx.t === "heal") {
        this.floatText(fx.x, fx.y, `+${fx.amount}`, "#a6e3a1", 14);
      } else if (fx.t === "death") {
        this.floatText(fx.x, fx.y, `${fx.name} fell`, "#ef476f", 18);
        this.cameras.main.shake(200, 0.004);
      }
    }
  }

  private floatText(x: number, y: number, text: string, color: string, size = 14) {
    const t = this.add.text(x, y, text, {
      fontFamily: "Georgia,serif", fontSize: `${size}px`, color,
      stroke: "#1a1108", strokeThickness: 4, fontStyle: "bold",
    }).setOrigin(0.5, 1).setDepth(220);
    this.tweens.add({ targets: t, y: y - 36, alpha: 0, duration: 900, ease: "Sine.easeOut", onComplete: () => t.destroy() });
  }

  // =======================================================================
  // Collision / reconciliation
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
      const speed = (input.sprint ? PLAYER_SPRINT_SPEED : PLAYER_WALK_SPEED);
      const stepX = dx * speed * input.dt;
      const stepY = dy * speed * input.dt;
      let nx = x + stepX;
      if (!this.collidesAt(nx, y)) x = nx;
      let ny = y + stepY;
      if (!this.collidesAt(x, ny)) y = ny;
    }
    const dx = x - this.selfPredicted.x, dy = y - this.selfPredicted.y;
    const err = Math.sqrt(dx * dx + dy * dy);
    if (err > 80) { this.selfPredicted.x = x; this.selfPredicted.y = y; }
    else { this.selfPredicted.x += dx * 0.3; this.selfPredicted.y += dy * 0.3; }
  }

  private isSelfSafe(): boolean {
    const tx = Math.floor((this.selfPredicted.x + PLAYER_SIZE / 2) / TILE_SIZE);
    const ty = Math.floor((this.selfPredicted.y + PLAYER_SIZE / 2) / TILE_SIZE);
    return isSafeTile(tx, ty);
  }

  // =======================================================================
  // Minimap
  // =======================================================================
  private drawMinimap() {
    const ctx = minimap.getContext("2d");
    if (!ctx) return;
    const sx = minimap.width / MAP_W, sy = minimap.height / MAP_H;
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
    // Safe zone outline
    ctx.strokeStyle = "#f4d58d";
    ctx.lineWidth = 1;
    ctx.strokeRect(SAFE_ZONE.x0 * sx, SAFE_ZONE.y0 * sy, (SAFE_ZONE.x1 - SAFE_ZONE.x0 + 1) * sx, (SAFE_ZONE.y1 - SAFE_ZONE.y0 + 1) * sy);

    if (!room) return;
    const state: any = room.state;
    // Enemies
    if (state?.enemies?.forEach) {
      state.enemies.forEach((e: any) => {
        if (e.kind === "merchant") return;
        if (e.state === "dead") return;
        ctx.fillStyle = "#ef476f";
        ctx.fillRect(((e.x / TILE_SIZE) * sx) - 1, ((e.y / TILE_SIZE) * sy) - 1, 2, 2);
      });
    }
    // Loot
    if (state?.loot?.forEach) {
      state.loot.forEach((bag: any) => {
        ctx.fillStyle = "#ffd166";
        ctx.fillRect(((bag.x / TILE_SIZE) * sx) - 1, ((bag.y / TILE_SIZE) * sy) - 1, 2, 2);
      });
    }
    // Remote players
    for (const [, r] of this.remotes) {
      const last = r.buffer[r.buffer.length - 1]; if (!last) continue;
      ctx.fillStyle = r.color;
      ctx.fillRect(((last.x / TILE_SIZE) * sx) - 1, ((last.y / TILE_SIZE) * sy) - 1, 2, 2);
    }
    // Self
    ctx.fillStyle = "#fff";
    ctx.fillRect(((this.selfPredicted.x / TILE_SIZE) * sx) - 1, ((this.selfPredicted.y / TILE_SIZE) * sy) - 1, 3, 3);
  }

  // =======================================================================
  // World render (baked texture)
  // =======================================================================
  private drawWorldInto(worldPxW: number, worldPxH: number) {
    const gfx = this.add.graphics({ x: 0, y: 0 }).setVisible(false);

    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const tile = this.map[y][x];
        this.drawTile(gfx, x, y, tile);
      }
    }
    for (const b of this.buildings) this.drawBuilding(gfx, b);
    for (let y = 0; y < MAP_H; y++) {
      for (let x = 0; x < MAP_W; x++) {
        const tile = this.map[y][x];
        if (tile === T.WELL) this.drawWell(gfx, x, y);
        else if (tile === T.MARKET_STALL) this.drawMarketStall(gfx, x, y);
        else if (tile === T.LANTERN) this.drawLantern(gfx, x, y);
        else if (tile === T.TREE) this.drawTree(gfx, x, y);
        else if (tile === T.STAIRS) this.drawStairs(gfx, x, y);
      }
    }

    const key = "__tallinn_world";
    if (this.textures.exists(key)) this.textures.remove(key);
    gfx.generateTexture(key, worldPxW, worldPxH);
    gfx.destroy();
    this.add.image(0, 0, key).setOrigin(0, 0).setDepth(0);

    for (const b of this.buildings) {
      if (!b.showLabel) continue;
      const cx = (b.x + b.w / 2) * TILE_SIZE;
      const cy = (b.y + b.h / 2) * TILE_SIZE;
      this.add.text(cx, cy + b.h * TILE_SIZE / 2 + 8, b.name, {
        fontFamily: "serif", fontSize: "14px", color: "#f4d58d",
        stroke: "#1a1108", strokeThickness: 3,
      }).setOrigin(0.5).setAlpha(0.9).setDepth(50);
    }
    const areaLabels: Array<{ x: number; y: number; text: string; size?: number }> = [
      { x: 28, y: 19, text: "Raekoja plats · SAFE", size: 18 },
      { x: 8,  y: 8,  text: "Toompea",       size: 14 },
      { x: 25, y: 1,  text: "Viru värav",    size: 12 },
      { x: 15, y: 38, text: "Harju värav",   size: 12 },
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
        g.lineStyle(1, 0xc0a87d, 0.18);
        g.beginPath(); g.moveTo(px, py + 16); g.lineTo(px + TILE_SIZE, py + 16); g.strokePath();
        break;
      }
      case T.TOOMPEA_GROUND: {
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
        g.fillStyle(0x554638, 1);
        g.fillRect(px + 1, py + 1, TILE_SIZE - 2, TILE_SIZE - 2);
        g.fillStyle(0x35281e, 1);
        for (let ly = 0; ly < TILE_SIZE; ly += 8) g.fillRect(px, py + ly, TILE_SIZE, 1);
        for (let lx = 0; lx < TILE_SIZE; lx += 10) g.fillRect(px + lx, py, 1, TILE_SIZE);
        g.fillStyle(0x7a6850, 0.35);
        g.fillRect(px + 2, py + 2, TILE_SIZE - 4, 2);
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
        break;
      }
    }
  }

  private drawBuilding(g: Phaser.GameObjects.Graphics, b: Building) {
    const px = b.x * TILE_SIZE, py = b.y * TILE_SIZE;
    const w = b.w * TILE_SIZE, h = b.h * TILE_SIZE;
    switch (b.style) {
      case "merchant":     return this.drawMerchantHouse(g, b, px, py, w, h);
      case "townhall":     return this.drawTownHall(g, b, px, py, w, h);
      case "oleviste":     return this.drawOleviste(g, b, px, py, w, h);
      case "pikkhermann":  return this.drawPikkHermann(g, b, px, py, w, h);
      case "domechurch":   return this.drawDomeChurch(g, b, px, py, w, h);
    }
  }

  private drawMerchantHouse(g: Phaser.GameObjects.Graphics, b: Building, px: number, py: number, w: number, h: number) {
    const facade = Phaser.Display.Color.HexStringToColor(b.facade || "#d8a785").color;
    const roof = Phaser.Display.Color.HexStringToColor(b.roof || "#8e3b26").color;
    const accent = Phaser.Display.Color.HexStringToColor(b.accent || "#5a2f20").color;
    g.fillStyle(facade, 1); g.fillRect(px + 2, py + 6, w - 4, h - 8);
    g.fillStyle(accent, 0.25);
    for (let sx = 8; sx < w - 4; sx += 10) g.fillRect(px + sx, py + 6, 1, h - 8);
    const winCols = Math.max(2, Math.floor((w - 6) / 10));
    const winRowsN = Math.max(1, Math.floor((h - 14) / 10));
    for (let r = 0; r < winRowsN; r++) {
      for (let c = 0; c < winCols; c++) {
        const wx = px + 6 + c * ((w - 8) / winCols);
        const wy = py + 10 + r * 10;
        g.fillStyle(0xd9b26a, 0.85); g.fillRect(wx, wy, 6, 5);
        g.fillStyle(accent, 0.8); g.fillRect(wx + 2, wy, 2, 5); g.fillRect(wx, wy + 2, 6, 1);
      }
    }
    g.fillStyle(accent, 1); g.fillRect(px + w / 2 - 3, py + h - 10, 6, 8);
    if (b.gable === "stepped") {
      const steps = Math.min(4, Math.max(2, Math.floor(w / 12)));
      const stepW = Math.floor((w - 6) / (steps * 2 + 1));
      g.fillStyle(roof, 1); g.fillRect(px + 2, py + 2, w - 4, 5);
      for (let i = 0; i < steps; i++) {
        const leftX = px + 2 + stepW * (i + 1);
        const rightX = px + w - 2 - stepW * (i + 1) - stepW;
        const h2 = 4 + i * 3;
        g.fillRect(leftX, py - h2, stepW, h2 + 4);
        g.fillRect(rightX, py - h2, stepW, h2 + 4);
      }
      g.fillRect(px + w / 2 - stepW / 2, py - (4 + steps * 3) - 2, stepW, 6);
    } else {
      g.fillStyle(roof, 1); g.fillRect(px + 2, py + 2, w - 4, 5);
      g.fillTriangle(px + 2, py + 2, px + w - 2, py + 2, px + w / 2, py - 8);
    }
    g.fillStyle(0x1b0f09, 0.3); g.fillRect(px + 2, py + h - 3, w - 4, 2);
  }

  private drawTownHall(g: Phaser.GameObjects.Graphics, b: Building, px: number, py: number, w: number, h: number) {
    const facade = Phaser.Display.Color.HexStringToColor(b.facade || "#d8cfae").color;
    const roof = Phaser.Display.Color.HexStringToColor(b.roof || "#8e3b26").color;
    const accent = Phaser.Display.Color.HexStringToColor(b.accent || "#5a4a30").color;
    g.fillStyle(facade, 1); g.fillRect(px + 2, py + 16, w - 4, h - 18);
    const archCount = 6; const archW = (w - 8) / archCount;
    for (let i = 0; i < archCount; i++) {
      const ax = px + 4 + i * archW;
      g.fillStyle(accent, 0.9); g.fillRect(ax + 1, py + h - 18, archW - 2, 16);
      g.fillStyle(0x1b130b, 1); g.fillRect(ax + 3, py + h - 15, archW - 6, 10);
      g.fillStyle(accent, 1);
      g.fillTriangle(ax + 3, py + h - 15, ax + archW - 3, py + h - 15, ax + archW / 2, py + h - 20);
    }
    for (let r = 0; r < 2; r++) for (let i = 0; i < 8; i++) {
      const wx = px + 5 + i * ((w - 10) / 8); const wy = py + 20 + r * 14;
      g.fillStyle(0xd9b26a, 0.9); g.fillRect(wx, wy, 4, 10);
      g.fillStyle(accent, 0.9); g.fillRect(wx + 2, wy, 1, 10); g.fillRect(wx, wy + 4, 4, 1);
    }
    g.fillStyle(roof, 1); g.fillRect(px + 2, py + 12, w - 4, 6);
    const steps = 5; const stepW = Math.floor((w - 4) / (steps * 2 + 1));
    for (let i = 0; i < steps; i++) {
      const leftX = px + 2 + stepW * (i + 1);
      const rightX = px + w - 2 - stepW * (i + 1) - stepW;
      const hUp = 4 + i * 4;
      g.fillRect(leftX, py + 12 - hUp, stepW, hUp + 4);
      g.fillRect(rightX, py + 12 - hUp, stepW, hUp + 4);
    }
    const towerX = px + w * 0.18;
    const towerW = Math.max(22, Math.floor(w * 0.17));
    const spireH = b.spire || 140;
    const towerTopY = py - spireH;
    g.fillStyle(facade, 1); g.fillRect(towerX - towerW / 2, towerTopY + 34, towerW, spireH - 34);
    g.fillStyle(accent, 0.3);
    g.fillRect(towerX - towerW / 2, towerTopY + 34, 2, spireH - 34);
    g.fillRect(towerX + towerW / 2 - 2, towerTopY + 34, 2, spireH - 34);
    g.fillStyle(0xe7c258, 1); g.fillCircle(towerX, towerTopY + 80, 7);
    g.fillStyle(0x1b130b, 1); g.fillCircle(towerX, towerTopY + 80, 5);
    g.lineStyle(1, 0xe7c258, 1);
    g.beginPath(); g.moveTo(towerX, towerTopY + 80); g.lineTo(towerX + 3, towerTopY + 78); g.strokePath();
    g.beginPath(); g.moveTo(towerX, towerTopY + 80); g.lineTo(towerX, towerTopY + 76); g.strokePath();
    for (let i = 0; i < 3; i++) { g.fillStyle(0x1b130b, 1); g.fillRect(towerX - 2, towerTopY + 40 + i * 20, 4, 6); }
    g.fillStyle(0x8a7050, 1); g.fillRect(towerX - towerW / 2 - 2, towerTopY + 30, towerW + 4, 6);
    g.fillStyle(0x3a6b5a, 1);
    g.fillTriangle(towerX - towerW / 2 + 2, towerTopY + 34, towerX + towerW / 2 - 2, towerTopY + 34, towerX, towerTopY - 6);
    g.fillStyle(0x5a8e77, 0.7);
    g.fillTriangle(towerX - towerW / 2 + 4, towerTopY + 34, towerX, towerTopY + 34, towerX - 1, towerTopY - 2);
    g.fillStyle(0x2a1408, 1); g.fillRect(towerX - 1, towerTopY - 20, 2, 18);
    g.fillStyle(0xd9a74a, 1);
    g.fillRect(towerX - 5, towerTopY - 26, 10, 3);
    g.fillRect(towerX - 2, towerTopY - 30, 3, 5);
    g.fillRect(towerX - 3, towerTopY - 32, 5, 3);
    g.fillStyle(0x0f0907, 0.4); g.fillRect(px + 2, py + h - 3, w - 4, 2);
  }

  private drawOleviste(g: Phaser.GameObjects.Graphics, b: Building, px: number, py: number, w: number, h: number) {
    const facade = Phaser.Display.Color.HexStringToColor(b.facade || "#9b8a78").color;
    const roof = Phaser.Display.Color.HexStringToColor(b.roof || "#3a2418").color;
    g.fillStyle(facade, 1); g.fillRect(px + 2, py + 24, w - 4, h - 26);
    for (let i = 0; i < 3; i++) {
      const wx = px + 4 + i * ((w - 8) / 3);
      g.fillStyle(0x1b130b, 1); g.fillRect(wx, py + 30, 4, 14);
      g.fillTriangle(wx, py + 30, wx + 4, py + 30, wx + 2, py + 26);
    }
    const centerX = px + w / 2;
    const towerW = Math.max(24, w * 0.4);
    const spireH = b.spire || 200;
    const baseTop = py + 18;
    g.fillStyle(facade, 1); g.fillRect(centerX - towerW / 2, baseTop - spireH + 40, towerW, spireH + 10);
    g.fillStyle(0x6a5a48, 1);
    for (let i = 0; i < 6; i++) g.fillRect(centerX - towerW / 2, baseTop - spireH + 60 + i * 22, towerW, 2);
    for (let i = 0; i < 4; i++) { g.fillStyle(0x1b130b, 1); g.fillRect(centerX - 3, baseTop - spireH + 70 + i * 30, 6, 10); }
    g.fillStyle(roof, 1);
    g.fillTriangle(centerX - towerW / 2 + 2, baseTop - spireH + 40, centerX + towerW / 2 - 2, baseTop - spireH + 40, centerX, baseTop - spireH - 30);
    g.fillStyle(0x5a3a28, 0.7);
    g.fillTriangle(centerX - towerW / 2 + 4, baseTop - spireH + 40, centerX, baseTop - spireH + 40, centerX - 2, baseTop - spireH - 20);
    g.fillStyle(0xd9a74a, 1);
    g.fillRect(centerX - 1, baseTop - spireH - 40, 2, 14);
    g.fillRect(centerX - 5, baseTop - spireH - 32, 10, 2);
    g.fillStyle(roof, 1); g.fillRect(px + 2, py + 20, w - 4, 4);
    g.fillTriangle(px + 2, py + 20, px + w - 2, py + 20, px + w / 2, py + 14);
    g.fillStyle(0x0f0907, 0.4); g.fillRect(px + 2, py + h - 3, w - 4, 2);
  }

  private drawPikkHermann(g: Phaser.GameObjects.Graphics, b: Building, px: number, py: number, w: number, h: number) {
    const facade = Phaser.Display.Color.HexStringToColor(b.facade || "#6a6058").color;
    const spireH = b.spire || 80;
    const centerX = px + w / 2;
    const baseW = w - 6;
    g.fillStyle(facade, 1); g.fillRect(px + 3, py + 6, baseW, h - 8);
    g.fillRect(centerX - baseW / 2 - 2, py + 10, baseW + 4, h - 14);
    g.fillStyle(0x3e3730, 1);
    for (let i = 0; i < 6; i++) g.fillRect(px + 3, py + 8 + i * 10, baseW, 1);
    for (let i = 0; i < 4; i++) { g.fillStyle(0x15110d, 1); g.fillRect(centerX - 1, py + 14 + i * 14, 2, 8); }
    g.fillStyle(facade, 1); g.fillRect(centerX - 8, py + 6 - spireH, 16, spireH + 6);
    g.fillStyle(0x25201a, 1);
    for (let cx = -8; cx < 10; cx += 4) g.fillRect(centerX + cx, py + 6 - spireH - 4, 2, 6);
    g.fillStyle(0x1b130b, 1); g.fillRect(centerX - 1, py - spireH - 14, 2, 10);
    g.fillStyle(0x0f4da2, 1); g.fillRect(centerX + 1, py - spireH - 14, 14, 3);
    g.fillStyle(0x111111, 1); g.fillRect(centerX + 1, py - spireH - 11, 14, 3);
    g.fillStyle(0xf0efe8, 1); g.fillRect(centerX + 1, py - spireH - 8, 14, 3);
  }

  private drawDomeChurch(g: Phaser.GameObjects.Graphics, b: Building, px: number, py: number, w: number, h: number) {
    const facade = Phaser.Display.Color.HexStringToColor(b.facade || "#e4dcc9").color;
    const roof = Phaser.Display.Color.HexStringToColor(b.roof || "#7a3321").color;
    g.fillStyle(facade, 1); g.fillRect(px + 2, py + 10, w - 4, h - 12);
    g.fillStyle(0xffffff, 0.15); g.fillRect(px + 2, py + 12, w - 4, 2);
    g.fillStyle(roof, 1); g.fillRect(px + 2, py + 6, w - 4, 6);
    g.fillTriangle(px + 2, py + 6, px + w - 2, py + 6, px + w / 2, py - 6);
    const centerX = px + w / 2;
    g.fillStyle(facade, 1); g.fillRect(centerX - 8, py - 26, 16, 30);
    g.fillStyle(0x7a3321, 1); g.fillEllipse(centerX, py - 32, 20, 16);
    g.fillStyle(0xd9a74a, 1); g.fillRect(centerX - 1, py - 46, 2, 12);
    g.fillRect(centerX - 1, py - 54, 2, 8); g.fillRect(centerX - 4, py - 50, 8, 2);
  }

  private drawWell(g: Phaser.GameObjects.Graphics, x: number, y: number) {
    const cx = x * TILE_SIZE + TILE_SIZE / 2, cy = y * TILE_SIZE + TILE_SIZE / 2;
    g.fillStyle(0x4a4138, 1); g.fillCircle(cx, cy, 11);
    g.fillStyle(0x1a1510, 1); g.fillCircle(cx, cy, 7);
    g.fillStyle(0x5a4b3b, 1); g.fillRect(cx - 2, cy - 16, 4, 10); g.fillRect(cx - 10, cy - 16, 20, 3);
    g.fillStyle(0x2a1a10, 1); g.fillRect(cx - 2, cy - 10, 4, 6);
  }
  private drawMarketStall(g: Phaser.GameObjects.Graphics, x: number, y: number) {
    const px = x * TILE_SIZE, py = y * TILE_SIZE;
    const tarp = [0xa3786a, 0xb8914a, 0x6b8a6a, 0x7b6a9a][(x + y) % 4];
    g.fillStyle(0x3e2a1c, 1); g.fillRect(px + 4, py + 10, TILE_SIZE - 8, 8);
    g.fillStyle(tarp, 1); g.fillRect(px + 2, py + 4, TILE_SIZE - 4, 8);
    g.fillStyle(0x1a1108, 0.5);
    for (let i = 0; i < 5; i++) g.fillRect(px + 4 + i * 5, py + 12, 2, 2);
  }
  private drawLantern(g: Phaser.GameObjects.Graphics, x: number, y: number) {
    const cx = x * TILE_SIZE + TILE_SIZE / 2, py = y * TILE_SIZE;
    g.fillStyle(0x2a1a10, 1); g.fillRect(cx - 1, py + 10, 2, 18);
    g.fillStyle(0xe7c258, 1); g.fillRect(cx - 4, py + 6, 8, 6);
    g.fillStyle(0x2a1a10, 1); g.fillRect(cx - 1, py + 4, 2, 3);
  }
  private drawTree(g: Phaser.GameObjects.Graphics, x: number, y: number) {
    const cx = x * TILE_SIZE + TILE_SIZE / 2, cy = y * TILE_SIZE + TILE_SIZE / 2;
    g.fillStyle(0x1f3b1a, 1); g.fillCircle(cx, cy, 12);
    g.fillStyle(0x2f5a24, 1); g.fillCircle(cx - 3, cy - 3, 8);
    g.fillStyle(0x2a1a10, 1); g.fillRect(cx - 2, cy + 8, 4, 6);
  }
  private drawStairs(g: Phaser.GameObjects.Graphics, x: number, y: number) {
    const px = x * TILE_SIZE, py = y * TILE_SIZE;
    g.fillStyle(0x7e6a50, 1); g.fillRect(px, py, TILE_SIZE, TILE_SIZE);
    g.fillStyle(0x4a3a28, 1);
    for (let i = 0; i < 4; i++) g.fillRect(px + 2, py + 4 + i * 7, TILE_SIZE - 4, 2);
    g.fillStyle(0xaa9070, 0.5); g.fillRect(px + 2, py + 2, TILE_SIZE - 4, 1);
  }
}

// Utility for item summaries (client-side, mirrors server/items summariseItem).
function summariseItem(it: any): string {
  const parts: string[] = [];
  if (it.damage) parts.push(`DMG ${it.damage}`);
  if (it.defense) parts.push(`DEF ${it.defense}`);
  if (it.bonusHp) parts.push(`HP +${it.bonusHp}`);
  if (it.bonusSpeed) parts.push(`SPD ${it.bonusSpeed > 0 ? "+" : ""}${Math.round(it.bonusSpeed * 100)}%`);
  if (it.bonusDamagePct) parts.push(`DMG +${Math.round(it.bonusDamagePct * 100)}%`);
  if (it.healAmount) parts.push(`HEAL ${it.healAmount}`);
  return parts.join(" · ");
}
