'use strict';
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const Engine = require('./public/engine.js');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/healthz', (req, res) => res.json({ ok: true, rooms: rooms.size }));

/* ---------------- rooms (in-memory) ---------------- */
const rooms = new Map();
const CODE_LETTERS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no confusing I/O/0/1/L
let nextPublicId = 1;

function newCode() {
  let code;
  do {
    code = Array.from({ length: 5 }, () => CODE_LETTERS[Math.floor(Math.random() * CODE_LETTERS.length)]).join('');
  } while (rooms.has(code));
  return code;
}
function cleanName(name, fallback) {
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 24);
  return n || fallback;
}
function getRoom(code) {
  return rooms.get(String(code || '').trim().toUpperCase());
}

function createRoom(hostClientKey, hostName) {
  const code = newCode();
  const room = {
    code,
    hostClientKey,
    players: new Map(), // clientKey -> {publicId, name, seat:0|1|2|null, connected, socketId}
    game: null,          // engine state or null in lobby
    chat: [],
    proposal: null,      // {id, type:'draw'|'resign', from, winner, accepts:{color:bool}, need:[colors]}
    proposalSeq: 0,
    lastActive: Date.now()
  };
  rooms.set(code, room);
  return room;
}

function addOrUpdatePlayer(room, clientKey, name, socketId) {
  let p = room.players.get(clientKey);
  if (!p) {
    p = { publicId: 'p' + (nextPublicId++), name: cleanName(name, 'Игрок'), seat: null, connected: true, socketId };
    room.players.set(clientKey, p);
    // first free seat goes to newcomers while the game has not started / a seat is empty
    const taken = new Set([...room.players.values()].map(x => x.seat));
    for (let s = 0; s < 3; s++) if (!taken.has(s)) { p.seat = s; break; }
  } else {
    p.name = cleanName(name, p.name);
    p.connected = true;
    p.socketId = socketId;
  }
  return p;
}

function seatOwner(room, seat) {
  for (const [key, p] of room.players) if (p.seat === seat) return { key, p };
  return null;
}

function snapshot(room) {
  return {
    code: room.code,
    hostPublicId: (room.players.get(room.hostClientKey) || {}).publicId || null,
    players: [...room.players.values()].map(p => ({
      publicId: p.publicId, name: p.name, seat: p.seat, connected: p.connected
    })),
    game: room.game,
    chat: room.chat.slice(-80),
    proposal: room.proposal ? {
      id: room.proposal.id, type: room.proposal.type,
      from: room.proposal.from, winner: room.proposal.winner,
      need: room.proposal.need, accepts: room.proposal.accepts
    } : null
  };
}

function broadcast(room) {
  room.lastActive = Date.now();
  io.to('room:' + room.code).emit('room:update', snapshot(room));
}
function sysChat(room, text) {
  room.chat.push({ id: Date.now() + Math.random(), name: '♞', seat: null, text, sys: true });
}

function canMoveColor(room, clientKey, color) {
  const me = room.players.get(clientKey);
  if (!me) return false;
  const owner = seatOwner(room, color);
  if (!owner) return true;                 // empty seat: anyone in the room may move it
  if (owner.key === clientKey) return true;
  if (!owner.p.connected) return true;     // seat owner offline: friends can keep the game going
  return false;
}

io.on('connection', (socket) => {
  let myRoomCode = null;
  let myClientKey = null;

  function joinRoom(room, clientKey, name) {
    myRoomCode = room.code;
    myClientKey = clientKey;
    socket.join('room:' + room.code);
    const p = addOrUpdatePlayer(room, clientKey, name, socket.id);
    socket.emit('room:self', { publicId: p.publicId, code: room.code });
    broadcast(room);
    return p;
  }

  socket.on('room:create', ({ name, clientKey } = {}, cb) => {
    try {
      if (!clientKey) throw new Error('Нет идентификатора клиента');
      const room = createRoom(String(clientKey), name);
      joinRoom(room, String(clientKey), name);
      sysChat(room, `${cleanName(name, 'Игрок')} создал комнату ${room.code}`);
      broadcast(room);
      cb && cb({ ok: true, code: room.code });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  socket.on('room:join', ({ code, name, clientKey } = {}, cb) => {
    try {
      if (!clientKey) throw new Error('Нет идентификатора клиента');
      const room = getRoom(code);
      if (!room) throw new Error('Комната не найдена — проверьте код');
      const existed = room.players.has(String(clientKey));
      joinRoom(room, String(clientKey), name);
      if (!existed) { sysChat(room, `${cleanName(name, 'Игрок')} присоединился`); broadcast(room); }
      cb && cb({ ok: true, code: room.code });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  socket.on('room:sit', ({ seat } = {}, cb) => {
    try {
      const room = getRoom(myRoomCode); if (!room) throw new Error('Вы не в комнате');
      const me = room.players.get(myClientKey); if (!me) throw new Error('Игрок не найден');
      if (seat === null || seat === undefined) { me.seat = null; }
      else {
        seat = Number(seat);
        if (![0, 1, 2].includes(seat)) throw new Error('Нет такого места');
        const owner = seatOwner(room, seat);
        if (owner && owner.key !== myClientKey) {
          if (owner.p.connected) throw new Error('Место занято');
          owner.p.seat = null; // take over an offline seat
        }
        me.seat = seat;
      }
      broadcast(room);
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  socket.on('room:start', (cb) => {
    try {
      const room = getRoom(myRoomCode); if (!room) throw new Error('Вы не в комнате');
      const me = room.players.get(myClientKey);
      const isHost = room.hostClientKey === myClientKey;
      if (room.game && room.game.status === 'playing' && !isHost) {
        throw new Error('Только хост может перезапустить партию по ходу игры');
      }
      if (!isHost && (!me || me.seat === null) && room.game && room.game.status === 'playing') {
        throw new Error('Нет прав');
      }
      room.game = Engine.createInitialState();
      room.proposal = null;
      sysChat(room, 'Новая партия! Ход: Белые → Красные → Чёрные.');
      broadcast(room);
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  socket.on('room:move', ({ from, to, promo } = {}, cb) => {
    try {
      const room = getRoom(myRoomCode); if (!room || !room.game) throw new Error('Партия не идёт');
      if (!canMoveColor(room, myClientKey, room.game.turn)) {
        throw new Error('Сейчас ходит другой игрок (' + Engine.COLORS[room.game.turn].name + ')');
      }
      room.game = Engine.applyMove(room.game, { from: Number(from), to: Number(to), promo: promo || null });
      room.proposal = null; // a move declines any pending proposal
      if (room.game.status === 'finished') {
        const r = room.game.result;
        sysChat(room, r.type === 'draw'
          ? `Ничья. ${r.reason} Счёт: ½–½–½`
          : `Победа: ${Engine.COLORS[r.winner].name}! ${r.reason} Счёт (Б–К–Ч): ${r.scores.map(x => x === 0.5 ? '½' : x).join('–')}`);
      }
      broadcast(room);
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: e.message, code: e.code || null }); }
  });

  socket.on('room:claimDraw', (cb) => {
    try {
      const room = getRoom(myRoomCode); if (!room || !room.game) throw new Error('Партия не идёт');
      if (!canMoveColor(room, myClientKey, room.game.turn)) throw new Error('Требовать ничью может ходящий игрок');
      room.game = Engine.claimRepetitionDraw(room.game, room.game.turn);
      room.proposal = null;
      sysChat(room, 'Ничья по троекратному повторению. Счёт: ½–½–½');
      broadcast(room);
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  socket.on('room:propose', ({ type, winner } = {}, cb) => {
    try {
      const room = getRoom(myRoomCode); if (!room || !room.game || room.game.status !== 'playing') throw new Error('Партия не идёт');
      const me = room.players.get(myClientKey);
      if (!me || me.seat === null) throw new Error('Предлагать могут только игроки за доской');
      if (room.proposal) throw new Error('Уже есть активное предложение');
      // only colours with a connected seated player can (and must) vote;
      // empty/offline seats do not block an agreement among those present
      const activeSeat = (c) => { const o = seatOwner(room, c); return !!(o && o.p.connected); };
      if (type === 'draw') {
        room.proposal = {
          id: ++room.proposalSeq, type: 'draw', from: me.seat, winner: null,
          need: [0, 1, 2].filter(c => c !== me.seat && activeSeat(c)), accepts: {}
        };
        sysChat(room, `${Engine.COLORS[me.seat].name} предлагают ничью`);
        if (room.proposal.need.length === 0) return finishProposal(room), cb && cb({ ok: true });
      } else if (type === 'resign') {
        winner = Number(winner);
        if (![0, 1, 2].includes(winner) || winner === me.seat) throw new Error('Укажите, в чью пользу сдаётесь');
        const third = [0, 1, 2].find(c => c !== me.seat && c !== winner);
        room.proposal = {
          id: ++room.proposalSeq, type: 'resign', from: me.seat, winner,
          need: activeSeat(third) ? [third] : [], accepts: {}
        };
        sysChat(room, `${Engine.COLORS[me.seat].name} хотят сдаться в пользу «${Engine.COLORS[winner].name}»`);
        if (room.proposal.need.length === 0) return finishProposal(room), cb && cb({ ok: true });
      } else throw new Error('Неизвестное предложение');
      broadcast(room);
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  function finishProposal(room) {
    const pr = room.proposal;
    room.proposal = null;
    if (!pr || !room.game) return broadcast(room);
    if (pr.type === 'draw') {
      Engine.finishDraw(room.game, 'Ничья по соглашению всех троих игроков.');
      sysChat(room, 'Ничья по соглашению. Счёт: ½–½–½');
    } else {
      Engine.finishWin(room.game, pr.winner, pr.from,
        Engine.COLORS[pr.from].name + ' сдались в пользу «' + Engine.COLORS[pr.winner].name + '» (третий игрок согласился).');
      sysChat(room, `Сдача принята. Победа: ${Engine.COLORS[pr.winner].name}.`);
    }
    broadcast(room);
  }

  socket.on('room:proposalRespond', ({ id, accept } = {}, cb) => {
    try {
      const room = getRoom(myRoomCode); if (!room || !room.proposal) throw new Error('Предложения нет');
      if (room.proposal.id !== Number(id)) throw new Error('Предложение устарело');
      const me = room.players.get(myClientKey);
      if (!me || me.seat === null || !room.proposal.need.includes(me.seat)) throw new Error('Ваш голос не требуется');
      if (!accept) {
        sysChat(room, `${Engine.COLORS[me.seat].name} отклонили предложение`);
        room.proposal = null;
        broadcast(room);
      } else {
        room.proposal.accepts[me.seat] = true;
        if (room.proposal.need.every(c => room.proposal.accepts[c])) finishProposal(room);
        else broadcast(room);
      }
      cb && cb({ ok: true });
    } catch (e) { cb && cb({ ok: false, error: e.message }); }
  });

  socket.on('room:cancelProposal', (cb) => {
    const room = getRoom(myRoomCode);
    if (room && room.proposal) {
      const me = room.players.get(myClientKey);
      if (me && me.seat === room.proposal.from) { room.proposal = null; broadcast(room); }
    }
    cb && cb({ ok: true });
  });

  socket.on('room:chat', ({ text } = {}) => {
    const room = getRoom(myRoomCode); if (!room) return;
    const me = room.players.get(myClientKey); if (!me) return;
    const t = String(text || '').trim().slice(0, 300);
    if (!t) return;
    room.chat.push({ id: Date.now() + Math.random(), name: me.name, seat: me.seat, text: t });
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = getRoom(myRoomCode);
    if (room) {
      const p = room.players.get(myClientKey);
      if (p && p.socketId === socket.id) { p.connected = false; broadcast(room); }
    }
  });
});

// drop long-idle empty rooms
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyoneConnected = [...room.players.values()].some(p => p.connected);
    if (!anyoneConnected && now - room.lastActive > 1000 * 60 * 60 * 6) rooms.delete(code);
  }
}, 1000 * 60 * 30).unref();

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Three Half Chess: http://localhost:${PORT}`);
});
