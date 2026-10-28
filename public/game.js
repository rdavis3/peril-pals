const socket = io();
const $ = (selector) => document.querySelector(selector);
const screens = { home: $("#homeScreen"), lobby: $("#lobbyScreen"), game: $("#gameScreen"), results: $("#resultsScreen") };
const HAZARDS = {
  laser: { label: "Lasers", icon: "⚡", color: "#ff426f" },
  crack: { label: "Cracked Floors", icon: "✦", color: "#ff9f43" },
  slime: { label: "Slime", icon: "●", color: "#55c97a" },
  glitch: { label: "Glitches", icon: "◆", color: "#9f70ff" },
};

let room = null;
let game = null;
let meId = null;
let currentScreen = "home";
let selected = null;
let clockOffset = 0;
let soundOn = localStorage.getItem("peril-pals-sound") !== "off";
let audioContext = null;
let toastTimer = null;
let eventTimer = null;
let lastEventId = null;
let lastCountdown = null;

function showScreen(name) {
  currentScreen = name;
  Object.entries(screens).forEach(([key, element]) => element.classList.toggle("hidden", key !== name));
}

function serverNow() { return Date.now() - clockOffset; }

function toast(message) {
  clearTimeout(toastTimer);
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  toastTimer = setTimeout(() => $("#toast").classList.remove("show"), 1900);
}

function eventToast(message, danger = false) {
  clearTimeout(eventTimer);
  const element = $("#eventToast");
  element.textContent = message;
  element.style.background = danger ? "#ff5d8f" : "#ffd166";
  element.classList.remove("hidden");
  eventTimer = setTimeout(() => element.classList.add("hidden"), 2100);
}

function beep(frequency = 520, duration = .08, type = "sine", volume = .06) {
  if (!soundOn) return;
  audioContext ||= new AudioContext();
  const oscillator = audioContext.createOscillator();
  const gain = audioContext.createGain();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  gain.gain.setValueAtTime(volume, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(.001, audioContext.currentTime + duration);
  oscillator.connect(gain).connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + duration);
}

function playerName() {
  const value = $("#playerName").value.trim().slice(0, 16);
  if (value) localStorage.setItem("peril-pals-name", value);
  return value;
}

function saveSession(result) {
  meId = result.playerId;
  room = result.room;
  localStorage.setItem("peril-pals-session", JSON.stringify({ code: room.code, playerId: meId, token: result.token }));
  history.replaceState(null, "", `?room=${room.code}`);
  updateRoom(room);
}

function clearSession() {
  localStorage.removeItem("peril-pals-session");
  history.replaceState(null, "", location.pathname);
  room = null; game = null; meId = null; selected = null;
}

function createRoom() {
  $("#homeError").textContent = "";
  $("#createButton").disabled = true;
  socket.emit("create-room", { name: playerName() }, (result) => {
    $("#createButton").disabled = false;
    if (!result.ok) return $("#homeError").textContent = result.error || "Could not create a mission.";
    saveSession(result);
  });
}

function joinRoom() {
  $("#homeError").textContent = "";
  const code = $("#roomCodeInput").value.trim().toUpperCase();
  if (code.length !== 4) return $("#homeError").textContent = "Enter the four-character mission code.";
  $("#joinButton").disabled = true;
  socket.emit("join-room", { code, name: playerName() }, (result) => {
    $("#joinButton").disabled = false;
    if (!result.ok) return $("#homeError").textContent = result.error || "Could not join that mission.";
    saveSession(result);
  });
}

function updateRoom(nextRoom) {
  room = nextRoom;
  if (nextRoom.serverNow) clockOffset = Date.now() - nextRoom.serverNow;
  $("#roomCode").textContent = room.code;
  $("#gameRoomCode").textContent = room.code;
  const isHost = room.hostId === meId;
  if (room.phase === "lobby") {
    showScreen("lobby");
    renderLobby(isHost);
  } else if (["countdown", "playing"].includes(room.phase)) {
    showScreen("game");
  } else if (room.phase === "results") {
    showScreen("results");
    renderResults(isHost);
  }
}

function avatarText(avatar) {
  return { bunny: "ᵔᴗᵔ", cat: "•ﻌ•", frog: "•◡•", bear: "•㉨•", fox: "ᵔﻌᵔ", panda: "◉ᴗ◉", bird: "•ө•", blob: "•ᴗ•" }[avatar] || "•ᴗ•";
}

function renderLobby(isHost) {
  const humanCount = room.players.filter((player) => !player.isBot).length;
  $("#playerCount").textContent = `${humanCount} / 8`;
  const list = $("#playerList");
  list.replaceChildren();
  room.players.forEach((player) => {
    const card = document.createElement("div");
    card.className = `player-card ${player.connected ? "" : "offline"}`;
    const avatar = document.createElement("div");
    avatar.className = "player-avatar";
    avatar.style.background = player.color;
    avatar.textContent = avatarText(player.avatar);
    const name = document.createElement("div");
    name.className = "player-name";
    name.textContent = `${player.name}${player.id === meId ? " (you)" : ""}`;
    card.append(avatar, name);
    const tag = document.createElement("span");
    tag.className = "player-tag";
    tag.textContent = player.id === room.hostId ? "host" : player.isBot ? "guide" : "scout";
    card.append(tag);
    if (player.isBot && isHost) {
      const remove = document.createElement("button");
      remove.className = "bot-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${player.name}`);
      remove.onclick = () => socket.emit("remove-bot", { playerId: player.id });
      card.append(remove);
    }
    list.append(card);
  });
  $("#addBotButton").classList.add("hidden");
  $("#startButton").classList.toggle("hidden", !isHost);
  $("#startButton").disabled = humanCount < 1;
  $("#startButton").textContent = humanCount === 1 ? "Start solo memory challenge" : "Begin the team peril";
  $("#modeNote").innerHTML = humanCount === 1
    ? "<span>◆</span><p><b>Solo challenge:</b> Your first LOOK and MOVE are untimed practice. Then the memory timer begins.</p>"
    : "<span>✦</span><p><b>Team mode:</b> Every device reveals different dangers. Ping what only you can see before the navigator moves.</p>";
  $("#waitingText").classList.toggle("hidden", isHost);
}

function renderGame() {
  if (!game?.board) return;
  renderVision();
  renderBoard();
  renderSignals();
  renderScouts();
  updateTurnUI();
}

function renderVision() {
  const container = $("#visionBadges");
  container.replaceChildren();
  if (game.soloMode) {
    const looking = game.soloStage === "look";
    $("#visionKicker").textContent = looking ? "LOOK — DANGERS VISIBLE" : "REMEMBER — DANGERS HIDDEN";
    $("#visionTitle").textContent = looking ? "Study every danger." : "Move from memory.";
    $("#visionWarning").textContent = looking
      ? (game.soloPractice
        ? "Take as long as you need. Press Ready when you have memorized the danger tiles."
        : "The dangers disappear when the LOOK timer reaches zero. Press Ready sooner if you remember them.")
      : `You have ${game.soloPingsLeft} memory marker${game.soloPingsLeft === 1 ? "" : "s"} and one move.`;
    const badge = document.createElement("div");
    badge.className = "vision-badge";
    const icon = document.createElement("span");
    icon.style.background = looking ? "#ffd166" : "#aa82ff";
    icon.textContent = looking ? "👀" : "?";
    const label = document.createElement("b");
    label.textContent = looking ? "Remember the danger tiles" : "Symbols are now hidden";
    badge.append(icon, label); container.append(badge);
    return;
  }
  $("#visionKicker").textContent = "YOUR PRIVATE VIEW";
  $("#visionTitle").textContent = "You can see:";
  $("#visionWarning").textContent = "Other scouts cannot see these hazards unless someone pings them.";
  game.myVision.forEach((vision) => {
    const badge = document.createElement("div");
    badge.className = "vision-badge";
    const icon = document.createElement("span");
    icon.style.background = vision.color;
    icon.textContent = vision.icon;
    const label = document.createElement("b");
    label.textContent = vision.label;
    badge.append(icon, label);
    container.append(badge);
  });
}

function cellKey(x, y) { return `${x},${y}`; }
function isAdjacent(x, y) { return game?.robot && Math.abs(x - game.robot.x) + Math.abs(y - game.robot.y) === 1; }

function renderBoard() {
  const board = $("#gameBoard");
  board.style.gridTemplateColumns = `repeat(${game.board.cols}, 1fr)`;
  board.style.gridTemplateRows = `repeat(${game.board.rows}, 1fr)`;
  board.replaceChildren();
  const hazards = new Map(game.board.hazards.map((hazard) => [cellKey(hazard.x, hazard.y), hazard]));
  const trail = new Set(game.trail.map((tile) => cellKey(tile.x, tile.y)));
  const pingsByTile = new Map();
  const uncollectedCores = new Map((game.cores || []).filter((core) => !core.collected).map((core) => [cellKey(core.x, core.y), core]));
  const coresRemaining = uncollectedCores.size;
  game.pings.forEach((ping) => {
    const key = cellKey(ping.x, ping.y);
    if (!pingsByTile.has(key)) pingsByTile.set(key, []);
    pingsByTile.get(key).push(ping);
  });

  for (let y = 0; y < game.board.rows; y += 1) {
    for (let x = 0; x < game.board.cols; x += 1) {
      const key = cellKey(x, y);
      const tile = document.createElement("button");
      tile.className = "tile";
      if (selected?.x === x && selected?.y === y) tile.classList.add("selected");
      if (isAdjacent(x, y)) tile.classList.add("adjacent");
      if (trail.has(key)) tile.classList.add("trail");
      if (game.goal.x === x && game.goal.y === y) tile.classList.add("goal");
      tile.setAttribute("aria-label", `Tile ${String.fromCharCode(65 + x)}${y + 1}`);
      tile.onclick = () => selectTile(x, y);

      const hazard = hazards.get(key);
      if (hazard) {
        const meta = HAZARDS[hazard.type];
        const icon = document.createElement("span");
        icon.className = `tile-icon hazard-icon ${hazard.private ? "private" : "revealed"}`;
        icon.style.color = meta.color;
        icon.style.background = `${meta.color}18`;
        icon.textContent = meta.icon;
        icon.title = hazard.private ? `${meta.label} — only your screen reveals this` : `${meta.label} — revealed to everyone`;
        tile.append(icon);
      }
      if (uncollectedCores.has(key)) {
        const core = document.createElement("span"); core.className = "tile-icon core-pickup"; core.textContent = "◆"; core.title = "Signal core — collect this before escaping"; tile.append(core);
      }
      if (game.goal.x === x && game.goal.y === y) {
        const goal = document.createElement("span"); goal.className = `tile-icon goal-beacon ${coresRemaining ? "locked" : ""}`; goal.textContent = coresRemaining ? "◉" : "◎"; tile.append(goal);
        if (coresRemaining) { const label = document.createElement("span"); label.className = "goal-lock-label"; label.textContent = `${coresRemaining} core${coresRemaining === 1 ? "" : "s"} needed`; tile.append(label); }
      }
      if (game.robot.x === x && game.robot.y === y) {
        const robot = document.createElement("span"); robot.className = "tile-icon robot"; robot.textContent = "⌁"; tile.append(robot);
      }
      const tilePings = pingsByTile.get(key) || [];
      if (tilePings.length) {
        const group = document.createElement("span"); group.className = "tile-pings";
        tilePings.slice(-3).forEach((ping) => {
          const marker = document.createElement("span"); marker.className = "tile-ping"; marker.style.background = ping.color; marker.textContent = "!"; marker.title = `${ping.playerName} warns this tile is dangerous`; group.append(marker);
        });
        tile.append(group);
      }
      const coordinate = document.createElement("span"); coordinate.className = "tile-coordinate"; coordinate.textContent = `${String.fromCharCode(65 + x)}${y + 1}`; tile.append(coordinate);
      board.append(tile);
    }
  }
  updateSelectionBar();
}

function selectTile(x, y) {
  selected = { x, y };
  renderBoard();
  beep(470, .035, "sine", .025);
}

function updateSelectionBar() {
  const hasSelection = Boolean(selected);
  const selectedGoalLocked = hasSelection && selected.x === game.goal.x && selected.y === game.goal.y && (game.cores || []).some((core) => !core.collected);
  $("#selectedTileText").textContent = hasSelection
    ? `${String.fromCharCode(65 + selected.x)}${selected.y + 1}${isAdjacent(selected.x, selected.y) ? " • adjacent" : ""}${selectedGoalLocked ? " • exit locked" : ""}`
    : (game.soloMode && game.soloStage === "look" ? "Study the danger symbols" : "Tap any tile");
  const soloLooking = game.soloMode && game.soloStage === "look";
  const soloMoving = game.soloMode && game.soloStage === "move";
  $("#readyButton").classList.toggle("hidden", !soloLooking);
  $("#pingButton").classList.toggle("hidden", soloLooking);
  $("#moveButton").classList.toggle("hidden", soloLooking);
  $("#pingButton").textContent = game.soloMode ? `! Memory mark (${game.soloPingsLeft})` : "! Ping danger";
  $("#pingButton").disabled = !hasSelection || game.phase !== "playing" || (game.soloMode && (!soloMoving || game.soloPingsLeft <= 0));
  $("#moveButton").disabled = !hasSelection || game.phase !== "playing" || game.captainId !== meId || !isAdjacent(selected.x, selected.y) || selectedGoalLocked || (game.soloMode && !soloMoving);
}

function renderSignals() {
  const feed = $("#signalFeed");
  feed.replaceChildren();
  const recent = [...game.pings].sort((a, b) => b.at - a.at).slice(0, 10);
  if (!recent.length) {
    const empty = document.createElement("p"); empty.className = "signal-empty"; empty.textContent = game.soloMode ? "After dangers hide, mark up to two tiles you want to remember." : "No warnings yet. Tap a hazard you can see and ping it for the team."; feed.append(empty); return;
  }
  recent.forEach((ping) => {
    const item = document.createElement("div"); item.className = "signal-item";
    const avatar = document.createElement("span"); avatar.className = "signal-avatar"; avatar.style.background = ping.color; avatar.textContent = "!";
    const text = document.createElement("div");
    const name = document.createElement("b"); name.textContent = ping.playerName;
    const message = document.createElement("small"); message.textContent = `${ping.bot ? "scanned" : "pinged"} ${String.fromCharCode(65 + ping.x)}${ping.y + 1}`;
    text.append(name, message); item.append(avatar, text); feed.append(item);
  });
}

function renderScouts() {
  const strip = $("#scoutDots"); strip.replaceChildren();
  game.players.forEach((player) => {
    const dot = document.createElement("span"); dot.className = `scout-dot ${player.id === game.captainId ? "captain" : ""}`; dot.style.background = player.color; dot.textContent = avatarText(player.avatar); dot.title = `${player.name}${player.id === game.captainId ? " — navigator" : ""}`; strip.append(dot);
  });
}

function updateTurnUI() {
  if (!game) return;
  const banner = $("#turnBanner");
  banner.classList.remove("look-phase", "move-phase");
  if (game.soloMode) {
    const looking = game.soloStage === "look";
    banner.classList.toggle("your-turn", !looking);
    banner.classList.add(looking ? "look-phase" : "move-phase");
    $("#turnKicker").textContent = looking ? (game.soloPractice ? "PRACTICE — TAKE YOUR TIME" : "LOOK — DANGERS VISIBLE") : (game.soloPractice ? "PRACTICE MOVE — NO TIMER" : "DANGERS HIDDEN");
    $("#turnText").textContent = looking ? "Remember the danger tiles, then press Ready" : "MOVE: choose one glowing adjacent tile from memory";
    $("#turnDot").style.background = looking ? "#ffd166" : "#aa82ff";
    updateSelectionBar(); return;
  }
  const captain = game.players.find((player) => player.id === game.captainId);
  const isMe = game.captainId === meId;
  $("#turnBanner").classList.toggle("your-turn", isMe);
  $("#turnKicker").textContent = isMe ? "YOU ARE THE NAVIGATOR" : "CURRENT NAVIGATOR";
  $("#turnText").textContent = isMe ? "Choose one glowing adjacent tile" : `${captain?.name || "A scout"} is choosing the next step`;
  $("#turnDot").style.background = captain?.color || "#ffd166";
  updateSelectionBar();
}

function detectGameEvent(nextGame) {
  const event = nextGame.lastEvent;
  if (!event?.id || event.id === lastEventId) return;
  lastEventId = event.id;
  if (event.type === "hazard") { eventToast(`${event.icon} ${event.hazardLabel}! Signal core damaged.`, true); beep(130, .32, "sawtooth", .12); }
  else if (event.type === "core") { eventToast("◆ Signal core collected!", false); beep(820, .22, "triangle", .09); }
  else if (event.type === "hide") { eventToast(event.practice ? "Dangers hidden — make your practice move." : "Dangers hidden — move from memory."); beep(300, .1, "triangle", .04); }
  else if (event.type === "safe") { beep(680, .07, "triangle", .045); }
  else if (event.type === "timeout") { eventToast("Navigator timed out — control rotated.", true); beep(220, .15, "square", .05); }
  else if (event.type === "win") { beep(760, .35, "triangle", .1); }
  else if (event.type === "loss") { beep(110, .45, "sawtooth", .1); }
}

function renderResults(isHost) {
  const outcome = room.outcome || game?.outcome || { won: false, score: 0, stars: 0, reason: "Mission ended." };
  $("#resultIcon").textContent = outcome.won ? "◎" : "×";
  $("#resultIcon").style.borderColor = outcome.won ? "#67d391" : "#ff5d8f";
  $("#resultIcon").style.color = outcome.won ? "#67d391" : "#ff5d8f";
  $("#resultKicker").textContent = outcome.won ? "MISSION COMPLETE" : "SIGNAL LOST";
  $("#resultTitle").textContent = outcome.won ? "The Pals found the safe path." : "The peril won this round.";
  $("#resultReason").textContent = outcome.reason || "";
  $("#stars").textContent = `${"★ ".repeat(outcome.stars || 0)}${"☆ ".repeat(3 - (outcome.stars || 0))}`.trim();
  $("#scoreValue").textContent = Number(outcome.score || 0).toLocaleString();
  const board = $("#scoreboard"); board.replaceChildren();
  [...room.players].sort((a, b) => b.stats.pings - a.stats.pings).forEach((player) => {
    const row = document.createElement("div"); row.className = "score-row";
    const avatar = document.createElement("span"); avatar.className = "score-row-avatar"; avatar.style.background = player.color; avatar.textContent = avatarText(player.avatar);
    const name = document.createElement("b"); name.textContent = player.name;
    const pings = document.createElement("span"); pings.className = "score-stat"; pings.textContent = `${player.stats.pings} pings`;
    const moves = document.createElement("span"); moves.className = "score-stat"; moves.textContent = `${player.stats.moves} moves`;
    row.append(avatar, name, pings, moves); board.append(row);
  });
  $("#playAgainButton").classList.toggle("hidden", !isHost);
  $("#resultsWaiting").classList.toggle("hidden", isHost);
}

function updateTimers() {
  if (!game || currentScreen !== "game") return;
  const now = serverNow();
  const gameSeconds = game.gameEndsAt ? Math.max(0, Math.ceil((game.gameEndsAt - now) / 1000)) : 0;
  $("#missionTimer").textContent = game.soloMode && !game.gameEndsAt ? "PRACTICE" : `${Math.floor(gameSeconds / 60)}:${String(gameSeconds % 60).padStart(2, "0")}`;
  $("#livesDisplay").textContent = `${"● ".repeat(game.lives)}${"○ ".repeat(3 - game.lives)}`.trim();
  const coresFound = (game.cores || []).filter((core) => core.collected).length;
  $("#coresDisplay").textContent = `${coresFound} / ${(game.cores || []).length || 3}`;
  const phaseDeadline = game.soloMode && game.soloStage === "look" ? game.phaseEndsAt : game.turnEndsAt;
  const turnSeconds = phaseDeadline ? Math.max(0, Math.ceil((phaseDeadline - now) / 1000)) : 0;
  $("#turnTimer").textContent = phaseDeadline ? turnSeconds : "∞";
  if (game.phase === "countdown") {
    const number = Math.max(1, Math.ceil((game.phaseEndsAt - now) / 1000));
    $("#countdownNumber").textContent = number;
    $("#countdownMessage").textContent = "First: LOOK at the dangers. Then they disappear.";
    $("#countdownOverlay").classList.remove("hidden");
    if (number !== lastCountdown) { beep(320 + (4 - number) * 100, .07, "square", .04); lastCountdown = number; }
  } else { $("#countdownOverlay").classList.add("hidden"); lastCountdown = null; }
}

function leaveRoom() { socket.emit("leave-room"); clearSession(); showScreen("home"); }
function copyInvite() {
  const link = `${location.origin}${location.pathname}?room=${room.code}`;
  navigator.clipboard?.writeText(link).then(() => toast("Invite link copied"), () => toast(`Mission code: ${room.code}`));
}

socket.on("room-state", updateRoom);
socket.on("game-state", (nextGame) => {
  clockOffset = Date.now() - nextGame.serverNow;
  detectGameEvent(nextGame);
  game = nextGame;
  if (room) { room.phase = nextGame.phase; room.outcome = nextGame.outcome; room.players = nextGame.players; }
  if (["countdown", "playing"].includes(nextGame.phase)) { showScreen("game"); renderGame(); }
  else if (nextGame.phase === "results") { showScreen("results"); renderResults(room?.hostId === meId); }
});
socket.on("connect", () => {
  const saved = JSON.parse(localStorage.getItem("peril-pals-session") || "null");
  if (!saved) return;
  socket.emit("resume-room", saved, (result) => { if (result.ok) saveSession(result); else clearSession(); });
});

$("#createButton").onclick = createRoom;
$("#joinButton").onclick = joinRoom;
$("#playerName").addEventListener("keydown", (event) => { if (event.key === "Enter") createRoom(); });
$("#roomCodeInput").addEventListener("input", (event) => event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""));
$("#roomCodeInput").addEventListener("keydown", (event) => { if (event.key === "Enter") joinRoom(); });
$("#leaveButton").onclick = leaveRoom;
$("#resultsLeaveButton").onclick = leaveRoom;
$("#copyCodeButton").onclick = copyInvite;
$("#addBotButton").onclick = () => socket.emit("add-bot", (result) => { if (!result.ok && result.error) toast(result.error); });
$("#startButton").onclick = () => socket.emit("start-game", (result) => { if (!result.ok) toast(result.error); });
$("#playAgainButton").onclick = () => socket.emit("start-game", (result) => { if (!result.ok) toast(result.error); });
$("#readyButton").onclick = () => socket.emit("finish-solo-look", (result) => { if (!result.ok) toast("Wait for the LOOK phase."); });
$("#pingButton").onclick = () => {
  if (!selected) return;
  const tile = { ...selected };
  socket.emit("ping-tile", tile, (result) => {
    if (result.ok) { beep(520, .06, "square", .04); toast(`${game.soloMode ? "Memory marked" : "Warning sent for"} ${String.fromCharCode(65 + tile.x)}${tile.y + 1}`); }
    else if (result.error) toast(result.error);
  });
};
$("#moveButton").onclick = () => {
  if (!selected) return;
  socket.emit("move-robot", selected, (result) => { if (!result.ok) toast(result.error || "Move rejected."); else selected = null; });
};
$("#soundButton").onclick = () => { soundOn = !soundOn; localStorage.setItem("peril-pals-sound", soundOn ? "on" : "off"); $("#soundButton").textContent = soundOn ? "♪" : "×"; if (soundOn) beep(); };

const howDialog = $("#howDialog");
$("#howButton").onclick = () => howDialog.showModal();
$("#closeHowButton").onclick = () => howDialog.close();
$("#gotItButton").onclick = () => howDialog.close();

$("#playerName").value = localStorage.getItem("peril-pals-name") || "";
const queryRoom = new URLSearchParams(location.search).get("room");
if (queryRoom) $("#roomCodeInput").value = queryRoom.toUpperCase().slice(0, 4);
$("#soundButton").textContent = soundOn ? "♪" : "×";
setInterval(updateTimers, 100);
