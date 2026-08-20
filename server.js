'use strict';

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const {
  defaultOptions, createGame, applyAction, publicState, COLORS, COLOR_NAMES,
} = require('./game');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));

/* ---------------- ルーム管理 ---------------- */
const rooms = new Map();          // code -> room
const sockets = new Map();        // socket.id -> {code, playerId}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let c;
  do {
    c = Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');
  } while (rooms.has(c));
  return c;
}

function roomView(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    opts: room.opts,
    started: !!room.game,
    players: room.players.map((p, i) => ({
      id: p.id, name: p.name, connected: p.connected,
      color: COLORS[i], colorName: COLOR_NAMES[i],
    })),
  };
}

function broadcast(room) {
  for (const [sid, info] of sockets) {
    if (info.code !== room.code) continue;
    const s = io.sockets.sockets.get(sid);
    if (!s) continue;
    s.emit('room', roomView(room));
    if (room.game) s.emit('state', publicState(room.game, info.playerId));
  }
}

function sendBoard(socket, room) {
  if (room.game) socket.emit('board', room.game.board);
}

function cleanupSoon(code) {
  const room = rooms.get(code);
  if (!room) return;
  if (room.players.every(p => !p.connected)) {
    setTimeout(() => {
      const r = rooms.get(code);
      if (r && r.players.every(p => !p.connected)) rooms.delete(code);
    }, 1000 * 60 * 60 * 3); // 全員切断から3時間で破棄
  }
}

/* ---------------- ソケット ---------------- */
io.on('connection', socket => {

  const err = m => socket.emit('errorMsg', m);

  socket.on('createRoom', ({ name, playerId, opts }) => {
    if (!name || !playerId) return err('名前が必要です');
    const code = newCode();
    const room = {
      code,
      hostId: playerId,
      opts: Object.assign(defaultOptions(), opts || {}),
      players: [{ id: playerId, name: String(name).slice(0, 14), connected: true }],
      game: null,
    };
    rooms.set(code, room);
    sockets.set(socket.id, { code, playerId });
    socket.join(code);
    socket.emit('joined', { code, playerId });
    broadcast(room);
  });

  socket.on('joinRoom', ({ code, name, playerId }) => {
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return err('その合言葉の部屋は見つかりません');
    let p = room.players.find(x => x.id === playerId);
    if (!p) {
      if (room.game) return err('このゲームはすでに進行中です');
      if (room.players.length >= room.opts.maxPlayers) return err('部屋が満員です');
      if (!name) return err('名前が必要です');
      p = { id: playerId, name: String(name).slice(0, 14), connected: true };
      room.players.push(p);
    }
    p.connected = true;
    if (name) p.name = String(name).slice(0, 14);
    if (room.game) {
      const gp = room.game.players.find(x => x.id === playerId);
      if (gp) { gp.connected = true; gp.name = p.name; }
    }
    sockets.set(socket.id, { code, playerId });
    socket.join(code);
    socket.emit('joined', { code, playerId });
    sendBoard(socket, room);
    broadcast(room);
  });

  socket.on('setOptions', ({ opts }) => {
    const info = sockets.get(socket.id); if (!info) return;
    const room = rooms.get(info.code); if (!room) return;
    if (room.hostId !== info.playerId) return err('設定を変更できるのは部屋主だけです');
    if (room.game) return err('ゲーム中は変更できません');
    const o = Object.assign({}, room.opts, opts || {});
    o.maxPlayers = Math.max(3, Math.min(6, Number(o.maxPlayers) || 4));
    o.victoryPoints = Math.max(8, Math.min(18, Number(o.victoryPoints) || 10));
    o.discardLimit = Math.max(5, Math.min(15, Number(o.discardLimit) || 7));
    if (o.maxPlayers > 4) o.bigBoard = true;
    if (room.players.length > o.maxPlayers) return err('現在の参加人数より少なくはできません');
    room.opts = o;
    broadcast(room);
  });

  socket.on('kick', ({ playerId }) => {
    const info = sockets.get(socket.id); if (!info) return;
    const room = rooms.get(info.code); if (!room) return;
    if (room.hostId !== info.playerId) return err('部屋主だけが操作できます');
    if (room.game) return err('ゲーム中は退出させられません');
    room.players = room.players.filter(p => p.id !== playerId);
    for (const [sid, i2] of sockets) {
      if (i2.code === room.code && i2.playerId === playerId) {
        io.sockets.sockets.get(sid)?.emit('kicked');
        sockets.delete(sid);
      }
    }
    broadcast(room);
  });

  socket.on('startGame', () => {
    const info = sockets.get(socket.id); if (!info) return;
    const room = rooms.get(info.code); if (!room) return;
    if (room.hostId !== info.playerId) return err('部屋主だけが開始できます');
    if (room.game) return err('すでに開始しています');
    if (room.players.length < 2) return err('2人以上必要です');
    room.opts.maxPlayers = Math.max(room.opts.maxPlayers, room.players.length);
    if (room.players.length > 4) room.opts.bigBoard = true;
    room.game = createGame(room.opts, room.players);
    for (const [sid, i2] of sockets) {
      if (i2.code !== room.code) continue;
      sendBoard(io.sockets.sockets.get(sid), room);
    }
    broadcast(room);
  });

  socket.on('newGame', () => {
    const info = sockets.get(socket.id); if (!info) return;
    const room = rooms.get(info.code); if (!room) return;
    if (room.hostId !== info.playerId) return err('部屋主だけが操作できます');
    room.game = null;
    broadcast(room);
  });

  socket.on('requestBoard', () => {
    const info = sockets.get(socket.id); if (!info) return;
    const room = rooms.get(info.code); if (!room) return;
    sendBoard(socket, room);
  });

  socket.on('action', action => {
    const info = sockets.get(socket.id); if (!info) return;
    const room = rooms.get(info.code); if (!room) return;
    if (!room.game) return err('ゲームが始まっていません');
    const r = applyAction(room.game, info.playerId, action || {});
    if (!r.ok) return err(r.error);
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const info = sockets.get(socket.id);
    sockets.delete(socket.id);
    if (!info) return;
    const room = rooms.get(info.code);
    if (!room) return;
    const stillOpen = [...sockets.values()].some(i => i.code === info.code && i.playerId === info.playerId);
    if (stillOpen) return;
    const p = room.players.find(x => x.id === info.playerId);
    if (p) p.connected = false;
    if (room.game) {
      const gp = room.game.players.find(x => x.id === info.playerId);
      if (gp) gp.connected = false;
    }
    if (!room.game && room.players.every(x => !x.connected)) rooms.delete(room.code);
    else { broadcast(room); cleanupSoon(room.code); }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  カタン風オンライン対戦  →  http://localhost:${PORT}\n`);
});
