import crypto from "node:crypto";
import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: false }, transports: ["websocket", "polling"] });

const PORT = Number(process.env.PORT || 3000);
const MAX_PLAYERS = 8;
const GAME_MS = Number(process.env.GAME_MS || 105_000);
const TURN_MS = Number(process.env.TURN_MS || 12_000);
const SOLO_MOVE_MS = Number(process.env.SOLO_MOVE_MS || 10_000);
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const COLORS = ["#ff5d8f", "#5bbcff", "#9bde77", "#ffbf4b", "#aa82ff", "#ff8566", "#43d2bd", "#788bff"];
const AVATARS = ["bunny", "cat", "frog", "bear", "fox", "panda", "bird", "blob"];
const VISION_TYPES = [
  { id: "laser", label: "Lasers", icon: "⚡", color: "#ff426f" },
  { id: "crack", label: "Cracked Floors", icon: "✦", color: "#ff9f43" },
  { id: "slime", label: "Slime", icon: "●", color: "#55c97a" },
  { id: "glitch", label: "Glitches", icon: "◆", color: "#9f70ff" },
];
const rooms = new Map();

app.use(express.static("public"));
app.get("/health", (_req, res) => res.json({ ok: true, rooms: rooms.size, game: "peril-pals" }));

function safeName(raw) {
  const value = String(raw || "").replace(/[<>]/g, "").trim().slice(0, 16);
  return value || "Mystery Scout";
}

function safeCode(raw) {
  return String(raw || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 4);
}

function makeCode() {
  let code;
  do code = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
  while (rooms.has(code));
  return code;
}

function makePlayer(name, index, { bot = false } = {}) {
  return {
    id: crypto.randomUUID(), token: crypto.randomUUID(), socketId: null,
    name: safeName(name), color: COLORS[index % COLORS.length], avatar: AVATARS[index % AVATARS.length],
    isBot: bot, connected: true, visionTypes: [], stats: { moves: 0, pings: 0, mistakes: 0 }, disconnectTimer: null,
  };
}

function createRoom(host) {
  const code = makeCode();
  const room = {
    code, hostId: host.id, players: new Map([[host.id, host]]), phase: "lobby",
    phaseEndsAt: 0, gameEndsAt: 0, turnEndsAt: 0, captainId: null, turnNumber: 0,
    cols: 7, rows: 6, board: null, robot: null, goal: null, trail: [], lives: 3, pings: [],
    cores: [], soloMode: false, soloStage: null, soloStep: 0, soloPingsLeft: 0,
    lastEvent: null, eventSequence: 0, roundsPlayed: 0, outcome: null,
  };
  rooms.set(code, room);
  return room;
}

function publicPlayer(player) {
  const vision = player.visionTypes.map((id) => VISION_TYPES.find((type) => type.id === id)).filter(Boolean);
  return { id: player.id, name: player.name, color: player.color, avatar: player.avatar, isBot: player.isBot, connected: player.connected, vision, stats: player.stats };
}

function publicRoom(room) {
  return { code: room.code, hostId: room.hostId, phase: room.phase, phaseEndsAt: room.phaseEndsAt, serverNow: Date.now(), players: [...room.players.values()].map(publicPlayer), roundsPlayed: room.roundsPlayed, outcome: room.outcome, soloMode: room.soloMode };
}

function sendRoom(room) { io.to(room.code).emit("room-state", publicRoom(room)); }

function stateFor(room, viewer) {
  const now = Date.now();
  const hazards = room.board?.hazards
    .filter((hazard) => room.phase === "results" || hazard.revealed || (room.soloMode ? room.soloStage === "look" : viewer.visionTypes.includes(hazard.type)))
    .map((hazard) => ({ ...hazard, private: !room.soloMode && !hazard.revealed && viewer.visionTypes.includes(hazard.type), memory: room.soloMode && room.soloStage === "look" })) || [];
  return {
    code: room.code, phase: room.phase, phaseEndsAt: room.phaseEndsAt, gameEndsAt: room.gameEndsAt,
    turnEndsAt: room.turnEndsAt, serverNow: now, captainId: room.captainId, turnNumber: room.turnNumber,
    board: room.board ? { cols: room.cols, rows: room.rows, hazards } : null, robot: room.robot, goal: room.goal,
    trail: room.trail, lives: room.lives, pings: room.pings.filter((ping) => now - ping.at < 30_000),
    cores: room.cores, soloMode: room.soloMode, soloStage: room.soloStage, soloStep: room.soloStep,
    soloPractice: room.soloMode && room.soloStep === 0, soloPingsLeft: room.soloPingsLeft,
    lastEvent: room.lastEvent, myVision: viewer.visionTypes.map((id) => VISION_TYPES.find((type) => type.id === id)).filter(Boolean),
    players: [...room.players.values()].map(publicPlayer), outcome: room.outcome,
  };
}

function sendGame(room) {
  for (const player of room.players.values()) {
    if (!player.isBot && player.connected && player.socketId) io.to(player.socketId).emit("game-state", stateFor(room, player));
  }
}

function makeHazards(room, safePath) {
  const hazards = [];
  for (let row = 0; row < room.rows; row += 1) {
    for (let col = 0; col < room.cols; col += 1) {
      const key = `${col},${row}`;
      if (safePath.has(key)) continue;
      if (Math.random() < 0.58) {
        const type = VISION_TYPES[(col * 3 + row + room.roundsPlayed + room.soloStep + Math.floor(Math.random() * 4)) % VISION_TYPES.length];
        hazards.push({ id: crypto.randomUUID(), x: col, y: row, type: type.id, revealed: false });
      }
    }
  }
  return hazards;
}

function makeBoard(room) {
  const start = { x: 0, y: room.rows - 1 };
  const goal = { x: room.cols - 1, y: 0 };
  const safePath = new Set([`${start.x},${start.y}`]);
  let x = start.x;
  let y = start.y;
  while (x !== goal.x || y !== goal.y) {
    const canRight = x < goal.x;
    const canUp = y > goal.y;
    if (canRight && canUp) {
      if (Math.random() < 0.5) x += 1;
      else y -= 1;
    } else if (canRight) x += 1;
    else y -= 1;
    safePath.add(`${x},${y}`);
  }
  const pathTiles = [...safePath].map((key) => {
    const [tileX, tileY] = key.split(",").map(Number);
    return { x: tileX, y: tileY };
  });
  return { start, goal, safePath, pathTiles, hazards: makeHazards(room, safePath) };
}

function placeCores(room) {
  const path = room.board.pathTiles.slice(1, -1);
  const indexes = [0.22, 0.5, 0.78].map((ratio) => Math.min(path.length - 1, Math.floor(path.length * ratio)));
  const seen = new Set();
  room.cores = indexes.map((index) => path[index]).filter((tile) => {
    const key = `${tile.x},${tile.y}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  }).map((tile, index) => ({ id: `core-${index + 1}`, ...tile, collected: false }));
}

function shiftHazards(room) {
  room.board.hazards = makeHazards(room, room.board.safePath);
}

function assignVisions(room) {
  const players = [...room.players.values()];
  players.forEach((player) => { player.visionTypes = []; player.stats = { moves: 0, pings: 0, mistakes: 0 }; });
  VISION_TYPES.forEach((type, index) => players[(index + room.roundsPlayed) % players.length].visionTypes.push(type.id));
  players.forEach((player, index) => {
    if (!player.visionTypes.length) player.visionTypes.push(VISION_TYPES[(index + room.roundsPlayed) % VISION_TYPES.length].id);
  });
}

function setupGame(room) {
  room.soloMode = connectedHumans(room).length === 1;
  room.soloStage = null; room.soloStep = 0; room.soloPingsLeft = 0;
  assignVisions(room);
  room.board = makeBoard(room);
  room.robot = { ...room.board.start };
  room.goal = { ...room.board.goal };
  room.trail = [{ ...room.robot }]; placeCores(room);
  room.lives = 3; room.pings = []; room.lastEvent = null; room.captainId = null; room.turnNumber = 0; room.outcome = null;
  room.roundsPlayed += 1;
  room.phase = "countdown";
  room.phaseEndsAt = Date.now() + 3_200;
  sendRoom(room); sendGame(room);
}

function connectedHumans(room) { return [...room.players.values()].filter((player) => !player.isBot && player.connected); }

function addPing(room, player, x, y, { bot = false } = {}) {
  room.pings = room.pings.filter((ping) => !(ping.playerId === player.id && ping.x === x && ping.y === y));
  room.pings.push({ id: ++room.eventSequence, playerId: player.id, playerName: player.name, color: player.color, x, y, at: Date.now(), bot });
  player.stats.pings += 1;
}

function rotateCaptain(room, now, first = false) {
  const humans = connectedHumans(room);
  if (!humans.length) { room.captainId = null; room.turnEndsAt = now + TURN_MS; return; }
  const currentIndex = humans.findIndex((player) => player.id === room.captainId);
  const nextIndex = first || currentIndex < 0 ? 0 : (currentIndex + 1) % humans.length;
  room.captainId = humans[nextIndex].id;
  room.turnNumber += 1;
  room.turnEndsAt = now + TURN_MS;
  room.pings = room.pings.filter((ping) => now - ping.at < 22_000);
}

function soloLookDuration(step) {
  if (step === 0) return 0;
  if (step <= 2) return 8_000;
  if (step <= 4) return 6_000;
  return 5_000;
}

function beginSoloLook(room, now) {
  room.soloStage = "look";
  room.soloPingsLeft = 0;
  room.pings = [];
  const duration = soloLookDuration(room.soloStep);
  room.phaseEndsAt = duration ? now + duration : 0;
  room.turnEndsAt = 0;
  sendGame(room);
}

function beginSoloMove(room, now) {
  if (!room.soloMode || room.soloStage !== "look") return;
  room.soloStage = "move";
  room.phaseEndsAt = 0;
  room.soloPingsLeft = 2;
  room.turnEndsAt = room.soloStep === 0 ? 0 : now + SOLO_MOVE_MS;
  room.lastEvent = { id: ++room.eventSequence, type: "hide", practice: room.soloStep === 0, at: now };
  sendGame(room);
}

function nextSoloTurn(room, now) {
  room.soloStep += 1;
  if (!room.gameEndsAt) room.gameEndsAt = now + GAME_MS;
  shiftHazards(room);
  beginSoloLook(room, now);
}

function beginGame(room, now) {
  room.phase = "playing";
  if (room.soloMode) {
    const human = connectedHumans(room)[0];
    room.captainId = human?.id || null;
    room.gameEndsAt = 0;
    room.phaseEndsAt = 0;
    beginSoloLook(room, now);
  } else {
    room.phaseEndsAt = now + GAME_MS; room.gameEndsAt = room.phaseEndsAt;
    rotateCaptain(room, now, true);
  }
  room.lastEvent = { id: ++room.eventSequence, type: "start", at: now };
  sendRoom(room); sendGame(room);
}

function finishGame(room, won, reason, now) {
  if (room.phase !== "playing") return;
  const secondsLeft = Math.max(0, Math.ceil((room.gameEndsAt - now) / 1000));
  const mistakes = [...room.players.values()].reduce((sum, player) => sum + player.stats.mistakes, 0);
  const score = won ? secondsLeft * 100 + room.lives * 500 + room.trail.length * 30 - mistakes * 100 : room.trail.length * 20;
  const stars = won ? (room.lives === 3 ? 3 : room.lives === 2 ? 2 : 1) : 0;
  room.phase = "results"; room.phaseEndsAt = now + 60_000; room.turnEndsAt = 0;
  room.outcome = { won, reason, score: Math.max(0, score), stars, secondsLeft, lives: room.lives };
  room.lastEvent = { id: ++room.eventSequence, type: won ? "win" : "loss", reason, at: now };
  sendGame(room); sendRoom(room);
}

function moveRobot(room, player, x, y) {
  const now = Date.now();
  if (room.phase !== "playing" || room.captainId !== player.id) return { ok: false, error: "It isn’t your turn to navigate." };
  if (room.soloMode && room.soloStage !== "move") return { ok: false, error: "Study the dangers first, then press Ready." };
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= room.cols || y >= room.rows) return { ok: false, error: "That tile is outside the map." };
  if (Math.abs(x - room.robot.x) + Math.abs(y - room.robot.y) !== 1) return { ok: false, error: "Move one tile at a time." };
  const lockedGoal = x === room.goal.x && y === room.goal.y && room.cores.some((core) => !core.collected);
  if (lockedGoal) return { ok: false, error: "The exit is locked. Collect all three signal cores first." };
  player.stats.moves += 1;
  const hazard = room.board.hazards.find((item) => item.x === x && item.y === y);
  if (hazard) {
    hazard.revealed = true; room.lives -= 1; player.stats.mistakes += 1;
    const type = VISION_TYPES.find((item) => item.id === hazard.type);
    room.lastEvent = { id: ++room.eventSequence, type: "hazard", hazardType: hazard.type, hazardLabel: type.label, icon: type.icon, x, y, playerId: player.id, at: now };
    if (room.lives <= 0) { finishGame(room, false, "The signal core ran out of power.", now); return { ok: true }; }
  } else {
    room.robot = { x, y }; room.trail.push({ x, y });
    const core = room.cores.find((item) => !item.collected && item.x === x && item.y === y);
    if (core) {
      core.collected = true;
      room.lastEvent = { id: ++room.eventSequence, type: "core", x, y, playerId: player.id, at: now };
    } else room.lastEvent = { id: ++room.eventSequence, type: "safe", x, y, playerId: player.id, at: now };
    if (x === room.goal.x && y === room.goal.y) { finishGame(room, true, "The Pals turned every peril into a shared path.", now); return { ok: true }; }
  }
  if (room.soloMode) nextSoloTurn(room, now);
  else { shiftHazards(room); rotateCaptain(room, now); sendGame(room); }
  return { ok: true };
}

function removePlayer(room, playerId) {
  const player = room.players.get(playerId);
  if (!player) return;
  if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
  room.players.delete(playerId);
  const humans = [...room.players.values()].filter((item) => !item.isBot);
  if (!humans.length) { rooms.delete(room.code); return; }
  if (room.hostId === playerId) room.hostId = humans[0].id;
  if (room.captainId === playerId && room.phase === "playing") rotateCaptain(room, Date.now());
  sendRoom(room); if (["countdown", "playing"].includes(room.phase)) sendGame(room);
}

io.on("connection", (socket) => {
  socket.on("create-room", ({ name } = {}, ack = () => {}) => {
    const player = makePlayer(name, 0); player.socketId = socket.id;
    const room = createRoom(player); socket.join(room.code); socket.data = { roomCode: room.code, playerId: player.id };
    ack({ ok: true, room: publicRoom(room), playerId: player.id, token: player.token }); sendRoom(room);
  });
  socket.on("join-room", ({ code, name } = {}, ack = () => {}) => {
    const room = rooms.get(safeCode(code));
    if (!room) return ack({ ok: false, error: "That room signal is gone. Check the code." });
    if (room.players.size >= MAX_PLAYERS) return ack({ ok: false, error: "That mission is full." });
    if (!["lobby", "results"].includes(room.phase)) return ack({ ok: false, error: "A mission is underway. Join after this run." });
    const player = makePlayer(name, room.players.size); player.socketId = socket.id; room.players.set(player.id, player);
    socket.join(room.code); socket.data = { roomCode: room.code, playerId: player.id };
    ack({ ok: true, room: publicRoom(room), playerId: player.id, token: player.token }); sendRoom(room);
  });
  socket.on("resume-room", ({ code, playerId, token } = {}, ack = () => {}) => {
    const room = rooms.get(safeCode(code)); const player = room?.players.get(playerId);
    if (!room || !player || player.isBot || player.token !== token) return ack({ ok: false });
    if (player.disconnectTimer) clearTimeout(player.disconnectTimer);
    player.disconnectTimer = null; player.connected = true; player.socketId = socket.id;
    socket.join(room.code); socket.data = { roomCode: room.code, playerId: player.id };
    if (room.phase === "playing" && !room.captainId) rotateCaptain(room, Date.now(), true);
    ack({ ok: true, room: publicRoom(room), playerId: player.id, token: player.token }); sendRoom(room);
    if (["countdown", "playing"].includes(room.phase)) io.to(socket.id).emit("game-state", stateFor(room, player));
  });
  socket.on("start-game", (ack) => {
    const respond = typeof ack === "function" ? ack : () => {};
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.data.playerId) return respond({ ok: false, error: "Only the host can launch the mission." });
    if (!["lobby", "results"].includes(room.phase) || connectedHumans(room).length < 1) return respond({ ok: false, error: "At least one player must be connected." });
    setupGame(room); respond({ ok: true });
  });
  socket.on("finish-solo-look", (ack) => {
    const respond = typeof ack === "function" ? ack : () => {};
    const room = rooms.get(socket.data.roomCode); const player = room?.players.get(socket.data.playerId);
    if (!room || !player || !room.soloMode || room.phase !== "playing" || room.soloStage !== "look") return respond({ ok: false });
    beginSoloMove(room, Date.now()); respond({ ok: true });
  });
  socket.on("ping-tile", ({ x, y } = {}, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode); const player = room?.players.get(socket.data.playerId);
    if (!room || !player || room.phase !== "playing") return ack({ ok: false });
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= room.cols || y >= room.rows) return ack({ ok: false });
    if (room.soloMode) {
      if (room.soloStage !== "move") return ack({ ok: false, error: "Memory markers become available after dangers are hidden." });
      if (room.soloPingsLeft <= 0) return ack({ ok: false, error: "No memory markers left this move." });
      room.soloPingsLeft -= 1;
    }
    addPing(room, player, x, y); sendGame(room); ack({ ok: true });
  });
  socket.on("move-robot", ({ x, y } = {}, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode); const player = room?.players.get(socket.data.playerId);
    if (!room || !player) return ack({ ok: false, error: "Room unavailable." });
    ack(moveRobot(room, player, x, y));
  });
  socket.on("add-bot", (ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostId !== socket.data.playerId || !["lobby", "results"].includes(room.phase)) return ack({ ok: false });
    if (room.players.size >= MAX_PLAYERS) return ack({ ok: false, error: "The team is full." });
    const count = [...room.players.values()].filter((player) => player.isBot).length + 1;
    const bot = makePlayer(`Scout Bot ${count}`, room.players.size, { bot: true });
    room.players.set(bot.id, bot);
    sendRoom(room); ack({ ok: true });
  });
  socket.on("remove-bot", ({ playerId } = {}, ack = () => {}) => {
    const room = rooms.get(socket.data.roomCode); const player = room?.players.get(playerId);
    if (!room || room.hostId !== socket.data.playerId || !player?.isBot || !["lobby", "results"].includes(room.phase)) return ack({ ok: false });
    room.players.delete(playerId); sendRoom(room); ack({ ok: true });
  });
  socket.on("leave-room", () => {
    const roomCode = socket.data.roomCode; const playerId = socket.data.playerId; socket.leave(roomCode); socket.data = {};
    const room = rooms.get(roomCode); if (room) removePlayer(room, playerId);
  });
  socket.on("disconnect", () => {
    const room = rooms.get(socket.data.roomCode); const player = room?.players.get(socket.data.playerId);
    if (!room || !player) return;
    player.connected = false; player.socketId = null;
    if (room.captainId === player.id && room.phase === "playing") rotateCaptain(room, Date.now());
    sendRoom(room); if (["countdown", "playing"].includes(room.phase)) sendGame(room);
    player.disconnectTimer = setTimeout(() => removePlayer(room, player.id), 30_000);
  });
});

let lastBroadcast = 0;
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase === "countdown" && now >= room.phaseEndsAt) beginGame(room, now);
    if (room.phase === "playing") {
      if (room.gameEndsAt && now >= room.gameEndsAt) finishGame(room, false, "The exit signal faded before the team arrived.", now);
      else if (room.soloMode && room.soloStage === "look" && room.phaseEndsAt && now >= room.phaseEndsAt) beginSoloMove(room, now);
      else if (room.soloMode && room.soloStage === "move" && room.turnEndsAt && now >= room.turnEndsAt) {
        room.lives -= 1;
        room.lastEvent = { id: ++room.eventSequence, type: "timeout", playerId: room.captainId, at: now };
        if (room.lives <= 0) finishGame(room, false, "Three missed moves drained BIMO’s signal.", now);
        else nextSoloTurn(room, now);
      } else if (!room.soloMode && now >= room.turnEndsAt) {
        room.lastEvent = { id: ++room.eventSequence, type: "timeout", playerId: room.captainId, at: now };
        rotateCaptain(room, now); sendGame(room);
      }
    }
    if (["countdown", "playing"].includes(room.phase) && now - lastBroadcast >= 500) sendGame(room);
  }
  if (now - lastBroadcast >= 500) lastBroadcast = now;
}, 100);

httpServer.listen(PORT, () => console.log(`PERIL PALS is serving on http://localhost:${PORT}`));
