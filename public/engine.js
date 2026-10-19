/*
 * Three Half Chess (Green Chess variant, Uray M. János, 2013; general idea Ralph Betza).
 *
 * Board model ---------------------------------------------------------------
 * The board is three half-boards, 8 files x 4 ranks each (96 squares).
 * A square id = half*32 + y*8 + x, where (for every half, seen from the
 * owner of that half sitting behind its home edge):
 *   x = 0..7  files a..h left-to-right
 *   y = 0..3  y=0 is the home (back) rank, y=3 is the centre edge
 * Half indices and army colours coincide: 0 = White, 1 = Red, 2 = Black.
 *
 * Any two halves joined centre-to-centre form a normal 8x8 board. The top
 * half is rotated 180 degrees, so a square (x,y) of the top half becomes
 * (7-x, 7-y) on the joined board (this keeps the chequerboard colours
 * consistent). A move is geometrically legal if it is legal on at least one
 * of the joined boards that contains the starting square.
 *
 * Pawn direction (our explicit, stateless reading of the rules): a pawn
 * marches from its own back rank over its own centre edge into either enemy
 * half and then to that half's back rank, where it promotes. I.e. on its own
 * half it moves away from its home edge; on a foreign half it moves towards
 * that half's home edge.
 *
 * Turn order White -> Red -> Black. A move may not leave your own king in
 * check by either opponent. The game ends, per Green Chess three-player
 * rules, when somebody is checkmated (winner 1, mated 0, third 1/2) or when
 * a king becomes capturable by the player to move before its owner can move
 * (discovered check by a third player's move). Stalemate / 50 rounds /
 * repetition claim / only kings left = draw (1/2 each).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ThreeHalfChess = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var COLORS = [
    { key: 'W', name: 'Белые', dot: '⚪' },
    { key: 'R', name: 'Красные', dot: '🔴' },
    { key: 'B', name: 'Чёрные', dot: '⚫' }
  ];
  var FILES = 'abcdefgh';
  var GLYPH = { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' };
  var BACK_RANK = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];

  function sq(h, x, y) { return h * 32 + y * 8 + x; }
  function parse(id) { return { h: Math.floor(id / 32), y: Math.floor((id % 32) / 8), x: id % 8 }; }
  function coord(id) { var p = parse(id); return COLORS[p.h].key + '·' + FILES[p.x] + (p.y + 1); }
  function inBoard(x, y) { return x >= 0 && x < 8 && y >= 0 && y < 8; }

  // Map a square to joined-board coordinates. bottom = half placed at the
  // bottom, top = half rotated 180° on top. Returns null for the third half.
  function toBoard(id, bottom, top) {
    var p = parse(id);
    if (p.h === bottom) return { x: p.x, y: p.y };
    if (p.h === top) return { x: 7 - p.x, y: 7 - p.y };
    return null;
  }
  function fromBoard(x, y, bottom, top) {
    if (y < 4) return sq(bottom, x, y);
    return sq(top, 7 - x, 7 - y);
  }

  function emptyCastling() {
    return [{ K: false, Q: false }, { K: false, Q: false }, { K: false, Q: false }];
  }

  function createEmptyState() {
    return {
      board: new Array(96).fill(null),
      turn: 0,
      castling: emptyCastling(),
      ep: null, // {passedSq, pawnSq}
      halfmoveClock: 0,
      ply: 0,
      round: 1,
      lastMove: null, // {from,to}
      captured: [], // {c,t,by}
      history: [], // strings
      positionCounts: {},
      checks: [], // colours whose king is currently attacked
      status: 'playing', // | 'finished'
      result: null // {type:'win'|'draw', winner, loser, scores:[..], reason}
    };
  }

  function createInitialState() {
    var s = createEmptyState();
    for (var c = 0; c < 3; c++) {
      for (var x = 0; x < 8; x++) {
        s.board[sq(c, x, 0)] = { c: c, t: BACK_RANK[x] };
        s.board[sq(c, x, 1)] = { c: c, t: 'p' };
      }
      s.castling[c] = { K: true, Q: true };
    }
    s.positionCounts[positionKey(s)] = 1;
    s.checks = computeChecks(s);
    return s;
  }

  function clone(s) { return JSON.parse(JSON.stringify(s)); }

  // Lightweight clone with only what applyToBoard/attack checks need.
  // (Full JSON clones of history+positionCounts per candidate move get
  // quadratically slow in long games.)
  function simClone(s) {
    return {
      board: s.board.map(function (p) { return p ? { c: p.c, t: p.t } : null; }),
      castling: s.castling.map(function (r) { return { K: r.K, Q: r.Q }; }),
      ep: s.ep ? { passedSq: s.ep.passedSq, pawnSq: s.ep.pawnSq } : null,
      captured: [],
      halfmoveClock: s.halfmoveClock,
      lastMove: null
    };
  }

  function positionKey(s) {
    var parts = [];
    for (var i = 0; i < 96; i++) {
      var p = s.board[i];
      parts.push(p ? p.c + p.t : '..');
    }
    var cs = s.castling.map(function (r) { return (r.K ? 'K' : '') + (r.Q ? 'Q' : '') || '-'; }).join('/');
    return parts.join(',') + '|' + s.turn + '|' + cs + '|' + (s.ep ? s.ep.passedSq : '-');
  }

  function kingSquare(s, color) {
    for (var i = 0; i < 96; i++) {
      var p = s.board[i];
      if (p && p.c === color && p.t === 'k') return i;
    }
    return -1;
  }

  // Pawn forward in joined-board coords when the pawn's current half is at
  // the bottom: own half -> towards centre/top (+1), foreign half -> towards
  // that half's home edge at the bottom (-1).
  function pawnDir(pieceColor, halfOfSquare) { return pieceColor === halfOfSquare ? 1 : -1; }

  /* ---------------- attack detection ---------------- */
  function isAttacked(s, targetId, byColor) {
    var t = parse(targetId);
    for (var i = 0; i < 96; i++) {
      var piece = s.board[i];
      if (!piece || piece.c !== byColor) continue;
      var a = parse(i);
      // joined-board coordinates with the attacker's half at the bottom
      var tx, ty;
      if (t.h === a.h) { tx = t.x; ty = t.y; }
      else { tx = 7 - t.x; ty = 7 - t.y; }
      var dx = tx - a.x, dy = ty - a.y;
      var adx = Math.abs(dx), ady = Math.abs(dy);
      switch (piece.t) {
        case 'p':
          if (ady === 1 && adx === 1 && dy === pawnDir(piece.c, a.h)) return true;
          break;
        case 'n':
          if ((adx === 1 && ady === 2) || (adx === 2 && ady === 1)) return true;
          break;
        case 'k':
          if (Math.max(adx, ady) === 1) return true;
          break;
        case 'r': case 'b': case 'q': {
          var straight = (dx === 0) !== (dy === 0);
          var diag = adx === ady && adx > 0;
          if (piece.t === 'r' && !straight) break;
          if (piece.t === 'b' && !diag) break;
          if (piece.t === 'q' && !straight && !diag) break;
          var stepX = Math.sign(dx), stepY = Math.sign(dy);
          var cx = a.x + stepX, cy = a.y + stepY, blocked = false;
          while (cx !== tx || cy !== ty) {
            if (s.board[fromBoard(cx, cy, a.h, t.h)]) { blocked = true; break; }
            cx += stepX; cy += stepY;
          }
          if (!blocked) return true;
          break;
        }
      }
    }
    return false;
  }

  function attackersOf(s, color) {
    var k = kingSquare(s, color);
    if (k < 0) return [];
    var res = [];
    for (var c = 0; c < 3; c++) if (c !== color && isAttacked(s, k, c)) res.push(c);
    return res;
  }
  function inCheck(s, color) { return attackersOf(s, color).length > 0; }
  function computeChecks(s) {
    var res = [];
    for (var c = 0; c < 3; c++) if (inCheck(s, c)) res.push(c);
    return res;
  }

  /* ---------------- pseudo-legal move generation ---------------- */
  function pseudoMoves(s, fromId, includeKingCapture) {
    var piece = s.board[fromId];
    if (!piece) return [];
    var src = parse(fromId);
    var seen = new Map();
    function add(to, extra) {
      var m = Object.assign({ from: fromId, to: to }, extra || {});
      var key = to + '|' + (m.promo || '') + '|' + (m.ep ? 'ep' : '') + '|' + (m.castle || '');
      if (!seen.has(key)) seen.set(key, m);
    }
    function canLand(occ) {
      if (!occ) return true;
      if (occ.c === piece.c) return false;
      if (occ.t === 'k' && !includeKingCapture) return false;
      return true;
    }

    if (piece.t === 'p') {
      var dir = pawnDir(piece.c, src.h);
      for (var o1 = 0; o1 < 3; o1++) {
        if (o1 === src.h) continue;
        var top = o1; // joined board: my half bottom, other half top
        // one step forward
        var y1 = src.y + dir;
        if (inBoard(src.x, y1)) {
          var to1 = fromBoard(src.x, y1, src.h, top);
          var promoRank = (dir > 0 && y1 === 7) || (dir < 0 && y1 === 0);
          if (!s.board[to1]) {
            if (promoRank) ['q', 'r', 'b', 'n'].forEach(function (pr) { add(to1, { promo: pr }); });
            else {
              add(to1);
              // double step from the home pawn rank of its own half
              if (dir === 1 && src.y === 1 && piece.c === src.h) {
                var to2 = fromBoard(src.x, src.y + 2, src.h, top);
                if (!s.board[to2]) add(to2, { double: true });
              }
            }
          }
          // captures
          [-1, 1].forEach(function (ddx) {
            var cx = src.x + ddx;
            if (!inBoard(cx, y1)) return;
            var cto = fromBoard(cx, y1, src.h, top);
            var occ = s.board[cto];
            if (occ && occ.c !== piece.c && canLand(occ)) {
              if (promoRank) ['q', 'r', 'b', 'n'].forEach(function (pr) { add(cto, { promo: pr, capture: true }); });
              else add(cto, { capture: true });
            } else if (!occ && s.ep && cto === s.ep.passedSq) {
              var victimBoard = toBoard(s.ep.pawnSq, src.h, top);
              var victim = s.board[s.ep.pawnSq];
              if (victimBoard && victim && victim.t === 'p' && victim.c !== piece.c &&
                  victimBoard.x === cx && victimBoard.y === src.y) {
                add(cto, { ep: true, capture: true, captureSq: s.ep.pawnSq });
              }
            }
          });
        }
      }
    } else if (piece.t === 'n' || piece.t === 'k') {
      var deltas = piece.t === 'n'
        ? [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]]
        : [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
      for (var o2 = 0; o2 < 3; o2++) {
        if (o2 === src.h) continue;
        deltas.forEach(function (d) {
          var nx = src.x + d[0], ny = src.y + d[1];
          if (!inBoard(nx, ny)) return;
          var to = fromBoard(nx, ny, src.h, o2);
          var occ = s.board[to];
          if (canLand(occ)) add(to, occ ? { capture: true } : {});
        });
      }
    } else { // sliders
      var dirs = piece.t === 'r'
        ? [[1, 0], [-1, 0], [0, 1], [0, -1]]
        : piece.t === 'b'
          ? [[1, 1], [1, -1], [-1, 1], [-1, -1]]
          : [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
      for (var o3 = 0; o3 < 3; o3++) {
        if (o3 === src.h) continue;
        dirs.forEach(function (d) {
          var cx = src.x + d[0], cy = src.y + d[1];
          while (inBoard(cx, cy)) {
            var to = fromBoard(cx, cy, src.h, o3);
            var occ = s.board[to];
            if (!occ) add(to);
            else {
              if (canLand(occ)) add(to, { capture: true });
              break;
            }
            cx += d[0]; cy += d[1];
          }
        });
      }
    }

    // Castling on the king's own half (standard squares e1/g1/c1 of that half)
    if (piece.t === 'k' && src.h === piece.c && src.x === 4 && src.y === 0) {
      var rights = s.castling[piece.c];
      var sides = [
        { right: rights.K, rookX: 7, kingToX: 6, rookToX: 5, between: [5, 6], castle: 'K' },
        { right: rights.Q, rookX: 0, kingToX: 2, rookToX: 3, between: [1, 2, 3], castle: 'Q' }
      ];
      sides.forEach(function (sd) {
        if (!sd.right) return;
        var rookSq = sq(src.h, sd.rookX, 0);
        var rook = s.board[rookSq];
        if (!rook || rook.t !== 'r' || rook.c !== piece.c) return;
        var empty = sd.between.every(function (x) { return !s.board[sq(src.h, x, 0)]; });
        if (!empty) return;
        add(sq(src.h, sd.kingToX, 0), {
          castle: sd.castle, rookFrom: rookSq, rookTo: sq(src.h, sd.rookToX, 0)
        });
      });
    }

    return Array.from(seen.values());
  }

  /* ---------------- applying a move to the board (no turn/status) ---------------- */
  function applyToBoard(s, move) {
    var piece = s.board[move.from];
    var capturedSq = move.ep ? move.captureSq : move.to;
    var captured = s.board[capturedSq];
    if (captured && capturedSq !== move.from) {
      s.captured.push({ c: captured.c, t: captured.t, by: piece.c });
      // rook captured on its home corner removes that castling right
      var cp = parse(capturedSq);
      if (captured.t === 'r' && cp.h === captured.c && cp.y === 0) {
        if (cp.x === 7) s.castling[captured.c].K = false;
        if (cp.x === 0) s.castling[captured.c].Q = false;
      }
      s.board[capturedSq] = null;
    }
    s.board[move.from] = null;
    s.board[move.to] = move.promo ? { c: piece.c, t: move.promo } : piece;
    if (move.castle) {
      s.board[move.rookTo] = s.board[move.rookFrom];
      s.board[move.rookFrom] = null;
    }
    // castling rights of the mover
    if (piece.t === 'k') s.castling[piece.c] = { K: false, Q: false };
    if (piece.t === 'r') {
      var fp = parse(move.from);
      if (fp.h === piece.c && fp.y === 0) {
        if (fp.x === 7) s.castling[piece.c].K = false;
        if (fp.x === 0) s.castling[piece.c].Q = false;
      }
    }
    s.ep = move.double
      ? { passedSq: sq(parse(move.from).h, parse(move.from).x, parse(move.from).y + 1), pawnSq: move.to }
      : null;
    s.halfmoveClock = (piece.t === 'p' || captured) ? 0 : s.halfmoveClock + 1;
    s.lastMove = { from: move.from, to: move.to };
    return captured;
  }

  function legalMoves(s, color) {
    if (s.status !== 'playing') return [];
    var res = [];
    for (var i = 0; i < 96; i++) {
      var piece = s.board[i];
      if (!piece || piece.c !== color) continue;
      var moves = pseudoMoves(s, i, false);
      for (var j = 0; j < moves.length; j++) {
        var m = moves[j];
        if (m.castle) {
          // king may not castle out of, through, or into check
          var kp = parse(i);
          var midX = m.castle === 'K' ? 5 : 3;
          var midSq = sq(kp.h, midX, 0);
          var bad = [i, midSq].some(function (id) {
            return [0, 1, 2].some(function (c) { return c !== color && isAttacked(s, id, c); });
          });
          if (bad) continue;
        }
        var next = simClone(s);
        applyToBoard(next, m);
        if (!inCheck(next, color)) res.push(m);
      }
    }
    return res;
  }

  function movesForPiece(s, fromId) {
    var piece = s.board[fromId];
    if (!piece) return [];
    return legalMoves(s, piece.c).filter(function (m) { return m.from === fromId; });
  }

  function notation(s, move, piece, captured) {
    if (move.castle) return (move.castle === 'K' ? '0-0' : '0-0-0') + ' (' + coord(move.from) + '→' + coord(move.to) + ')';
    var text = COLORS[piece.c].dot + GLYPH[piece.t] + ' ' + coord(move.from) + (captured ? '×' : '→') + coord(move.to);
    if (move.promo) text += '=' + GLYPH[move.promo];
    if (move.ep) text += ' e.p.';
    return text;
  }

  function finishWin(s, winner, loser, reason) {
    var scores = [0.5, 0.5, 0.5];
    scores[winner] = 1; scores[loser] = 0;
    s.status = 'finished';
    s.result = { type: 'win', winner: winner, loser: loser, scores: scores, reason: reason };
  }
  function finishDraw(s, reason) {
    s.status = 'finished';
    s.result = { type: 'draw', winner: null, loser: null, scores: [0.5, 0.5, 0.5], reason: reason };
  }

  function onlyKings(s) {
    return s.board.every(function (p) { return !p || p.t === 'k'; });
  }

  // Can `color` legally capture the king of `victim` right now?
  function canCaptureKing(s, color, victim) {
    var target = kingSquare(s, victim);
    if (target < 0) return false;
    for (var i = 0; i < 96; i++) {
      var piece = s.board[i];
      if (!piece || piece.c !== color) continue;
      var moves = pseudoMoves(s, i, true);
      for (var j = 0; j < moves.length; j++) {
        if (moves[j].to !== target || moves[j].castle) continue;
        var next = simClone(s);
        applyToBoard(next, moves[j]);
        if (!inCheck(next, color)) return true;
      }
    }
    return false;
  }

  /* ---------------- public apply: validate + move + game end ---------------- */
  function applyMove(oldState, input) {
    if (oldState.status !== 'playing') throw new Error('Партия уже окончена');
    var from = input.from, to = input.to, promo = input.promo || null;
    var piece0 = oldState.board[from];
    if (!piece0) throw new Error('На исходной клетке нет фигуры');
    if (piece0.c !== oldState.turn) throw new Error('Сейчас ходят ' + COLORS[oldState.turn].name);

    var legal = legalMoves(oldState, oldState.turn);
    var move = null;
    for (var i = 0; i < legal.length; i++) {
      if (legal[i].from === from && legal[i].to === to && (legal[i].promo || null) === promo) { move = legal[i]; break; }
    }
    if (!move) {
      // nicer error for a forgotten promotion choice
      var needsPromo = legal.some(function (m) { return m.from === from && m.to === to && m.promo; });
      if (needsPromo) { var e = new Error('Нужно выбрать фигуру превращения'); e.code = 'PROMO_REQUIRED'; throw e; }
      throw new Error('Недопустимый ход');
    }

    var s = clone(oldState);
    var piece = s.board[from];
    var captured = applyToBoard(s, move);
    var text = notation(s, move, piece, captured);
    var mover = oldState.turn;
    s.ply = oldState.ply + 1;
    if (mover === 2) s.round = oldState.round + 1;
    s.turn = (mover + 1) % 3;
    var key = positionKey(s);
    s.positionCounts[key] = (s.positionCounts[key] || 0) + 1;
    s.repetitionCount = s.positionCounts[key];

    // --- game end checks, in Green Chess order of importance ---
    var nextLegal = legalMoves(s, s.turn);
    var nextAttackers = attackersOf(s, s.turn);
    if (nextLegal.length === 0) {
      if (nextAttackers.length > 0) {
        // winner = attacker who would move first after the mated player
        var winner = null;
        for (var step = 1; step <= 2; step++) {
          var cand = (s.turn + step) % 3;
          if (nextAttackers.indexOf(cand) >= 0) { winner = cand; break; }
        }
        finishWin(s, winner, s.turn,
          'Мат: ' + COLORS[s.turn].name + ' не могут сделать ход и находятся под шахом.');
        text += '#';
      } else {
        finishDraw(s, 'Пат: у ' + COLORS[s.turn].name + ' нет допустимых ходов.');
      }
    } else {
      // Capturable king: the player after the player to move is in check
      // from the player to move (e.g. a discovered check by the third
      // player's move) - he can be captured before he can move.
      var victim = (s.turn + 1) % 3;
      if (attackersOf(s, victim).indexOf(s.turn) >= 0 && canCaptureKing(s, s.turn, victim)) {
        finishWin(s, s.turn, victim,
          'Король «' + COLORS[victim].name + '» мог быть взят игроком «' + COLORS[s.turn].name +
          '» до своего хода (открытый шах третьим игроком).');
        text += '#';
      } else if (onlyKings(s)) {
        finishDraw(s, 'Остались только короли.');
      } else if (s.halfmoveClock >= 150) {
        finishDraw(s, '50 кругов без хода пешкой и без взятия.');
      }
    }

    s.checks = computeChecks(s);
    if (s.status === 'playing' && s.checks.length > 0) text += '+';
    s.history.push(text);
    return s;
  }

  function claimRepetitionDraw(oldState, color) {
    if (oldState.status !== 'playing') throw new Error('Партия уже окончена');
    if ((oldState.repetitionCount || 0) < 3) throw new Error('Троекратного повторения ещё нет');
    if (color !== oldState.turn) throw new Error('Ничью по повторению может требовать только ходящий игрок');
    var s = clone(oldState);
    finishDraw(s, 'Троекратное повторение позиции.');
    return s;
  }

  return {
    COLORS: COLORS,
    GLYPH: GLYPH,
    sq: sq,
    parse: parse,
    coord: coord,
    toBoard: toBoard,
    fromBoard: fromBoard,
    createInitialState: createInitialState,
    createEmptyState: createEmptyState,
    clone: clone,
    positionKey: positionKey,
    legalMoves: legalMoves,
    movesForPiece: movesForPiece,
    pseudoMoves: pseudoMoves,
    applyMove: applyMove,
    isAttacked: isAttacked,
    inCheck: inCheck,
    attackersOf: attackersOf,
    kingSquare: kingSquare,
    claimRepetitionDraw: claimRepetitionDraw,
    finishDraw: finishDraw,
    finishWin: finishWin
  };
});
