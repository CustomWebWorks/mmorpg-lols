/* THE TOWER OF ASH — authoritative multiplayer server
   Everything that matters (positions, HP, enemies, gold, XP, loot, shop, admin)
   is simulated and validated here. The browser is only a renderer + input pad,
   so console commands from a non-admin change nothing real. */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8000;
const W = 960, H = 600;
const DB_FILE = path.join(__dirname, "data.db"); // JSON store (preserved across redeploys)

/* ------------------------- catalog (server owned) ------------------------- */
const SWORDS = [
  { name: "Rusty Sword", power: 18, price: 0, rarity: "Common" },
  { name: "Iron Sword", power: 25, price: 150, rarity: "Common" },
  { name: "Steel Sword", power: 34, price: 340, rarity: "Uncommon" },
  { name: "Knightblade", power: 45, price: 700, rarity: "Rare" },
  { name: "Dragon Fang", power: 62, price: 1250, rarity: "Epic" },
  { name: "Moonfang", power: 72, price: 1800, rarity: "Epic" },
  { name: "Stormbreaker", power: 84, price: 2600, rarity: "Legendary" },
  { name: "Excalibur", power: 95, price: 0, rarity: "Legendary" },
];
const ARMOR = [
  { slot: "helmet", label: "Helmet", name: "Iron Helm", def: 4, price: 90, rarity: "Common", minFloor: 1 },
  { slot: "chest", label: "Chest", name: "Iron Chestplate", def: 8, price: 180, rarity: "Common", minFloor: 1 },
  { slot: "legs", label: "Legs", name: "Iron Greaves", def: 6, price: 140, rarity: "Common", minFloor: 1 },
  { slot: "boots", label: "Boots", name: "Iron Boots", def: 3, price: 100, rarity: "Common", minFloor: 1 },
  { slot: "helmet", label: "Helmet", name: "Steel Helm", def: 8, price: 260, rarity: "Uncommon", minFloor: 5 },
  { slot: "chest", label: "Chest", name: "Steel Chestplate", def: 15, price: 520, rarity: "Uncommon", minFloor: 5 },
  { slot: "legs", label: "Legs", name: "Steel Greaves", def: 11, price: 390, rarity: "Uncommon", minFloor: 5 },
  { slot: "boots", label: "Boots", name: "Steel Boots", def: 7, price: 300, rarity: "Uncommon", minFloor: 5 },
  { slot: "helmet", label: "Helmet", name: "Knight Helm", def: 14, price: 700, rarity: "Rare", minFloor: 10 },
  { slot: "chest", label: "Chest", name: "Knight Armor", def: 25, price: 1400, rarity: "Rare", minFloor: 10 },
  { slot: "legs", label: "Legs", name: "Knight Greaves", def: 19, price: 1050, rarity: "Rare", minFloor: 10 },
  { slot: "boots", label: "Boots", name: "Knight Boots", def: 12, price: 850, rarity: "Rare", minFloor: 10 },
  { slot: "helmet", label: "Helmet", name: "Dragon Helm", def: 22, price: 1800, rarity: "Epic", minFloor: 15 },
  { slot: "chest", label: "Chest", name: "Dragon Armor", def: 38, price: 3600, rarity: "Epic", minFloor: 15 },
  { slot: "legs", label: "Legs", name: "Dragon Greaves", def: 29, price: 2700, rarity: "Epic", minFloor: 15 },
  { slot: "boots", label: "Boots", name: "Dragon Boots", def: 18, price: 2200, rarity: "Epic", minFloor: 15 },
];
const CAPE = { kind: "armor", slot: "accessory", label: "Cape", name: "Kilo Shadow Cape", def: 16, price: 0, rarity: "Mythic", secret: true };
const MONSTERS = [
  { name: "Slime", hp: 35, speed: 48, color: "#5eb55b", drop: 18 },
  { name: "Goblin", hp: 48, speed: 57, color: "#789448", drop: 24 },
  { name: "Skeleton", hp: 62, speed: 53, color: "#c8c1a7", drop: 30 },
  { name: "Dark Wolf", hp: 74, speed: 76, color: "#53596b", drop: 34 },
  { name: "Orc", hp: 105, speed: 48, color: "#7d513e", drop: 42 },
  { name: "Wraith", hp: 125, speed: 61, color: "#6d71a8", drop: 50 },
  { name: "Demon Knight", hp: 170, speed: 44, color: "#8c3942", drop: 65 },
];
/* ---- OPEN GROUNDS (THE DROP): five stacked outdoor tiers, west of town ----
   Names / order / req MUST match WILD_TIERS in index.html. */
const WILD_TIERS = [
  { name: "Verdant Fields",  req: 1,  power: 3,  count: 9,  respawn: 14 },
  { name: "Amber Steppe",    req: 6,  power: 8,  count: 11, respawn: 13 },
  { name: "Highland Moor",   req: 12, power: 14, count: 13, respawn: 12 },
  { name: "Skyward Plateau", req: 18, power: 19, count: 15, respawn: 11 },
  { name: "Ashfall Barrens", req: 24, power: 25, count: 17, respawn: 10 },
];
const WILD_MAX = WILD_TIERS.length;
const INV_MAX = 36;
const OWNERS = ["dillon", "dillondean"]; // these usernames are always admin on signup
const SHOP_STOCK = SWORDS.slice(1, 7).concat(ARMOR.map(a => ({ ...a, kind: "armor" })));

/* ------------------------------- storage --------------------------------- */
let DB = { users: {}, meta: { created: Date.now() } };
try { if (fs.existsSync(DB_FILE)) DB = JSON.parse(fs.readFileSync(DB_FILE, "utf8")); } catch (e) { console.error("db read failed", e.message); }
let saveTimer = null;
function saveDB() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DB_FILE + ".tmp", JSON.stringify(DB)); fs.renameSync(DB_FILE + ".tmp", DB_FILE); }
    catch (e) { console.error("db write failed", e.message); }
  }, 400);
}
function hashPass(pass, salt) { return crypto.scryptSync(pass, salt, 32).toString("hex"); }
function newProfile() {
  return {
    level: 1, xp: 0, gold: 80, maxHp: 120, hp: 120,
    inv: [], eq: { weapon: { kind: "weapon", ...SWORDS[0] }, helmet: null, chest: null, legs: null, boots: null, accessory: null },
    bossDefeated: false, capeUnlocked: false, deaths: 0, bestFloor: 0, bestTier: 0, kills: 0, god: false,
  };
}

/* -------------------------------- world ---------------------------------- */
const rooms = new Map();          // id -> room
const players = new Map();        // id -> player
const tokens = new Map();         // token -> username
let nextId = 1;

function roomId(kind, floor, free) {
  if (kind === "town") return "town";
  if (kind === "wilds") return "w" + floor;
  return (free ? "f" : "d") + floor;
}
function getRoom(kind, floor, free) {
  const id = roomId(kind, floor, free);
  let r = rooms.get(id);
  if (!r) {
    r = { id, kind, floor: floor || 0, free: !!free, enemies: [], drops: [], shocks: [], shots: [], seq: 1 };
    if (kind === "dungeon") spawnFloor(r);
    else if (kind === "wilds") { r.queue = []; spawnWilds(r); }
    rooms.set(id, r);
  }
  return r;
}
function powerLevel(r) {
  if (r.kind === "wilds") return wildCfg(r.floor).power;
  return r.free ? r.floor + 20 : r.floor;
}
function isBossFloor(r) { return r.kind === "wilds" ? false : (r.free ? r.floor % 10 === 0 : r.floor >= 21); }
function isFightRoom(r) { return r.kind === "dungeon" || r.kind === "wilds"; }
function wildCfg(tier) { return WILD_TIERS[clamp((tier | 0) - 1, 0, WILD_MAX - 1)]; }

function spawnFloor(r) {
  r.enemies = []; r.drops = []; r.shocks = []; r.shots = [];
  if (isBossFloor(r)) return spawnBoss(r);
  const lvl = powerLevel(r);
  const count = Math.min(4 + Math.floor(lvl * 0.55), 16);
  const spots = [[245,155],[390,145],[555,155],[720,160],[285,280],[475,300],[680,275],[235,410],[400,445],[570,410],[735,445],[500,190],[820,340],[130,330]];
  for (let i = 0; i < count; i++) {
    const ti = Math.min(MONSTERS.length - 1, Math.floor((lvl - 1) / 3) + (i % 2 ? 1 : 0));
    const m = MONSTERS[ti], scale = 1 + (lvl - 1) * 0.1, p = spots[i % spots.length];
    r.enemies.push({ id: r.seq++, x: p[0], y: p[1], r: 12, hp: Math.round(m.hp * scale), maxHp: Math.round(m.hp * scale),
      speed: m.speed + Math.min(28, lvl), color: m.color, type: ti, hit: 0, atk: 0, dead: false });
  }
}
function spawnBoss(r) {
  const p = powerLevel(r), hp = Math.round(2600 + (p - 21) * 420);
  r.enemies = [{ id: r.seq++, x: 480, y: 200, r: 46, boss: true,
    name: r.free ? `Ashen Giant • Tier ${Math.ceil(r.floor / 10)}` : "THE ASHEN GIANT",
    hp, maxHp: hp, speed: 46 + Math.min(30, p - 20), color: "#7b4a3a", type: 6, hit: 0, dead: false,
    cd: 2.5, state: "idle", wind: 0, t: 0,
    touch: 12 + Math.round(p * 0.5), slamDmg: 24 + Math.round(p * 0.6), rockDmg: 16 + Math.round(p * 0.45) }];
}

/* ------------------------ open grounds terrain ---------------------------
   Copied verbatim from index.html so what the player sees blocking them is
   exactly what the server blocks them with. Do not "tidy" one side only. */
function fhash(i, j, s) { const n = Math.sin(i * 127.1 + j * 311.7 + s * 74.7) * 43758.5453; return n - Math.floor(n); }
const propCache = new Map();
function wildProps(t) {
  if (propCache.has(t)) return propCache.get(t);
  const out = [];
  for (let k = 0; k < 78; k++) {
    const r1 = fhash(k, 3, t * 7 + 1), r2 = fhash(k, 29, t * 7 + 1), r3 = fhash(k, 53, t * 7 + 1);
    const x = 34 + r1 * (W - 68), y = 112 + r2 * (H - 160);
    if (y < 170 && x > 352 && x < 608) continue;   // rising path kept clear
    if (y > H - 120 && x > 352 && x < 608) continue; // slope kept clear
    if (x < 150 && y > 228 && y < 408) continue;   // exit portal kept clear
    if (Math.hypot(x - 480, y - 330) < 78) continue; // open middle to fight in
    const edge = x < 180 || x > W - 180 || y < 180 || y > H - 130;
    if (edge && r3 < .5) out.push({ x: x - 15, y: y - 11, w: 30, h: 22 });
    else if (r3 < .6) out.push({ x: x - 14, y: y - 10, w: 28, h: 20 });
  }
  propCache.set(t, out); return out;
}
function wildBlocks(tier) { return wildProps(clamp(tier | 0, 1, WILD_MAX)); }
/* interaction zones, matching the drawn art in index.html */
const PORTAL_ZONE = { x: 26, y: 258, w: 64, h: 110 };  // town -> grounds
const WILD_EXIT = { x: 20, y: 262, w: 56, h: 102 };    // grounds -> town
const WILD_RISE = { x: 400, y: 100, w: 160, h: 62 };   // grounds -> tier up
const WILD_FALL = { x: 392, y: H - 46, w: 176, h: 34 }; // grounds -> tier down
function inZone(p, z, pad) {
  const q = pad === undefined ? 30 : pad;
  return p.x > z.x - q && p.x < z.x + z.w + q && p.y > z.y - q && p.y < z.y + z.h + q;
}
function wildFreeSpot(tier, awayFrom) {
  const blocks = wildBlocks(tier);
  for (let i = 0; i < 60; i++) {
    const x = 60 + Math.random() * (W - 120), y = 130 + Math.random() * (H - 190);
    if (blocks.some(b => rectHit(x, y, 16, b))) continue;
    if (x < 150 && y > 228 && y < 408) continue;              // never on the exit portal
    if (awayFrom && Math.hypot(x - awayFrom.x, y - awayFrom.y) < 170) continue;
    return { x, y };
  }
  return { x: 480, y: 300 };
}
function spawnWildEnemy(r, i) {
  const cfg = wildCfg(r.floor), lvl = cfg.power;
  const ti = clamp(Math.floor((lvl - 1) / 3) + (i % 2 ? 1 : 0), 0, MONSTERS.length - 1);
  const m = MONSTERS[ti], scale = 1 + (lvl - 1) * 0.1;
  const s = wildFreeSpot(r.floor, { x: 150, y: 318 });
  return { id: r.seq++, x: s.x, y: s.y, hx: s.x, hy: s.y, r: 12,
    hp: Math.round(m.hp * scale), maxHp: Math.round(m.hp * scale),
    speed: m.speed + Math.min(28, lvl), color: m.color, type: ti,
    hit: 0, atk: 0, dead: false, wander: 0, wx: 0, wy: 0 };
}
function spawnWarden(r) {
  const lvl = powerLevel(r), hp = 2400;
  const s = wildFreeSpot(r.floor, { x: 150, y: 318 });
  return { id: r.seq++, x: s.x, y: s.y, r: 42, boss: true, warden: true,
    name: "THE ASH WARDEN", hp, maxHp: hp, speed: 52, color: "#7b4a3a", type: 6,
    hit: 0, dead: false, cd: 2.6, state: "idle", wind: 0, t: 0,
    touch: 10 + Math.round(lvl * 0.45), slamDmg: 20 + Math.round(lvl * 0.5), rockDmg: 14 + Math.round(lvl * 0.4) };
}
function spawnWilds(r) {
  r.enemies = []; r.drops = []; r.shocks = []; r.shots = []; r.queue = [];
  const cfg = wildCfg(r.floor);
  for (let i = 0; i < cfg.count; i++) r.enemies.push(spawnWildEnemy(r, i));
  if (r.floor === WILD_MAX) r.enemies.push(spawnWarden(r)); // one roaming giant on the top ground
}

/* ------------------------------- helpers --------------------------------- */
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function rectHit(x, y, rr, b) { return x + rr > b.x && x - rr < b.x + b.w && y + rr > b.y && y - rr < b.y + b.h; }
const TOWN_BLOCKS = [{x:55,y:105,w:180,h:120},{x:725,y:105,w:180,h:120},{x:55,y:400,w:170,h:115},{x:735,y:400,w:170,h:115}];
const DUN_WALLS = [{x:0,y:55,w:W,h:18},{x:0,y:H-18,w:W,h:18},{x:0,y:55,w:18,h:H-73},{x:W-18,y:55,w:18,h:H-73},
  {x:165,y:120,w:20,h:190},{x:775,y:120,w:20,h:190},{x:350,y:245,w:260,h:18}];

function weaponPower(p) { const w = p.prof.eq.weapon; return w ? (w.power || 0) : 6; }
function armorDef(p) { return ["helmet","chest","legs","boots","accessory"].reduce((n, s) => n + ((p.prof.eq[s] && p.prof.eq[s].def) || 0), 0); }
function hasCape(p) { return !!(p.prof.eq.accessory && p.prof.eq.accessory.secret); }
function itemValue(it) {
  if (!it || it.secret) return 0;
  if (it.kind === "weapon") { const b = SWORDS.find(s => s.name === it.name); return b && b.price ? Math.floor(b.price * 0.45) : Math.max(15, Math.floor((it.power || 1) * 9)); }
  return it.price ? Math.floor(it.price * 0.45) : Math.max(10, Math.floor((it.def || 1) * 18));
}
function addItem(p, item) {
  if (p.prof.inv.length >= INV_MAX) { toast(p, "Bag full — sell something at the item shop."); return false; }
  p.prof.inv.push({ ...item }); return true;
}
function send(p, obj) { try { if (p.ws.readyState === 1) p.ws.send(JSON.stringify(obj)); } catch (e) {} }
function toast(p, text) { send(p, { t: "toast", text }); }
function chatAll(from, text, kind) {
  for (const p of players.values()) send(p, { t: "chat", from, text, kind });
}
function tellAdmins(text) {
  for (const p of players.values()) if (p.prof && p.user && DB.users[p.user].admin) send(p, { t: "chat", from: "SECURITY", text, kind: "warn" });
}
function pushProfile(p) {
  send(p, { t: "you", prof: p.prof, admin: !!DB.users[p.user].admin, atk: weaponPower(p), def: armorDef(p) });
  DB.users[p.user].profile = p.prof; saveDB();
}

/* -------------------------------- combat --------------------------------- */
function gainXP(p, amount) {
  p.prof.xp += amount;
  let leveled = false;
  while (p.prof.xp >= 100 + p.prof.level * 35) {
    p.prof.xp -= 100 + p.prof.level * 35; p.prof.level++; p.prof.maxHp += 12; p.prof.hp = p.prof.maxHp; leveled = true;
  }
  if (leveled) toast(p, `LEVEL UP — you are now level ${p.prof.level}.`);
}
function damagePlayer(p, raw, iframes = 0.35) {
  if (p.dead || p.inv > 0 || p.prof.god) return;
  const dmg = Math.max(1, Math.round(raw * (1 - Math.min(0.65, armorDef(p) * 0.018))));
  p.prof.hp = Math.max(0, p.prof.hp - dmg);
  p.inv = iframes; p.hurt = 0.25;
  if (p.prof.hp <= 0) killPlayer(p);
  else pushProfile(p);
}
function killPlayer(p) {
  p.dead = true; p.prof.deaths++; p.prof.hp = 0;
  toast(p, "You fell... but you keep everything.");
  send(p, { t: "dead", deaths: p.prof.deaths, best: p.prof.bestFloor });
  pushProfile(p);
}
function respawn(p) {
  p.dead = false; p.prof.hp = p.prof.maxHp; p.inv = 0;
  joinRoom(p, "town", 0, false);
  toast(p, "You wake up in Emberfall. Everything you owned is still yours.");
  pushProfile(p);
}
function rollDrop(room, e, killer) {
  const lvl = powerLevel(room), m = MONSTERS[e.type];
  if (Math.random() < Math.min(0.9, (m.drop + lvl * 1.5) / 100)) {
    const gold = 12 + Math.floor(Math.random() * 28) + lvl * 2;
    killer.prof.gold += gold; room.drops.push({ id: room.seq++, x: e.x, y: e.y, text: `+${gold} gold`, t: 1.2 });
  }
  if (Math.random() < Math.min(0.55, 0.12 + lvl * 0.018)) {
    const pool = ARMOR.filter(a => a.minFloor <= lvl);
    if (pool.length) { const a = pool[Math.floor(Math.random() * Math.min(pool.length, Math.max(1, Math.floor(lvl / 5) + 1) * 4))] || pool[0];
      room.drops.push({ id: room.seq++, x: e.x, y: e.y, t: 14, item: { ...a, kind: "armor" } }); }
  }
  const roll = Math.random(); let s = null;
  if (roll < 0.002) s = SWORDS[7];
  else if (roll < 0.008 && lvl >= 15) s = SWORDS[6];
  else if (roll < 0.025 && lvl >= 12) s = SWORDS[5];
  else if (roll < 0.10 && lvl >= 8) s = SWORDS[4];
  else if (roll < 0.22 && lvl >= 5) s = SWORDS[3];
  else if (roll < 0.45 && lvl >= 2) s = SWORDS[2];
  else if (roll < 0.70) s = SWORDS[1];
  if (s) room.drops.push({ id: room.seq++, x: e.x + 14, y: e.y, t: 18, item: { kind: "weapon", ...s } });
}
function killEnemy(room, e, killer) {
  if (e.dead) return;
  e.dead = true;
  if (room.kind === "wilds") {
    const cfg = wildCfg(room.floor);
    room.queue.push({ t: e.warden ? 120 : cfg.respawn + Math.random() * 8, warden: !!e.warden });
    if (e.warden) {
      const gold = 900 + powerLevel(room) * 40;
      for (const pl of roomPlayers(room)) { gainXP(pl, 420); pl.prof.gold += gold; toast(pl, `THE ASH WARDEN FALLS — +${gold}G.`); pushProfile(pl); }
      room.drops.push({ id: room.seq++, x: e.x - 30, y: e.y + 26, t: 45, item: { kind: "weapon", ...SWORDS[6] } });
      room.shocks = []; room.shots = [];
      chatAll("WORLD", `${DB.users[killer.user].name} felled the Ash Warden on the ${cfg.name}!`, "world");
      return;
    }
    killer.prof.kills++;
    gainXP(killer, 26 + powerLevel(room) * 4);
    rollDrop(room, e, killer);
    pushProfile(killer);
    return;
  }
  if (e.boss) {
    const p = powerLevel(room), gold = 1500 + p * 60;
    for (const pl of roomPlayers(room)) {
      gainXP(pl, 600 + p * 20); pl.prof.gold += gold;
      const first = !pl.prof.bossDefeated; pl.prof.bossDefeated = true;
      toast(pl, first ? `GIANT SLAIN! +${gold}G and FREE PLAY unlocked — head RIGHT in town.` : `Giant slain! +${gold}G.`);
      pushProfile(pl);
    }
    room.drops.push({ id: room.seq++, x: e.x - 40, y: e.y + 30, t: 60, item: { kind: "weapon", ...SWORDS[7] } });
    room.shocks = []; room.shots = [];
    chatAll("WORLD", `${DB.users[killer.user].name} slew ${e.name}!`, "world");
    return;
  }
  killer.prof.kills++;
  gainXP(killer, 22 + powerLevel(room) * 4);
  rollDrop(room, e, killer);
  pushProfile(killer);
}
function roomPlayers(room) { return [...players.values()].filter(p => p.room === room.id); }

/* --------------------------------- tick ----------------------------------- */
const TICK = 1 / 20;
function tick() {
  for (const p of players.values()) {
    p.inv = Math.max(0, p.inv - TICK); p.cool = Math.max(0, p.cool - TICK);
    p.atkT = Math.max(0, p.atkT - TICK); p.hurt = Math.max(0, p.hurt - TICK);
    if (p.dead) continue;
    // authoritative movement — client only sends a direction vector
    let dx = p.in.dx, dy = p.in.dy, l = Math.hypot(dx, dy);
    if (l > 1) { dx /= l; dy /= l; }
    if (dx || dy) {
      const spd = 190 * (hasCape(p) ? 1.18 : 1);
      const nx = p.x + dx * spd * TICK, ny = p.y + dy * spd * TICK;
      const blocks = p.roomKind === "town" ? TOWN_BLOCKS : (p.roomKind === "wilds" ? wildBlocks(p.tier) : DUN_WALLS);
      if (!blocks.some(b => rectHit(nx, ny, 9, b))) { p.x = nx; p.y = ny; }
      else if (!blocks.some(b => rectHit(nx, p.y, 9, b))) p.x = nx;
      else if (!blocks.some(b => rectHit(p.x, ny, 9, b))) p.y = ny;
      if (p.roomKind === "town") { p.x = clamp(p.x, 25, W - 25); p.y = clamp(p.y, 70, H - 25); }
      else if (p.roomKind === "wilds") { p.x = clamp(p.x, 25, W - 25); p.y = clamp(p.y, 112, H - 25); }
      else { p.x = clamp(p.x, 26, W - 26); p.y = clamp(p.y, 80, H - 26); }
    }
  }
  for (const room of rooms.values()) {
    const list = roomPlayers(room);
    if (!list.length) { if (room.kind !== "town") rooms.delete(room.id); continue; }
    if (!isFightRoom(room)) continue;
    const wild = room.kind === "wilds";
    const alive = list.filter(p => !p.dead);
    if (wild) {
      // open country: nothing is "cleared", the ground refills on a timer
      for (let i = room.queue.length - 1; i >= 0; i--) {
        room.queue[i].t -= TICK;
        if (room.queue[i].t <= 0) {
          room.enemies.push(room.queue[i].warden ? spawnWarden(room) : spawnWildEnemy(room, room.seq));
          room.queue.splice(i, 1);
        }
      }
      room.enemies = room.enemies.filter(e => !e.dead);
    }
    for (const e of room.enemies) {
      if (e.dead) continue;
      e.hit = Math.max(0, e.hit - TICK);
      let target = null, best = 1e9;
      for (const p of alive) { const d = Math.hypot(p.x - e.x, p.y - e.y); if (d < best) { best = d; target = p; } }
      if (e.boss) { if (target) updateBoss(room, e, target, best); continue; }
      e.atk = (e.atk || 0) - TICK;
      const aggro = wild ? 230 : 1e9;
      if (!target || best > aggro) { if (wild) roamEnemy(room, e); continue; }
      const dx = target.x - e.x, dy = target.y - e.y, d = best || 1;
      if (d > 30) moveEnemy(room, e, (dx / d) * e.speed * TICK, (dy / d) * e.speed * TICK);
      else if (e.atk <= 0) { e.atk = 0.8; damagePlayer(target, 5 + powerLevel(room) * 0.7); }
    }
    // hazards
    for (let i = room.shocks.length - 1; i >= 0; i--) {
      const s = room.shocks[i]; s.r += 520 * TICK;
      for (const p of alive) {
        if (s.hit && s.hit.includes(p.id)) continue;
        if (Math.abs(Math.hypot(p.x - s.x, p.y - s.y) - s.r) < 26) { (s.hit = s.hit || []).push(p.id); damagePlayer(p, s.dmg, 0.7); }
      }
      if (s.r >= s.max) room.shocks.splice(i, 1);
    }
    for (let i = room.shots.length - 1; i >= 0; i--) {
      const q = room.shots[i]; q.x += q.vx * TICK; q.y += q.vy * TICK; q.t -= TICK;
      let hit = false;
      for (const p of alive) if (Math.hypot(p.x - q.x, p.y - q.y) < 18) { damagePlayer(p, q.dmg, 0.5); hit = true; break; }
      if (hit || q.t <= 0 || q.x < 18 || q.x > W - 18 || q.y < 60 || q.y > H - 18) room.shots.splice(i, 1);
    }
    for (let i = room.drops.length - 1; i >= 0; i--) {
      const d = room.drops[i]; d.t -= TICK;
      if (d.item) {
        const p = alive.find(pl => Math.hypot(pl.x - d.x, pl.y - d.y) < 34);
        if (p) { if (addItem(p, d.item)) { toast(p, `${d.item.name} picked up.`); pushProfile(p); room.drops.splice(i, 1); } continue; }
      }
      if (d.t <= 0) room.drops.splice(i, 1);
    }
  }
}
/* wilds enemies wander their patch and respect the trees and boulders */
function moveEnemy(room, e, dx, dy) {
  if (room.kind !== "wilds") { e.x += dx; e.y += dy; return; }
  const blocks = wildBlocks(room.floor);
  const nx = e.x + dx, ny = e.y + dy;
  if (!blocks.some(b => rectHit(nx, ny, e.r, b))) { e.x = nx; e.y = ny; }
  else if (!blocks.some(b => rectHit(nx, e.y, e.r, b))) e.x = nx;
  else if (!blocks.some(b => rectHit(e.x, ny, e.r, b))) e.y = ny;
  else { e.wander = 0; }
  e.x = clamp(e.x, 30, W - 30); e.y = clamp(e.y, 118, H - 30);
}
function roamEnemy(room, e) {
  e.wander -= TICK;
  if (e.wander <= 0) {
    e.wander = 1.4 + Math.random() * 2.6;
    if (Math.random() < 0.35) { e.wx = 0; e.wy = 0; }              // stand and graze
    else {
      const home = Math.hypot(e.x - e.hx, e.y - e.hy) > 160;        // drift back home
      const a = home ? Math.atan2(e.hy - e.y, e.hx - e.x) : Math.random() * Math.PI * 2;
      e.wx = Math.cos(a); e.wy = Math.sin(a);
    }
  }
  if (e.wx || e.wy) moveEnemy(room, e, e.wx * e.speed * 0.4 * TICK, e.wy * e.speed * 0.4 * TICK);
}
function updateBoss(room, b, target, d) {
  b.t += TICK; b.cd -= TICK;
  if (b.state === "windup") {
    b.wind -= TICK;
    if (b.wind <= 0) { b.state = "idle"; b.cd = 2.4; room.shocks.push({ x: b.x, y: b.y + 20, r: 20, max: 190, dmg: b.slamDmg, hit: [] }); }
    return;
  }
  const dx = target.x - b.x, dy = target.y - b.y, dd = d || 1;
  if (dd > 70) { b.x += (dx / dd) * b.speed * TICK; b.y += (dy / dd) * b.speed * TICK; }
  b.x = clamp(b.x, 70, W - 70); b.y = clamp(b.y, 120, H - 60);
  if (b.cd <= 0) {
    if (dd < 190) { b.state = "windup"; b.wind = 0.85; for (const p of roomPlayers(room)) toast(p, "The Giant raises its fists — RUN!"); }
    else { const sp = 210; room.shots.push({ x: b.x, y: b.y - 10, vx: dx / dd * sp, vy: dy / dd * sp, dmg: b.rockDmg, t: 4 }); b.cd = 1.6; }
  }
  if (dd < b.r + 11) damagePlayer(target, b.touch, 0.6);
}

function snapshot() {
  for (const p of players.values()) {
    const room = rooms.get(p.room); if (!room) continue;
    const others = roomPlayers(room).filter(o => o.id !== p.id).map(o => ({
      id: o.id, n: DB.users[o.user].name, x: Math.round(o.x), y: Math.round(o.y), d: o.dir, a: o.atkT > 0 ? 1 : 0,
      hp: o.prof.hp, mx: o.prof.maxHp, dead: o.dead, cape: hasCape(o), adm: !!DB.users[o.user].admin, lv: o.prof.level,
    }));
    send(p, {
      t: "snap",
      me: { x: Math.round(p.x), y: Math.round(p.y), d: p.dir, a: p.atkT > 0 ? 1 : 0, hurt: p.hurt > 0 ? 1 : 0, dead: p.dead, inv: p.inv > 0 ? 1 : 0 },
      room: room.id, kind: room.kind, floor: room.floor, free: room.free,
      tier: room.kind === "wilds" ? room.floor : 0,
      players: others,
      enemies: room.enemies.filter(e => !e.dead).map(e => ({ id: e.id, x: Math.round(e.x), y: Math.round(e.y), r: e.r, type: e.type, hp: e.hp, mx: e.maxHp, hit: e.hit > 0 ? 1 : 0, boss: !!e.boss, name: e.name, st: e.state, c: e.color })),
      drops: room.drops.map(d => ({ x: Math.round(d.x), y: Math.round(d.y), text: d.text, item: d.item ? d.item.name : null })),
      shocks: room.shocks.map(s => ({ x: Math.round(s.x), y: Math.round(s.y), r: Math.round(s.r), max: s.max })),
      shots: room.shots.map(s => ({ x: Math.round(s.x), y: Math.round(s.y) })),
      cleared: room.kind === "dungeon" && !room.enemies.some(e => !e.dead), // open grounds are never "cleared"
      pop: players.size,
    });
  }
}
setInterval(tick, TICK * 1000);
setInterval(snapshot, 1000 / 12);

/* ------------------------------ room joining ------------------------------ */
function joinRoom(p, kind, floor, free, entry) {
  const room = getRoom(kind, floor, free);
  p.room = room.id; p.roomKind = kind; p.free = !!free;
  p.tier = kind === "wilds" ? room.floor : 0;
  if (kind === "town") { p.x = 480; p.y = 455; }
  else if (kind === "wilds") {
    if (entry === "rise") { p.x = 480; p.y = H - 90; p.dir = "up"; }        // came up the path
    else if (entry === "fall") { p.x = 480; p.y = 150; p.dir = "down"; }    // came down the slope
    else { p.x = 132; p.y = 318; p.dir = "right"; }                          // stepped out of the portal
    if (kind === "wilds" && room.floor > (p.prof.bestTier || 0)) { p.prof.bestTier = room.floor; }
  }
  else { p.x = 480; p.y = 515; }
  if (kind !== "wilds") p.dir = "up";
  send(p, { t: "room", id: room.id, kind, floor: room.floor, free: room.free,
    tier: kind === "wilds" ? room.floor : 0,
    theme: kind === "dungeon" ? themeIndex(room) : -1 });
}
/* the drop itself — server decides, so a tampered client gains nothing */
function dropInto(p, tier, entry) {
  const t = clamp(tier | 0, 1, WILD_MAX), cfg = WILD_TIERS[t - 1];
  joinRoom(p, "wilds", t, false, entry);
  toast(p, `${cfg.name.toUpperCase()} — tier ${t} of ${WILD_MAX}.` +
    (p.prof.level < cfg.req ? ` Suggested level ${cfg.req}+, so watch yourself.` : ""));
  pushProfile(p);
}
function themeIndex(room) {
  if (room.enemies.some(e => e.boss && !e.dead)) return 4;
  return Math.min(3, Math.floor((powerLevel(room) - 1) / 5));
}

/* ------------------------------- commands --------------------------------- */
const ADMIN_HELP = [
  "/gold <n>", "/xp <n>", "/level <n>", "/heal", "/god", "/give <item name|all>",
  "/cape", "/unlockboss", "/tp <x> <y>", "/floor <n>", "/freeplay <n>", "/boss",
  "/kill", "/who", "/admin <user>", "/unadmin <user>", "/kick <user>", "/say <text>", "/drop <tier 1-5>",
];
function runCommand(p, raw) {
  const isAdmin = !!DB.users[p.user].admin;
  const [cmd, ...rest] = raw.trim().slice(1).split(/\s+/);
  const arg = rest.join(" ");
  const num = parseFloat(rest[0]);
  if (cmd === "help") {
    send(p, { t: "chat", from: "SERVER", text: isAdmin ? "Admin commands: " + ADMIN_HELP.join("  ") : "Commands: /help, /who. Cheat commands are admin-only.", kind: "sys" });
    return;
  }
  if (cmd === "who") {
    send(p, { t: "chat", from: "SERVER", text: [...players.values()].map(o => `${DB.users[o.user].name}${DB.users[o.user].admin ? "*" : ""} (Lv${o.prof.level}, ${o.room})`).join(", ") || "nobody", kind: "sys" });
    return;
  }
  if (!isAdmin) {
    // THE GATE: every state-changing command dies here for non-admins.
    send(p, { t: "chat", from: "SERVER", text: `Blocked: "/${cmd}" is an admin command and your account is not an admin.`, kind: "warn" });
    tellAdmins(`${DB.users[p.user].name} tried to run "/${cmd} ${arg}".`);
    console.log(`[BLOCKED] ${p.user} -> /${cmd} ${arg}`);
    return;
  }
  switch (cmd) {
    case "gold": p.prof.gold = clamp(Math.round(num || 0), 0, 1e9); break;
    case "xp": gainXP(p, Math.round(num || 0)); break;
    case "level": p.prof.level = clamp(Math.round(num || 1), 1, 999); p.prof.maxHp = 120 + (p.prof.level - 1) * 12; p.prof.hp = p.prof.maxHp; break;
    case "heal": p.prof.hp = p.prof.maxHp; p.dead = false; break;
    case "god": p.prof.god = !p.prof.god; toast(p, "God mode " + (p.prof.god ? "ON" : "OFF")); break;
    case "cape": p.prof.capeUnlocked = true; p.prof.eq.accessory = { ...CAPE }; break;
    case "unlockboss": p.prof.bossDefeated = true; break;
    case "give": {
      if (arg.toLowerCase() === "all") {
        p.prof.eq.weapon = { kind: "weapon", ...SWORDS[7] };
        for (const slot of ["helmet", "chest", "legs", "boots"]) {
          const best = ARMOR.filter(a => a.slot === slot).sort((a, b) => b.def - a.def)[0];
          p.prof.eq[slot] = { ...best, kind: "armor" };
        }
        p.prof.eq.accessory = { ...CAPE }; p.prof.capeUnlocked = true; p.prof.bossDefeated = true;
        toast(p, "Admin: full best-in-slot kit equipped.");
        break;
      }
      const s = SWORDS.find(x => x.name.toLowerCase() === arg.toLowerCase());
      const a = ARMOR.find(x => x.name.toLowerCase() === arg.toLowerCase());
      if (s) addItem(p, { kind: "weapon", ...s });
      else if (a) addItem(p, { kind: "armor", ...a });
      else if (arg.toLowerCase() === "cape") { p.prof.capeUnlocked = true; addItem(p, { ...CAPE }); }
      else { toast(p, "Unknown item: " + arg); }
      break;
    }
    case "tp": { const x = parseFloat(rest[0]), y = parseFloat(rest[1]); if (isFinite(x) && isFinite(y)) { p.x = clamp(x, 25, W - 25); p.y = clamp(y, 70, H - 25); } break; }
    case "floor": { const n = clamp(Math.round(num || 1), 1, 21); joinRoom(p, "dungeon", n, false); break; }
    case "freeplay": { const n = clamp(Math.round(num || 1), 1, 999); p.prof.bossDefeated = true; joinRoom(p, "dungeon", n, true); break; }
    case "boss": { joinRoom(p, "dungeon", 21, false); break; }
    case "drop": { dropInto(p, clamp(Math.round(num || 1), 1, WILD_MAX), "portal"); break; }
    case "kill": { const room = rooms.get(p.room); if (room) for (const e of room.enemies) if (!e.dead) killEnemy(room, e, p); break; }
    case "admin": case "unadmin": {
      const target = DB.users[arg.toLowerCase()];
      if (!target) { toast(p, "No such account: " + arg); break; }
      target.admin = cmd === "admin";
      chatAll("SERVER", `${target.name} is ${target.admin ? "now an admin" : "no longer an admin"}.`, "sys");
      for (const o of players.values()) if (o.user === target.name.toLowerCase()) pushProfile(o);
      saveDB(); break;
    }
    case "kick": {
      const o = [...players.values()].find(x => x.user === arg.toLowerCase());
      if (!o) { toast(p, "Not online: " + arg); break; }
      send(o, { t: "kick", reason: "Kicked by an admin." }); o.ws.close(); break;
    }
    case "say": chatAll("ADMIN " + DB.users[p.user].name, arg, "admin"); break;
    default: toast(p, "Unknown command. /help for the list."); return;
  }
  pushProfile(p);
}

/* ------------------------------- interact --------------------------------- */
function interact(p) {
  const room = rooms.get(p.room); if (!room || p.dead) return;
  if (room.kind === "town") {
    if (inZone(p, PORTAL_ZONE, 34)) { dropInto(p, p.wantTier || 1, "portal"); return; }
    if (p.x > 730 && p.y > 370) { send(p, { t: "shop", stock: SHOP_STOCK }); return; }
    if (p.x > 850 && p.y > 245 && p.y < 375) {
      if (!p.prof.bossDefeated) { toast(p, 'Gatekeeper: "Oh Sorry, You Are Too Weak. Clear the Tower and slay the Giant first."'); return; }
      joinRoom(p, "dungeon", 1, true); toast(p, "FREE PLAY — endless floors, a Giant every 10th."); return;
    }
    if (p.x > 400 && p.x < 560 && p.y < 115) { joinRoom(p, "dungeon", 1, false); toast(p, "Tower of Ash entered."); return; }
    toast(p, p.prof.bossDefeated
      ? "North = the Tower. West = the Drop. Right = the Free Play gate."
      : "North = the Tower of Ash. West = the Drop, open grounds you can climb.");
    return;
  }
  if (room.kind === "wilds") {
    const tier = room.floor;
    if (inZone(p, WILD_EXIT, 34)) {
      joinRoom(p, "town", 0, false);
      toast(p, "Back in Emberfall. Everything you found out there is yours.");
      pushProfile(p); return;
    }
    if (inZone(p, WILD_RISE, 34)) {
      if (tier >= WILD_MAX) { toast(p, "Nothing above the Ashfall Barrens — this is the highest ground."); return; }
      dropInto(p, tier + 1, "rise"); return;
    }
    if (tier > 1 && inZone(p, WILD_FALL, 34)) { dropInto(p, tier - 1, "fall"); return; }
    toast(p, "North path climbs a tier • south slope drops one • west portal goes home.");
    return;
  }
  if (p.y > 535 && p.x > 395 && p.x < 565) { joinRoom(p, "town", 0, false); toast(p, "You left the tower. Everything you own is still yours."); pushProfile(p); return; }
  if (room.enemies.some(e => !e.dead)) { toast(p, "The stairs are sealed. Defeat every monster first."); return; }
  if (p.y < 125) {
    const lvl = powerLevel(room);
    p.prof.bestFloor = Math.max(p.prof.bestFloor, lvl);
    if (p.prof.hp < p.prof.maxHp * 0.6) { const heal = Math.max(1, Math.floor(p.prof.maxHp * 0.05)); p.prof.hp = Math.min(p.prof.maxHp, p.prof.hp + heal); toast(p, `Floor cleared! +${heal} HP.`); }
    else toast(p, "Floor cleared! HP already above 60%, no heal.");
    if (room.free) joinRoom(p, "dungeon", room.floor + 1, true);
    else if (room.floor < 20) joinRoom(p, "dungeon", room.floor + 1, false);
    else if (room.floor === 20) { joinRoom(p, "dungeon", 21, false); toast(p, "THE ASHEN GIANT AWAKENS — dodge the slams!"); }
    else { joinRoom(p, "town", 0, false); toast(p, "The Giant is slain. Free play is open through the east gate."); }
    pushProfile(p);
  }
}
function attack(p) {
  const room = rooms.get(p.room); if (!room || p.dead || p.cool > 0) return;
  p.cool = 0.36; p.atkT = 0.22;
  if (!isFightRoom(room)) return;
  const pow = weaponPower(p);
  for (const e of room.enemies) {
    if (e.dead) continue;
    const range = 58 + (e.r > 20 ? e.r - 12 : 0);
    const dx = e.x - p.x, dy = e.y - p.y;
    if (Math.hypot(dx, dy) > range) continue;
    let ok = false;
    if (p.dir === "up") ok = dy < 0 && Math.abs(dx) < 43;
    if (p.dir === "down") ok = dy > 0 && Math.abs(dx) < 43;
    if (p.dir === "left") ok = dx < 0 && Math.abs(dy) < 43;
    if (p.dir === "right") ok = dx > 0 && Math.abs(dy) < 43;
    if (!ok) continue;
    e.hp -= pow; e.hit = 0.12;
    if (e.hp <= 0) killEnemy(room, e, p);
  }
}

/* --------------------------------- http ----------------------------------- */
const app = express();
app.use(express.json());
app.use((req, res, next) => { res.setHeader("Access-Control-Allow-Origin", "*"); res.setHeader("Access-Control-Allow-Headers", "*"); next(); });
app.use(express.static(path.join(__dirname, "public")));
app.get("/api/health", (_, res) => res.json({ ok: true, players: players.size, accounts: Object.keys(DB.users).length }));
app.get("/api/leaderboard", (_, res) => {
  const rows = Object.values(DB.users).map(u => ({ name: u.name, level: u.profile.level, best: u.profile.bestFloor, gold: u.profile.gold, kills: u.profile.kills || 0, admin: !!u.admin }));
  rows.sort((a, b) => b.best - a.best || b.level - a.level);
  res.json(rows.slice(0, 25));
});
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/ws" });

/* ------------------------------- websocket -------------------------------- */
wss.on("connection", (ws, req) => {
  const p = { id: nextId++, ws, user: null, prof: null, x: 480, y: 455, dir: "up", in: { dx: 0, dy: 0 },
    cool: 0, atkT: 0, inv: 0, hurt: 0, dead: false, room: "town", roomKind: "town", free: false, tier: 0, wantTier: 1,
    lastMsg: 0, msgs: 0, visitor: req.headers["x-visitor-id"] || "" };
  ws.on("message", buf => {
    let m; try { m = JSON.parse(buf.toString().slice(0, 4000)); } catch { return; }
    const now = Date.now();
    if (now - p.lastMsg < 1000) { if (++p.msgs > 200) return; } else { p.msgs = 0; p.lastMsg = now; }

    if (m.t === "signup" || m.t === "login") {
      const name = String(m.user || "").trim().slice(0, 16);
      const pass = String(m.pass || "");
      if (!/^[A-Za-z0-9_]{3,16}$/.test(name)) return send(p, { t: "auth", ok: false, msg: "Username: 3-16 letters, numbers or _" });
      if (pass.length < 4) return send(p, { t: "auth", ok: false, msg: "Password must be at least 4 characters." });
      const key = name.toLowerCase();
      if (m.t === "signup") {
        if (DB.users[key]) return send(p, { t: "auth", ok: false, msg: "That username is taken." });
        const salt = crypto.randomBytes(16).toString("hex");
        const first = Object.keys(DB.users).length === 0 || OWNERS.includes(key);
        DB.users[key] = { name, salt, hash: hashPass(pass, salt), admin: first, created: Date.now(), profile: newProfile() };
        saveDB();
      } else {
        const u = DB.users[key];
        if (!u || u.hash !== hashPass(pass, u.salt)) return send(p, { t: "auth", ok: false, msg: "Wrong username or password." });
      }
      if ([...players.values()].some(o => o.user === key)) return send(p, { t: "auth", ok: false, msg: "That account is already logged in." });
      p.user = key; p.prof = Object.assign(newProfile(), DB.users[key].profile);
      p.prof.hp = Math.max(1, Math.min(p.prof.maxHp, p.prof.hp));
      players.set(p.id, p);
      const token = crypto.randomBytes(16).toString("hex"); tokens.set(token, key);
      send(p, { t: "auth", ok: true, name: DB.users[key].name, admin: !!DB.users[key].admin, token,
        catalog: { swords: SWORDS, armor: ARMOR, cape: CAPE, monsters: MONSTERS, invMax: INV_MAX } });
      joinRoom(p, "town", 0, false);
      pushProfile(p);
      chatAll("WORLD", `${DB.users[key].name} entered Emberfall.`, "world");
      return;
    }
    if (!p.user) return; // nothing else works before login

    switch (m.t) {
      case "in": {
        p.in.dx = clamp(Number(m.dx) || 0, -1, 1); p.in.dy = clamp(Number(m.dy) || 0, -1, 1);
        if (["up", "down", "left", "right"].includes(m.d)) p.dir = m.d;
        break;
      }
      case "atk": attack(p); break;
      case "use": interact(p); break;
      case "drop": {
        // picking a tier in the drop panel, or climbing / descending out there
        const t = clamp(Number(m.tier) | 0, 1, WILD_MAX);
        p.wantTier = t;
        const room = rooms.get(p.room);
        if (room && room.kind === "wilds" && !p.dead) {
          if (t === room.floor + 1 && inZone(p, WILD_RISE, 34)) dropInto(p, t, "rise");
          else if (t === room.floor - 1 && inZone(p, WILD_FALL, 34)) dropInto(p, t, "fall");
        }
        break;
      }
      case "respawn": if (p.dead) respawn(p); break;
      case "buy": {
        const item = SHOP_STOCK[m.i | 0];
        if (!item || !item.price) return;
        if (p.prof.gold < item.price) return toast(p, "Not enough gold.");
        if (p.prof.inv.length >= INV_MAX) return toast(p, "Bag full.");
        p.prof.gold -= item.price;
        addItem(p, item.kind === "armor" ? { ...item } : { kind: "weapon", ...item });
        toast(p, `Bought ${item.name} for ${item.price}G.`);
        pushProfile(p); break;
      }
      case "sell": {
        const it = p.prof.inv[m.i | 0]; if (!it) return;
        if (it.secret) return toast(p, "The cape refuses to be sold.");
        const v = itemValue(it); p.prof.gold += v; p.prof.inv.splice(m.i | 0, 1);
        toast(p, `Sold ${it.name} for ${v}G.`); pushProfile(p); break;
      }
      case "equip": {
        const idx = m.i | 0, it = p.prof.inv[idx]; if (!it) return;
        const slot = it.kind === "weapon" ? "weapon" : it.slot; if (!slot) return;
        const old = p.prof.eq[slot];
        p.prof.eq[slot] = { ...it }; p.prof.inv.splice(idx, 1);
        if (old) p.prof.inv.splice(idx, 0, old);
        toast(p, old ? `Equipped ${it.name}. ${old.name} moved to your bag.` : `Equipped ${it.name}.`);
        pushProfile(p); break;
      }
      case "unequip": {
        const slot = String(m.slot || ""); const cur = p.prof.eq[slot]; if (!cur) return;
        if (p.prof.inv.length >= INV_MAX) return toast(p, "Bag full.");
        p.prof.inv.push(cur); p.prof.eq[slot] = null; toast(p, `Unequipped ${cur.name}.`); pushProfile(p); break;
      }
      case "secret": {
        // the K-I-L-O secret: allowed for everyone, but granted by the server
        if (!p.prof.capeUnlocked) {
          p.prof.capeUnlocked = true;
          if (p.prof.eq.accessory) p.prof.inv.push(p.prof.eq.accessory);
          p.prof.eq.accessory = { ...CAPE };
          toast(p, "SECRET UNLOCKED — the Kilo Shadow Cape is yours!");
        }
        pushProfile(p); break;
      }
      case "chat": {
        const text = String(m.text || "").slice(0, 200).trim(); if (!text) return;
        if (text[0] === "/") return runCommand(p, text);
        chatAll(DB.users[p.user].name, text, DB.users[p.user].admin ? "admin" : "player");
        break;
      }
      case "cheat": {
        // client-side tamper report — server never trusts the client, this is just for the log
        tellAdmins(`${DB.users[p.user].name}: console tampering detected (${String(m.what || "").slice(0, 60)}) — no effect, server state is authoritative.`);
        send(p, { t: "chat", from: "SECURITY", text: "Console tampering does nothing here: your stats live on the server.", kind: "warn" });
        break;
      }
    }
  });
  ws.on("close", () => {
    if (p.user) {
      DB.users[p.user].profile = p.prof; saveDB();
      chatAll("WORLD", `${DB.users[p.user].name} left.`, "world");
    }
    players.delete(p.id);
  });
});

server.listen(PORT, "0.0.0.0", () => console.log("Tower of Ash server on " + PORT));
