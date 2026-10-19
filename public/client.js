'use strict';
/* global ThreeHalfChess, io */
const E = ThreeHalfChess;
const $ = (id) => document.getElementById(id);
const GLYPH = E.GLYPH;
const PIECE_NAME = { k: 'король', q: 'ферзь', r: 'ладья', b: 'слон', n: 'конь', p: 'пешка' };

/* ---------------- identity & socket ---------------- */
function uuid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}
let clientKey = localStorage.getItem('thc_clientKey');
if (!clientKey) { clientKey = uuid(); localStorage.setItem('thc_clientKey', clientKey); }
$('nameInput').value = localStorage.getItem('thc_name') || '';

// Works both at domain root and under a subpath like /chess/ (nginx proxy).
const basePath = location.pathname.endsWith('/')
  ? location.pathname.slice(0, -1)
  : location.pathname.replace(/\/[^/]*$/, '');
const socket = io({ autoConnect: true, path: basePath + '/socket.io/' });

/* ---------------- app state ---------------- */
let mode = null;                  // null | 'online' | 'local'
let room = null;                  // server snapshot (online)
let myPublicId = null;
let currentRoomCode = null;       // for reconnect re-join
let localGame = null;
let localNames = ['Белые', 'Красные', 'Чёрные'];

let selected = null;              // square id
let legalCacheKey = '';
let legalCache = [];
let viewMode = 'pair';            // 'pair' | 'strips'
let pairBottom = 0, pairTop = 1;
let lastSeenTurn = null;
let lastSeenPly = -1;
let toastTimer = null;

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 3600);
}

function getGame() {
  if (mode === 'local') return localGame;
  if (mode === 'online' && room) return room.game;
  return null;
}
function mySeat() {
  if (mode !== 'online' || !room || !myPublicId) return null;
  const me = room.players.find(p => p.publicId === myPublicId);
  return me ? me.seat : null;
}
function playerName(color) {
  if (mode === 'local') return localNames[color] || E.COLORS[color].name;
  if (mode === 'online' && room) {
    const p = room.players.find(x => x.seat === color);
    if (p) return p.name;
  }
  return E.COLORS[color].name;
}
function canControl(color) {
  if (mode === 'local') return true;
  if (mode !== 'online' || !room) return false;
  const owner = room.players.find(p => p.seat === color);
  if (!owner) return true;                       // empty seat
  if (owner.publicId === myPublicId) return true;
  return !owner.connected;                       // offline seat
}
function legalMovesCached(game) {
  if (!game || game.status !== 'playing') return [];
  const key = E.positionKey(game);
  if (key !== legalCacheKey) {
    legalCacheKey = key;
    legalCache = E.legalMoves(game, game.turn);
  }
  return legalCache;
}

/* ---------------- sound (tiny, optional) ---------------- */
let audioCtx = null;
function beep(kind) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const f = kind === 'capture' ? 220 : kind === 'check' ? 880 : kind === 'end' ? 520 : 440;
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.frequency.value = f; o.type = 'sine';
    g.gain.setValueAtTime(0.06, audioCtx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.16);
    o.connect(g).connect(audioCtx.destination);
    o.start(); o.stop(audioCtx.currentTime + 0.17);
  } catch (e) { /* sound is a bonus */ }
}

/* ---------------- generic choice modal ---------------- */
let modalResolve = null;
function showChoiceModal(title, options) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    $('modalTitle').textContent = title;
    const box = $('modalOptions');
    box.textContent = '';
    options.forEach(opt => {
      const b = document.createElement('button');
      if (opt.className) b.className = opt.className;
      if (opt.pieceColor !== undefined) {
        const s = document.createElement('span');
        s.className = 'piece pc' + opt.pieceColor;
        s.textContent = opt.label;
        b.appendChild(s);
      } else b.textContent = opt.label;
      b.addEventListener('click', () => closeModal(opt.value));
      box.appendChild(b);
    });
    $('modalOverlay').classList.remove('hidden');
  });
}
function closeModal(value) {
  $('modalOverlay').classList.add('hidden');
  if (modalResolve) { const r = modalResolve; modalResolve = null; r(value); }
}
$('modalCancel').addEventListener('click', () => closeModal(null));
$('modalOverlay').addEventListener('click', (e) => { if (e.target === $('modalOverlay')) closeModal(null); });

/* ---------------- board rendering ---------------- */
function applyAutoView(game) {
  if (!$('autoViewChk').checked) return;
  if (!game) return;
  const ms = mySeat();
  if (mode === 'online' && ms !== null) { pairBottom = ms; pairTop = (ms + 1) % 3; }
  else { pairBottom = game.turn; pairTop = (game.turn + 1) % 3; }
}

function cellEl(game, id, targets) {
  const p = E.parse(id);
  const piece = game.board[id];
  const cell = document.createElement('button');
  cell.className = 'cell ' + (((p.x + p.y) % 2 === 0) ? 'dark' : 'light');
  cell.dataset.sq = id;
  if (game.lastMove && (game.lastMove.from === id || game.lastMove.to === id)) cell.classList.add('lastmove');
  if (selected === id) cell.classList.add('selected');
  const mv = targets.get(id);
  if (mv) cell.classList.add(piece || mv.ep ? 'hint-capture' : 'hint-move');
  if (piece && piece.t === 'k' && game.checks && game.checks.includes(piece.c)) cell.classList.add('in-check');
  if (piece) {
    const span = document.createElement('span');
    span.className = 'piece pc' + piece.c;
    span.textContent = GLYPH[piece.t];
    cell.appendChild(span);
    cell.title = `${E.COLORS[piece.c].name}: ${PIECE_NAME[piece.t]} — ${E.coord(id)}`;
  } else cell.title = E.coord(id);
  if (p.y === 0) {
    const home = document.createElement('span');
    home.className = 'home-edge';
    home.textContent = E.COLORS[p.h].dot;
    home.title = 'Домашний край: ' + E.COLORS[p.h].name;
    cell.appendChild(home);
  }
  if ($('coordsChk').checked) {
    const c = document.createElement('span');
    c.className = 'coord';
    c.textContent = E.coord(id);
    cell.appendChild(c);
  }
  cell.addEventListener('click', () => onCell(id));
  return cell;
}

function boardSection(titleText, note, squareIds, game, targets) {
  const sec = document.createElement('div');
  sec.className = 'board-section';
  const title = document.createElement('div');
  title.className = 'board-title';
  const b = document.createElement('b');
  b.textContent = titleText; // player names are user input: never innerHTML
  title.appendChild(b);
  if (note) { const n = document.createElement('span'); n.textContent = note; title.appendChild(n); }
  sec.appendChild(title);
  const grid = document.createElement('div');
  grid.className = 'board-grid';
  squareIds.forEach(id => grid.appendChild(cellEl(game, id, targets)));
  sec.appendChild(grid);
  return sec;
}

function renderBoard(game) {
  const holder = $('boardHolder');
  holder.textContent = '';
  if (!game) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = mode === 'online'
      ? 'Партия ещё не началась: рассядьтесь по местам ⚪ 🔴 ⚫ и нажмите «Начать партию». Можно начать и со свободными местами — друзья сядут по ходу игры.'
      : '…';
    holder.appendChild(p);
    return;
  }
  const targets = new Map();
  if (selected !== null) {
    legalMovesCached(game).filter(m => m.from === selected).forEach(m => {
      if (!targets.has(m.to)) targets.set(m.to, m);
    });
  }
  const cName = c => `${E.COLORS[c].dot} ${playerName(c)}`;
  if (viewMode === 'strips') {
    [2, 1, 0].forEach(h => {
      const ids = [];
      for (let y = 3; y >= 0; y--) for (let x = 0; x < 8; x++) ids.push(E.sq(h, x, y));
      holder.appendChild(boardSection(
        `Половинка: ${cName(h)}`, 'дом (⚑-край с королём) — нижний ряд', ids, game, targets));
    });
  } else {
    const ids = [];
    for (let Y = 7; Y >= 0; Y--) for (let X = 0; X < 8; X++) ids.push(E.fromBoard(X, Y, pairBottom, pairTop));
    holder.appendChild(boardSection(
      `Собранная доска: ${cName(pairBottom)} снизу + ${cName(pairTop)} сверху`,
      'верхняя половинка повёрнута на 180°', ids, game, targets));
    const third = [0, 1, 2].find(c => c !== pairBottom && c !== pairTop);
    const ids3 = [];
    for (let y = 3; y >= 0; y--) for (let x = 0; x < 8; x++) ids3.push(E.sq(third, x, y));
    holder.appendChild(boardSection(
      `Третья половинка: ${cName(third)}`, 'стыкуется с любой из двух выше', ids3, game, targets));
  }
  document.querySelectorAll('.pair-btn').forEach(b => {
    const [a, bb] = b.dataset.pair.split(',').map(Number);
    b.classList.toggle('active', viewMode === 'pair' &&
      ((pairBottom === a && pairTop === bb) || (pairBottom === bb && pairTop === a)));
  });
  $('stripsBtn').classList.toggle('active', viewMode === 'strips');
}

/* ---------------- side panels ---------------- */
function fmtScore(x) { return x === 0.5 ? '½' : String(x); }

function renderStatus(game) {
  const banner = $('statusBanner');
  banner.className = 'status-banner';
  if (!game) {
    banner.textContent = mode === 'online'
      ? 'Лобби комнаты: пригласите друзей по ссылке и займите места.'
      : 'Начинаем…';
    return;
  }
  if (game.status === 'finished' && game.result) {
    banner.classList.add('finished');
    const r = game.result;
    const scores = r.scores.map((s, i) => `${E.COLORS[i].dot} ${fmtScore(s)}`).join(' · ');
    banner.textContent = r.type === 'draw'
      ? `🤝 Ничья. ${r.reason} Счёт: ${scores}`
      : `🏆 Победили «${playerName(r.winner)}»! Проиграли «${playerName(r.loser)}». ${r.reason} Счёт: ${scores}`;
    return;
  }
  const turnName = playerName(game.turn);
  const mine = canControl(game.turn);
  let text = `Круг ${game.round}. Ходят ${E.COLORS[game.turn].dot} ${turnName}${mine ? ' — ваш ход!' : ''}`;
  if (game.checks && game.checks.length) {
    banner.classList.add('check');
    text += ' · ⚠ Шах: ' + game.checks.map(c => playerName(c)).join(', ');
  }
  if (game.repetitionCount >= 3) text += ' · ↻ позиция повторилась трижды — ходящий может требовать ничью';
  banner.textContent = text;
}

function renderPlayers(game) {
  const list = $('playersList');
  list.textContent = '';
  for (let c = 0; c < 3; c++) {
    const row = document.createElement('div');
    row.className = 'seat-row' + (game && game.status === 'playing' && game.turn === c ? ' turn' : '');
    const dot = document.createElement('span'); dot.className = 'dot'; dot.textContent = E.COLORS[c].dot;
    row.appendChild(dot);
    const main = document.createElement('div'); main.className = 'seat-main';
    const nameEl = document.createElement('div'); nameEl.className = 'seat-name';
    const sub = document.createElement('div'); sub.className = 'seat-sub';
    const captures = document.createElement('div'); captures.className = 'seat-captures';

    let owner = null;
    if (mode === 'online' && room) owner = room.players.find(p => p.seat === c) || null;
    if (mode === 'local') {
      nameEl.textContent = localNames[c];
      sub.textContent = E.COLORS[c].name + ' · за этим экраном';
    } else if (owner) {
      nameEl.textContent = owner.name + (owner.publicId === myPublicId ? ' (вы)' : '');
      sub.textContent = E.COLORS[c].name + (owner.connected ? '' : ' · не в сети — место свободно для хода');
    } else {
      nameEl.textContent = E.COLORS[c].name;
      sub.textContent = 'свободное место — ход может сделать любой';
    }
    if (game) {
      const caps = game.captured.filter(x => x.by === c);
      if (caps.length) {
        captures.title = 'Взятые этим игроком фигуры';
        caps.forEach(cap => {
          const s = document.createElement('span');
          s.className = 'piece pc' + cap.c;
          s.textContent = GLYPH[cap.t];
          captures.appendChild(s);
        });
      }
    }
    main.appendChild(nameEl); main.appendChild(sub);
    if (captures.childNodes.length) main.appendChild(captures);
    row.appendChild(main);

    if (game && game.checks && game.checks.includes(c) && game.status === 'playing') {
      const b = document.createElement('span'); b.className = 'badge check-badge'; b.textContent = 'ШАХ'; row.appendChild(b);
    }
    if (game && game.status === 'finished' && game.result) {
      const b = document.createElement('span'); b.className = 'badge score';
      b.textContent = fmtScore(game.result.scores[c]) + ' очк.'; row.appendChild(b);
    } else if (mode === 'online' && owner && !owner.connected) {
      const b = document.createElement('span'); b.className = 'badge offline'; b.textContent = 'offline'; row.appendChild(b);
    }

    if (mode === 'online') {
      const ms = mySeat();
      let btn = document.createElement('button');
      if (ms === c) { btn.textContent = 'Встать'; btn.addEventListener('click', () => sit(null)); }
      else if (!owner || !owner.connected) { btn.textContent = 'Сесть'; btn.addEventListener('click', () => sit(c)); }
      else btn = null;
      if (btn) row.appendChild(btn);
    }
    list.appendChild(row);
  }
  const spec = $('spectators');
  if (mode === 'online' && room) {
    const watchers = room.players.filter(p => p.seat === null);
    spec.textContent = watchers.length
      ? 'Зрители: ' + watchers.map(p => p.name + (p.connected ? '' : ' (offline)')).join(', ')
      : '';
  } else spec.textContent = '';
}

function renderHistory(game) {
  const box = $('history');
  box.textContent = '';
  if (!game || !game.history.length) {
    const p = document.createElement('p'); p.className = 'hint';
    p.textContent = 'Ходов пока нет.'; box.appendChild(p); return;
  }
  const table = document.createElement('table');
  for (let i = 0; i < game.history.length; i += 3) {
    const tr = document.createElement('tr');
    const num = document.createElement('td'); num.className = 'roundnum'; num.textContent = (i / 3 + 1) + '.';
    tr.appendChild(num);
    for (let j = 0; j < 3; j++) {
      const td = document.createElement('td');
      td.textContent = game.history[i + j] || '';
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  box.appendChild(table);
  box.scrollTop = box.scrollHeight;
}

function renderChat() {
  const box = $('chat');
  box.textContent = '';
  if (mode !== 'online' || !room) return;
  room.chat.forEach(m => {
    const div = document.createElement('div');
    div.className = 'chat-msg' + (m.sys ? ' sys' : '');
    const b = document.createElement('b');
    b.textContent = (m.seat !== null && m.seat !== undefined ? E.COLORS[m.seat].dot + ' ' : '') + m.name + ':';
    div.appendChild(b);
    div.appendChild(document.createTextNode(m.text));
    box.appendChild(div);
  });
  box.scrollTop = box.scrollHeight;
}

function renderProposal() {
  const box = $('proposalBox');
  box.textContent = '';
  box.classList.add('hidden');
  if (mode !== 'online' || !room || !room.proposal) return;
  const pr = room.proposal;
  box.classList.remove('hidden');
  const text = document.createElement('div');
  text.textContent = pr.type === 'draw'
    ? `🤝 «${playerName(pr.from)}» предлагают ничью. Нужно согласие: ${pr.need.map(c => playerName(c) + (pr.accepts[c] ? ' ✓' : '')).join(', ')}.`
    : `🏳 «${playerName(pr.from)}» хотят сдаться в пользу «${playerName(pr.winner)}». Согласие третьего игрока: ${pr.need.map(c => playerName(c) + (pr.accepts[c] ? ' ✓' : '')).join(', ') || 'не требуется'}.`;
  box.appendChild(text);
  const row = document.createElement('div'); row.className = 'action-row';
  const ms = mySeat();
  if (ms !== null && pr.need.includes(ms) && !pr.accepts[ms]) {
    const yes = document.createElement('button'); yes.className = 'primary'; yes.textContent = 'Согласиться';
    yes.addEventListener('click', () => respondProposal(pr.id, true));
    const no = document.createElement('button'); no.textContent = 'Отклонить';
    no.addEventListener('click', () => respondProposal(pr.id, false));
    row.appendChild(yes); row.appendChild(no);
  }
  if (ms === pr.from) {
    const cancel = document.createElement('button'); cancel.textContent = 'Отозвать предложение';
    cancel.addEventListener('click', () => socket.emit('room:cancelProposal', () => {}));
    row.appendChild(cancel);
  }
  if (row.childNodes.length) box.appendChild(row);
}

function renderActions(game) {
  const playing = game && game.status === 'playing';
  const finished = game && game.status === 'finished';
  const startBtn = $('startBtn');
  startBtn.textContent = !game ? '▶ Начать партию' : finished ? '↻ Новая партия' : '↻ Перезапустить партию';
  if (mode === 'online' && room) {
    const isHost = room.hostPublicId === myPublicId;
    startBtn.disabled = playing && !isHost;
    startBtn.title = playing && !isHost ? 'Перезапустить по ходу партии может только хост' : '';
  } else startBtn.disabled = false;
  $('drawBtn').disabled = !playing || (mode === 'online' && mySeat() === null);
  $('resignBtn').disabled = !playing || (mode === 'online' && mySeat() === null);
  const canClaim = playing && game.repetitionCount >= 3 && canControl(game.turn);
  $('claimBtn').classList.toggle('hidden', !canClaim);
  $('actionHint').textContent =
    mode === 'online' && mySeat() === null && playing
      ? 'Вы зритель: предложения делают игроки за доской, но за свободный цвет ходить можно.'
      : playing ? 'Ничья онлайн — по согласию всех троих; сдача — в пользу выбранного игрока с согласия третьего.'
      : '';
  // room card header
  if (mode === 'online' && room) {
    $('roomLabel').textContent = 'Комната (код для друзей)';
    $('roomCode').textContent = room.code;
    $('copyLinkBtn').classList.remove('hidden');
  } else {
    $('roomLabel').textContent = 'Режим';
    $('roomCode').textContent = '1 экран';
    $('copyLinkBtn').classList.add('hidden');
  }
  $('chatCard').classList.toggle('hidden', mode !== 'online');
}

function render() {
  const game = getGame();
  $('homeView').classList.toggle('hidden', mode !== null);
  $('gameView').classList.toggle('hidden', mode === null);
  if (mode === null) return;
  if (game && game.turn !== lastSeenTurn) {
    lastSeenTurn = game.turn;
    selected = null;
    applyAutoView(game);
  }
  if (game && game.ply !== lastSeenPly) {
    if (lastSeenPly >= 0 && game.ply > lastSeenPly) {
      const last = game.history[game.history.length - 1] || '';
      beep(game.status === 'finished' ? 'end' : last.includes('×') ? 'capture' : last.includes('+') ? 'check' : 'move');
    }
    lastSeenPly = game.ply;
  }
  renderStatus(game);
  renderBoard(game);
  renderPlayers(game);
  renderHistory(game);
  renderChat();
  renderProposal();
  renderActions(game);
}

/* ---------------- move interaction ---------------- */
async function onCell(id) {
  const game = getGame();
  if (!game || game.status !== 'playing') return;
  const piece = game.board[id];
  if (selected !== null) {
    const opts = legalMovesCached(game).filter(m => m.from === selected && m.to === id);
    if (opts.length) {
      let promo = null;
      const promos = opts.filter(m => m.promo);
      if (promos.length) {
        const moverColor = game.board[selected].c;
        promo = await showChoiceModal('Превратить пешку в…', promos.map(m => ({
          label: GLYPH[m.promo], value: m.promo, className: 'promo', pieceColor: moverColor
        })));
        if (!promo) return;
      }
      doMove(selected, id, promo);
      return;
    }
  }
  if (piece && piece.c === game.turn) {
    if (!canControl(game.turn)) {
      toast(`Сейчас ходят «${playerName(game.turn)}» — это не ваше место за доской.`);
      selected = null;
    } else selected = (selected === id ? null : id);
  } else selected = null;
  renderBoard(game);
}

function doMove(from, to, promo) {
  selected = null;
  if (mode === 'local') {
    try { localGame = E.applyMove(localGame, { from, to, promo }); }
    catch (e) { toast(e.message); }
    render();
  } else {
    socket.emit('room:move', { from, to, promo }, (res) => {
      if (res && !res.ok) toast(res.error || 'Ход отклонён');
    });
    renderBoard(getGame());
  }
}

/* ---------------- online actions ---------------- */
function emitAck(event, payload) {
  return new Promise((resolve) => {
    if (payload === undefined) socket.emit(event, resolve);
    else socket.emit(event, payload, resolve);
  });
}
async function sit(seat) {
  const res = await emitAck('room:sit', { seat });
  if (res && !res.ok) toast(res.error);
}
async function respondProposal(id, accept) {
  const res = await emitAck('room:proposalRespond', { id, accept });
  if (res && !res.ok) toast(res.error);
}
function savedName() {
  const n = $('nameInput').value.trim().slice(0, 24) || 'Игрок-' + Math.floor(100 + Math.random() * 900);
  $('nameInput').value = n;
  localStorage.setItem('thc_name', n);
  return n;
}

$('createBtn').addEventListener('click', async () => {
  const name = savedName();
  if (!socket.connected) socket.connect();
  const res = await emitAck('room:create', { name, clientKey });
  if (res && res.ok) {
    mode = 'online'; currentRoomCode = res.code;
    history.replaceState(null, '', '?room=' + res.code);
    selected = null; lastSeenTurn = null; lastSeenPly = -1;
    render();
    toast('Комната создана! Отправьте друзьям ссылку (кнопка «Ссылка друзьям»).');
  } else toast((res && res.error) || 'Не удалось создать комнату');
});

async function joinByCode(code) {
  const name = savedName();
  code = String(code || '').trim().toUpperCase();
  if (!code) return toast('Введите код комнаты');
  if (!socket.connected) socket.connect();
  const res = await emitAck('room:join', { code, name, clientKey });
  if (res && res.ok) {
    mode = 'online'; currentRoomCode = res.code;
    history.replaceState(null, '', '?room=' + res.code);
    selected = null; lastSeenTurn = null; lastSeenPly = -1;
    render();
  } else toast((res && res.error) || 'Не удалось войти в комнату');
}
$('joinBtn').addEventListener('click', () => joinByCode($('joinCodeInput').value));
$('joinCodeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinByCode(e.target.value); });

$('localBtn').addEventListener('click', () => {
  localNames = [0, 1, 2].map(i => $('localName' + i).value.trim().slice(0, 24) || E.COLORS[i].name);
  localGame = E.createInitialState();
  mode = 'local';
  selected = null; lastSeenTurn = null; lastSeenPly = -1;
  history.replaceState(null, '', location.pathname);
  render();
});

$('leaveBtn').addEventListener('click', () => {
  if (mode === 'online') { socket.disconnect(); }
  mode = null; room = null; myPublicId = null; currentRoomCode = null; localGame = null;
  selected = null; lastSeenTurn = null; lastSeenPly = -1;
  history.replaceState(null, '', location.pathname);
  render();
});

$('copyLinkBtn').addEventListener('click', async () => {
  if (!room) return;
  const url = location.origin + location.pathname + '?room=' + room.code;
  try { await navigator.clipboard.writeText(url); toast('Ссылка скопирована: ' + url); }
  catch (e) { window.prompt('Скопируйте ссылку-приглашение:', url); }
});

$('startBtn').addEventListener('click', async () => {
  const game = getGame();
  if (game && game.status === 'playing') {
    const ok = await showChoiceModal('Перезапустить партию с самого начала?', [
      { label: 'Да, начать заново', value: true }
    ]);
    if (!ok) return;
  }
  selected = null; lastSeenTurn = null; lastSeenPly = -1;
  if (mode === 'local') { localGame = E.createInitialState(); render(); return; }
  const res = await emitAck('room:start');
  if (res && !res.ok) toast(res.error);
});

$('drawBtn').addEventListener('click', async () => {
  if (mode === 'local') {
    const ok = await showChoiceModal('Ничья по соглашению — все трое согласны?', [
      { label: 'Да, ничья (½–½–½)', value: true }
    ]);
    if (!ok) return;
    localGame = E.clone(localGame);
    E.finishDraw(localGame, 'Ничья по соглашению всех троих игроков.');
    render();
    return;
  }
  const res = await emitAck('room:propose', { type: 'draw' });
  if (res && !res.ok) toast(res.error);
  else toast('Предложение ничьей отправлено соперникам');
});

$('resignBtn').addEventListener('click', async () => {
  if (mode === 'local') {
    const options = [];
    for (let loser = 0; loser < 3; loser++) for (let winner = 0; winner < 3; winner++) {
      if (winner === loser) continue;
      options.push({
        label: `${E.COLORS[loser].dot} ${localNames[loser]} сдаётся в пользу ${E.COLORS[winner].dot} ${localNames[winner]}`,
        value: loser + ':' + winner
      });
    }
    const pick = await showChoiceModal('Кто сдаётся и в чью пользу? (третий игрок рядом и согласен)', options);
    if (!pick) return;
    const [loser, winner] = pick.split(':').map(Number);
    localGame = E.clone(localGame);
    E.finishWin(localGame, winner, loser,
      `«${localNames[loser]}» сдались в пользу «${localNames[winner]}» (третий игрок согласился).`);
    render();
    return;
  }
  const ms = mySeat();
  if (ms === null) return toast('Сдаться может игрок за доской');
  const others = [0, 1, 2].filter(c => c !== ms);
  const winner = await showChoiceModal('В чью пользу вы сдаётесь? Третий игрок должен согласиться.',
    others.map(c => ({ label: `${E.COLORS[c].dot} В пользу: ${playerName(c)}`, value: c })));
  if (winner === null) return;
  const res = await emitAck('room:propose', { type: 'resign', winner });
  if (res && !res.ok) toast(res.error);
  else toast('Сдача отправлена третьему игроку на подтверждение');
});

$('claimBtn').addEventListener('click', async () => {
  if (mode === 'local') {
    try { localGame = E.claimRepetitionDraw(localGame, localGame.turn); render(); }
    catch (e) { toast(e.message); }
    return;
  }
  const res = await emitAck('room:claimDraw');
  if (res && !res.ok) toast(res.error);
});

$('chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('chatInput').value.trim();
  if (!text) return;
  socket.emit('room:chat', { text });
  $('chatInput').value = '';
});

/* ---------------- view controls ---------------- */
document.querySelectorAll('.pair-btn').forEach(b => b.addEventListener('click', () => {
  const [a, bb] = b.dataset.pair.split(',').map(Number);
  viewMode = 'pair'; pairBottom = a; pairTop = bb;
  $('autoViewChk').checked = false;
  renderBoard(getGame());
}));
$('flipBtn').addEventListener('click', () => {
  viewMode = 'pair';
  const t = pairBottom; pairBottom = pairTop; pairTop = t;
  $('autoViewChk').checked = false;
  renderBoard(getGame());
});
$('stripsBtn').addEventListener('click', () => {
  viewMode = viewMode === 'strips' ? 'pair' : 'strips';
  renderBoard(getGame());
});
$('autoViewChk').addEventListener('change', () => { const g = getGame(); applyAutoView(g); renderBoard(g); });
$('coordsChk').addEventListener('change', () => renderBoard(getGame()));

/* ---------------- socket events ---------------- */
socket.on('connect', () => {
  $('connStatus').classList.add('on');
  $('connStatus').title = 'Соединение с сервером есть';
  if (mode === 'online' && currentRoomCode) {
    socket.emit('room:join', {
      code: currentRoomCode,
      name: localStorage.getItem('thc_name') || $('nameInput').value || 'Игрок',
      clientKey
    }, (res) => { if (res && !res.ok) toast(res.error); });
  }
});
socket.on('disconnect', () => {
  $('connStatus').classList.remove('on');
  $('connStatus').title = 'Нет соединения с сервером (идёт переподключение…)';
});
socket.on('room:self', ({ publicId }) => { myPublicId = publicId; render(); });
socket.on('room:update', (snap) => {
  room = snap;
  if (mode === 'online') render();
});

/* ---------------- init ---------------- */
const presetRoom = new URLSearchParams(location.search).get('room');
if (presetRoom) {
  $('joinCodeInput').value = presetRoom.toUpperCase();
  if ($('nameInput').value.trim()) toast('Комната ' + presetRoom.toUpperCase() + ': нажмите «Войти по коду»');
  else $('nameInput').focus();
}
render();
