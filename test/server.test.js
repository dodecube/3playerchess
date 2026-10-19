const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const { io } = require('socket.io-client');
const E = require('../public/engine.js');

const PORT = 3456;
const URL = `http://127.0.0.1:${PORT}`;

function emit(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout: ' + event)), 5000);
    const cb = (res) => { clearTimeout(timer); resolve(res); };
    if (payload === undefined) socket.emit(event, cb);
    else socket.emit(event, payload, cb);
  });
}
function connect() {
  return new Promise((resolve, reject) => {
    const s = io(URL, { transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve(s));
    s.on('connect_error', reject);
  });
}
// Keeps the latest room snapshot so tests can poll state instead of racing events.
function tracker(socket) {
  const state = { snap: null };
  socket.on('room:update', (d) => { state.snap = d; });
  state.wait = async (pred, what, timeout = 5000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      if (state.snap && pred(state.snap)) return state.snap;
      await new Promise(r => setTimeout(r, 20));
    }
    throw new Error('timeout waiting: ' + what);
  };
  return state;
}

test('online room: create, join x3, start, turn enforcement, move broadcast', async (t) => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: 'ignore'
  });
  t.after(() => server.kill());
  let s1;
  for (let i = 0; i < 50 && !s1; i++) {
    try { s1 = await connect(); } catch (e) { await new Promise(r => setTimeout(r, 100)); }
  }
  assert.ok(s1, 'server is up');
  const s2 = await connect();
  const s3 = await connect();
  t.after(() => { [s1, s2, s3].forEach(s => s && s.disconnect()); });
  const t1 = tracker(s1), t2 = tracker(s2), t3 = tracker(s3);

  const created = await emit(s1, 'room:create', { name: 'Аня', clientKey: 'client-1' });
  assert.equal(created.ok, true);
  const code = created.code;
  assert.equal((await emit(s2, 'room:join', { code, name: 'Борис', clientKey: 'client-2' })).ok, true);
  assert.equal((await emit(s3, 'room:join', { code, name: 'Вера', clientKey: 'client-3' })).ok, true);

  let snap = await t1.wait(d => d.players.length === 3, '3 players');
  assert.deepEqual(snap.players.map(p => p.seat).sort(), [0, 1, 2], 'first three players auto-seated');

  assert.equal((await emit(s1, 'room:start')).ok, true);
  snap = await t3.wait(d => d.game && d.game.ply === 0, 'game started');

  // Boris (red, second) tries to move first -> rejected (white to move)
  const badMove = await emit(s2, 'room:move', { from: E.sq(1, 4, 1), to: E.sq(1, 4, 2) });
  assert.equal(badMove.ok, false);

  // Аня (white) plays e2-e4 (double step)
  const good = await emit(s1, 'room:move', { from: E.sq(0, 4, 1), to: E.sq(0, 4, 3) });
  assert.equal(good.ok, true);
  snap = await t2.wait(d => d.game && d.game.ply === 1, 'move broadcast');
  assert.equal(snap.game.turn, 1, 'red to move after white');

  // Illegal move by the right player is rejected by the server engine
  const illegal = await emit(s2, 'room:move', { from: E.sq(1, 4, 0), to: E.sq(1, 4, 3) });
  assert.equal(illegal.ok, false);

  // Chat is broadcast
  s1.emit('room:chat', { text: 'всем привет!' });
  await t3.wait(d => d.chat.some(m => m.text === 'всем привет!'), 'chat message');

  // Draw proposal needs both other seated players
  assert.equal((await emit(s2, 'room:propose', { type: 'draw' })).ok, true);
  snap = await t1.wait(d => !!d.proposal, 'draw proposal');
  const pid = snap.proposal.id;
  await emit(s1, 'room:proposalRespond', { id: pid, accept: true });
  await t3.wait(d => !!d.proposal && !!d.proposal.accepts[0], 'first accept');
  await emit(s3, 'room:proposalRespond', { id: pid, accept: true });
  snap = await t1.wait(d => d.game.status === 'finished', 'draw finished');
  assert.equal(snap.game.result.type, 'draw');
  assert.deepEqual(snap.game.result.scores, [0.5, 0.5, 0.5]);
});
