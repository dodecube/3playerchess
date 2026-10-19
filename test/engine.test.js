const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../public/engine.js');

const { sq } = E;

function targets(state, from) {
  return E.movesForPiece(state, from).map(m => m.to);
}

test('initial position: white has 20 legal moves (like chess)', () => {
  const s = E.createInitialState();
  assert.equal(E.legalMoves(s, 0).length, 20);
  assert.equal(s.board.filter(Boolean).length, 48);
});

test('turn order W -> R -> B -> W', () => {
  let s = E.createInitialState();
  s = E.applyMove(s, { from: sq(0, 4, 1), to: sq(0, 4, 2) }); // W e3
  assert.equal(s.turn, 1);
  s = E.applyMove(s, { from: sq(1, 4, 1), to: sq(1, 4, 2) }); // R e3
  assert.equal(s.turn, 2);
  s = E.applyMove(s, { from: sq(2, 4, 1), to: sq(2, 4, 3) }); // B e4 double
  assert.equal(s.turn, 0);
  assert.equal(s.round, 2);
});

test('rook crosses the seam into the other half with mirrored file', () => {
  const s = E.createEmptyState();
  s.board[sq(0, 4, 0)] = { c: 0, t: 'k' };
  s.board[sq(1, 4, 0)] = { c: 1, t: 'k' };
  s.board[sq(2, 4, 0)] = { c: 2, t: 'k' };
  s.board[sq(0, 0, 3)] = { c: 0, t: 'r' }; // W rook on W a4 (centre edge)
  const ts = targets(s, sq(0, 0, 3));
  // straight "up" through the seam to the red half lands on file h (7-0):
  assert.ok(ts.includes(sq(1, 7, 3)), 'can step across seam to R h4');
  assert.ok(ts.includes(sq(1, 7, 0)), 'can slide across to R home rank');
  // ... and likewise to the black half
  assert.ok(ts.includes(sq(2, 7, 3)), 'can step across seam to B h4');
});

test('bishop on own half can capture on both other halves', () => {
  const s = E.createEmptyState();
  s.board[sq(0, 0, 0)] = { c: 0, t: 'k' };
  s.board[sq(1, 0, 0)] = { c: 1, t: 'k' };
  s.board[sq(2, 0, 0)] = { c: 2, t: 'k' };
  s.board[sq(0, 2, 3)] = { c: 0, t: 'b' }; // W bishop on W centre edge
  s.board[sq(1, 3, 1)] = { c: 1, t: 'p' }; // red pawn, board (W+R): (4,6) diagonal of (2,3)->(3,4)(4,5)... adjust below
  const ts = targets(s, sq(0, 2, 3));
  // W+R board: bishop at (2,3). Square (3,4) = R half x=4,y=3 ; (4,5)=R x=3,y=2
  assert.ok(ts.includes(sq(1, 4, 3)), 'diagonal enters red half at its centre edge');
  assert.ok(ts.includes(sq(1, 3, 2)), 'diagonal continues inside red half');
  assert.ok(ts.includes(sq(2, 4, 3)), 'same diagonal exists on W+B board');
});

test('pawn on own half can cross into either enemy half', () => {
  const s = E.createEmptyState();
  s.board[sq(0, 0, 0)] = { c: 0, t: 'k' };
  s.board[sq(1, 0, 0)] = { c: 1, t: 'k' };
  s.board[sq(2, 0, 0)] = { c: 2, t: 'k' };
  s.board[sq(0, 4, 3)] = { c: 0, t: 'p' }; // W pawn on own centre edge e4
  const ts = targets(s, sq(0, 4, 3));
  // forward into red half: board (4,4) -> R x=3,y=3 ; into black: B x=3,y=3
  assert.ok(ts.includes(sq(1, 3, 3)), 'can enter red half');
  assert.ok(ts.includes(sq(2, 3, 3)), 'can enter black half');
});

test('pawn on a foreign half moves towards that half home rank and promotes there', () => {
  const s = E.createEmptyState();
  s.board[sq(0, 0, 0)] = { c: 0, t: 'k' };
  s.board[sq(1, 7, 0)] = { c: 1, t: 'k' };
  s.board[sq(2, 0, 0)] = { c: 2, t: 'k' };
  s.board[sq(1, 3, 1)] = { c: 0, t: 'p' }; // white pawn deep in red half, one step from red home rank
  const moves = E.movesForPiece(s, sq(1, 3, 1));
  const promos = moves.filter(m => m.to === sq(1, 3, 0));
  assert.equal(promos.length, 4, 'four promotion choices on red home rank');
  assert.ok(!targets(s, sq(1, 3, 1)).includes(sq(1, 3, 2)), 'cannot walk back to the centre');
});

test('a move leaving own king in check by the third player is illegal', () => {
  const s = E.createEmptyState();
  // White king e1(own), white rook shielding on e4(own centre), black rook
  // behind the seam on the black half aiming through on the W+B board.
  s.board[sq(0, 4, 0)] = { c: 0, t: 'k' };
  s.board[sq(0, 4, 3)] = { c: 0, t: 'r' };
  s.board[sq(2, 3, 3)] = { c: 2, t: 'r' }; // W+B board: (4,4) - same file as king
  s.board[sq(1, 0, 0)] = { c: 1, t: 'k' };
  s.board[sq(2, 0, 0)] = { c: 2, t: 'k' };
  const rookMoves = targets(s, sq(0, 4, 3));
  assert.ok(!rookMoves.includes(sq(0, 0, 3)), 'shielding rook cannot leave the file');
  assert.ok(rookMoves.includes(sq(2, 3, 3)), 'but it may capture the black rook');
});

test('castling works on own half and rights are spent', () => {
  let s = E.createInitialState();
  const play = (st, f, t) => E.applyMove(st, { from: f, to: t });
  s = play(s, sq(0, 4, 1), sq(0, 4, 2)); // W e3
  s = play(s, sq(1, 0, 1), sq(1, 0, 2)); // R a3
  s = play(s, sq(2, 0, 1), sq(2, 0, 2)); // B a3
  s = play(s, sq(0, 6, 0), sq(0, 5, 2)); // W Nf3
  s = play(s, sq(1, 1, 1), sq(1, 1, 2)); // R b3
  s = play(s, sq(2, 1, 1), sq(2, 1, 2)); // B b3
  s = play(s, sq(0, 5, 0), sq(0, 4, 1)); // W Be2
  s = play(s, sq(1, 2, 1), sq(1, 2, 2)); // R c3
  s = play(s, sq(2, 2, 1), sq(2, 2, 2)); // B c3
  s = play(s, sq(0, 4, 0), sq(0, 6, 0)); // W O-O
  assert.equal(s.board[sq(0, 6, 0)].t, 'k');
  assert.equal(s.board[sq(0, 5, 0)].t, 'r');
  assert.equal(s.castling[0].K, false);
});

test('checkmate scoring: winner 1, mated 0, third 1/2', () => {
  const s = E.createEmptyState();
  // Red to move mates White king cornered on its own half a1 with queen b2
  // protected by red king, red rook covers a-file escape... build a mate:
  s.board[sq(0, 0, 0)] = { c: 0, t: 'k' };       // W king a1
  s.board[sq(0, 0, 1)] = { c: 0, t: 'p' };       // blocks a2 (own pawn; cannot move: b-pawn diag? keep immobile by queen cover below)
  s.board[sq(0, 1, 0)] = { c: 1, t: 'q' };       // red queen b1, protected by red king c1? place:
  s.board[sq(0, 2, 0)] = { c: 1, t: 'k' };       // red king c1 protects queen, covers b2
  s.board[sq(2, 7, 0)] = { c: 2, t: 'k' };       // black king far away
  s.turn = 0; // white to move, in check from queen... verify no legal moves
  assert.ok(E.inCheck(s, 0));
  assert.equal(E.legalMoves(s, 0).length, 0);
  // Now make Red actually give this mate: move red queen from b3 to b1.
  const s2 = E.createEmptyState();
  s2.board[sq(0, 0, 0)] = { c: 0, t: 'k' };
  s2.board[sq(0, 0, 1)] = { c: 0, t: 'p' };
  s2.board[sq(0, 1, 3)] = { c: 1, t: 'q' };
  s2.board[sq(0, 2, 0)] = { c: 1, t: 'k' };
  s2.board[sq(2, 7, 0)] = { c: 2, t: 'k' };
  s2.turn = 1;
  // order: after red, black moves next, so black must have a move; the game
  // literally ends when the *next* player cannot move -> give black a pawn
  // but make black the first who cannot move? No: mate is judged when the
  // mated player's turn comes. To end immediately on red move in our engine
  // the "next player" rule applies, so construct: black is the mated one.
  // Simpler direct check of scoring via capturable/mate of next player:
  const s3 = E.createEmptyState();
  // Black to move mates White (next after black is white).
  s3.board[sq(0, 0, 0)] = { c: 0, t: 'k' };
  s3.board[sq(0, 0, 1)] = { c: 0, t: 'p' };
  s3.board[sq(0, 1, 3)] = { c: 2, t: 'q' }; // black queen on b-file of white half
  s3.board[sq(0, 2, 0)] = { c: 2, t: 'k' }; // black king protects b1/b2
  s3.board[sq(1, 7, 0)] = { c: 1, t: 'k' };
  s3.turn = 2;
  const after = E.applyMove(s3, { from: sq(0, 1, 3), to: sq(0, 1, 0) });
  assert.equal(after.status, 'finished');
  assert.equal(after.result.winner, 2);
  assert.equal(after.result.loser, 0);
  assert.deepEqual(after.result.scores, [0, 0.5, 1]);
});

test('en passant on own half works for the next player', () => {
  let s = E.createEmptyState();
  s.board[sq(0, 0, 0)] = { c: 0, t: 'k' };
  s.board[sq(1, 0, 0)] = { c: 1, t: 'k' };
  s.board[sq(2, 0, 0)] = { c: 2, t: 'k' };
  s.board[sq(0, 4, 1)] = { c: 0, t: 'p' }; // W pawn e2 own
  s.board[sq(0, 5, 3)] = { c: 1, t: 'p' }; // R pawn f4 on white half (marching to W home rank)
  s.turn = 0;
  s = E.applyMove(s, { from: sq(0, 4, 1), to: sq(0, 4, 3) }); // e2-e4 double, passes e3
  const ts = targets(s, sq(0, 5, 3));
  assert.ok(ts.includes(sq(0, 4, 2)), 'red pawn may capture en passant to e3');
  s = E.applyMove(s, { from: sq(0, 5, 3), to: sq(0, 4, 2) });
  assert.equal(s.board[sq(0, 4, 3)], null, 'double-stepped pawn removed');
  assert.equal(s.board[sq(0, 4, 2)].c, 1);
});

test('capturable king: discovered check by third player ends the game', () => {
  const s = E.createEmptyState();
  s.board[sq(0, 4, 0)] = { c: 0, t: 'k' }; // W king e1
  s.board[sq(2, 3, 3)] = { c: 2, t: 'r' }; // B rook: W+B board (4,4), same file
  s.board[sq(0, 4, 3)] = { c: 1, t: 'b' }; // R bishop blocks the file on W e4
  s.board[sq(1, 7, 0)] = { c: 1, t: 'k' };
  s.board[sq(2, 7, 0)] = { c: 2, t: 'k' };
  s.turn = 1; // red to move; order R -> B -> W
  assert.ok(!E.inCheck(s, 0), 'white not in check while bishop blocks');
  const after = E.applyMove(s, { from: sq(0, 4, 3), to: sq(0, 3, 2) });
  assert.equal(after.status, 'finished');
  assert.equal(after.result.winner, 2, 'black wins automatically');
  assert.equal(after.result.loser, 0);
  assert.deepEqual(after.result.scores, [0, 0.5, 1]);
});

test('random self-play games never break invariants (seeded fuzz)', () => {
  // mulberry32: deterministic seed so the test is stable
  let seed = 12345;
  const rand = () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let g = 0; g < 3; g++) {
    let s = E.createInitialState();
    for (let ply = 0; ply < 250 && s.status === 'playing'; ply++) {
      const moves = E.legalMoves(s, s.turn);
      assert.ok(moves.length > 0, 'a "playing" state always has a legal move');
      s = E.applyMove(s, moves[Math.floor(rand() * moves.length)]);
      assert.equal(s.board.filter(p => p && p.t === 'k').length, 3, 'kings are never captured');
    }
    if (s.status === 'finished') {
      assert.equal(s.result.scores.reduce((a, b) => a + b, 0), 1.5, 'scores always sum to 1.5');
    }
  }
});
