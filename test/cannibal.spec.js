const assert = require('assert');
const { Chess } = require('chess.js');
const {
  getCannibalTargetInfo,
  isKingInCheckForColor,
  getLegalPluckSquares,
  getCannibalAvailability,
  executeCannibalPromotion,
} = require('../handlers/bughouse/bughouse-promotion-rules');

function countTotalPieces(game) {
  let count = 0;

  // Board A pieces
  const fenA = game.chessA.fen().split(' ')[0];
  for (const ch of fenA) {
    if (/[a-zA-Z]/.test(ch)) count++;
  }

  // Board B pieces
  const fenB = game.chessB.fen().split(' ')[0];
  for (const ch of fenB) {
    if (/[a-zA-Z]/.test(ch)) count++;
  }

  // Pockets
  for (const pocketKey of Object.keys(game.pockets)) {
    const pocket = game.pockets[pocketKey];
    for (const p of Object.keys(pocket)) {
      count += pocket[p];
    }
  }

  return count;
}

function runTests() {
  console.log('--- Running Cannibal Promotion Test Suite (Opponent Pluck) ---');

  // Test 1: getCannibalTargetInfo resolution
  {
    const p1 = getCannibalTargetInfo('A', 'w');
    assert.strictEqual(p1.otherBoard, 'B');
    assert.strictEqual(p1.ownPocketKey, 'A_W');
    assert.strictEqual(p1.partnerPocketKey, 'B_B');
    assert.strictEqual(p1.targetPluckColor, 'w', 'Target on Board B is White (the opponent of our teammate on Board B)');

    const p2 = getCannibalTargetInfo('B', 'b');
    assert.strictEqual(p2.otherBoard, 'A');
    assert.strictEqual(p2.ownPocketKey, 'B_B');
    assert.strictEqual(p2.partnerPocketKey, 'A_W');
    assert.strictEqual(p2.targetPluckColor, 'b', 'Target on Board A is Black (the opponent on Board A)');
    console.log('✓ Test 1: getCannibalTargetInfo resolution passed.');
  }

  // Test 2: King in check detection regardless of active turn
  {
    // White king on e1, White bishop on e3, Black rook on e8. Turn is Black ('b')
    const c = new Chess('4k3/8/8/8/4r3/4B3/8/4K3 b - - 0 1');
    assert.strictEqual(isKingInCheckForColor(c, 'w'), false, 'White King should NOT be in check with shield');

    c.remove('e3');
    assert.strictEqual(isKingInCheckForColor(c, 'w'), true, 'White King SHOULD be in check once e3 shield is removed even on black turn');
    console.log('✓ Test 2: King-safety check passed.');
  }

  // Test 3: getLegalPluckSquares filters out pinned pieces
  {
    // Target is White on Board B (the opponent).
    // White King on e1, White Queen on e3, Black Rook on e8. (White Queen is pinned to White King).
    // White Queen on a1 (unpinned).
    const c = new Chess('4k3/8/8/8/4r3/4Q3/8/Q3K3 b - - 0 1');
    const legalQueens = getLegalPluckSquares(c, 'w', 'q', 'b');
    assert.deepStrictEqual(legalQueens, ['a1'], 'Only unpinned White queen at a1 should be eligible for plucking');
    console.log('✓ Test 3: getLegalPluckSquares pinned piece filtering passed.');
  }

  // Test 4: Pocket first default requisition
  {
    const game = {
      chessA: new Chess('4k3/4P3/8/8/8/8/8/4K3 w - - 0 1'), // pawn on e7 ready to promote
      chessB: new Chess('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
      pockets: {
        A_W: { p: 0, n: 0, b: 0, r: 0, q: 1 }, // player holds 1 queen in pocket
        A_B: { p: 0, n: 0, b: 0, r: 0, q: 0 },
        B_W: { p: 0, n: 0, b: 0, r: 0, q: 0 },
        B_B: { p: 0, n: 0, b: 0, r: 0, q: 0 },
      },
    };

    const initialTotal = countTotalPieces(game);
    const result = executeCannibalPromotion(game, 'A', 'w', 'q');

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.plucked.source, 'pocket');
    assert.strictEqual(game.pockets.A_W.q, 0, 'Promoting player pocket queen deducted');
    assert.strictEqual(game.pockets.B_B.p, 1, 'Teammate on Board B pocket pawn added from disposed pawn');
    assert.strictEqual(game.chessB.get('d1').type, 'q', 'Board B opponent queen untouched');
    assert.strictEqual(game.chessB.get('d8').type, 'q', 'Board B teammate queen untouched');

    // Simulate Board A applying move e8=Q
    game.chessA.load('4Qk2/8/8/8/8/8/8/4K3 b - - 0 1');
    const finalTotal = countTotalPieces(game);
    assert.strictEqual(finalTotal, initialTotal, 'Strict piece conservation invariant maintained (64 pieces)');
    console.log('✓ Test 4: Pocket first requisition & piece conservation passed.');
  }

  // Test 5: Active board pluck targets OPPONENT on Board B, NOT teammate!
  {
    const game = {
      chessA: new Chess('4k3/4P3/8/8/8/8/8/4K3 w - - 0 1'),
      chessB: new Chess('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'),
      pockets: {
        A_W: { p: 0, n: 0, b: 0, r: 0, q: 0 }, // 0 in pocket
        A_B: { p: 0, n: 0, b: 0, r: 0, q: 0 },
        B_W: { p: 0, n: 0, b: 0, r: 0, q: 0 },
        B_B: { p: 0, n: 0, b: 0, r: 0, q: 0 },
      },
    };

    const initialTotal = countTotalPieces(game);
    const result = executeCannibalPromotion(game, 'A', 'w', 'q'); // should auto-target d1 (White Queen, the Opponent!)

    assert.strictEqual(result.success, true);
    assert.strictEqual(result.plucked.source, 'board');
    assert.strictEqual(result.plucked.square, 'd1', 'Plucks opponent White queen at d1 on Board B');
    assert.strictEqual(game.chessB.get('d1'), null, 'Board B d1 (Opponent) square is now empty');
    assert.strictEqual(game.chessB.get('d8').type, 'q', 'Board B d8 (Teammate Black Queen) is SAFE and untouched!');
    assert.strictEqual(game.chessB.turn(), 'w', 'Board B turn preserved');
    assert.strictEqual(game.pockets.B_B.p, 1, 'Teammate pocket gained disposed pawn');

    // Simulate Board A applying move e8=Q
    game.chessA.load('4Qk2/8/8/8/8/8/8/4K3 b - - 0 1');
    const finalTotal = countTotalPieces(game);
    assert.strictEqual(finalTotal, initialTotal, 'Strict piece conservation invariant maintained for opponent board pluck');
    console.log('✓ Test 5: Opponent board pluck passed without harming teammate!');
  }

  // Test 6: Rejection when 0 available
  {
    const game = {
      chessA: new Chess('4k3/4P3/8/8/8/8/8/4K3 w - - 0 1'),
      chessB: new Chess('rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNB1KBNR w KQkq - 0 1'), // No White queen at d1 on Board B
      pockets: {
        A_W: { p: 0, n: 0, b: 0, r: 0, q: 0 },
        A_B: { p: 0, n: 0, b: 0, r: 0, q: 0 },
        B_W: { p: 0, n: 0, b: 0, r: 0, q: 0 },
        B_B: { p: 0, n: 0, b: 0, r: 0, q: 0 },
      },
    };

    const result = executeCannibalPromotion(game, 'A', 'w', 'q');
    assert.strictEqual(result.success, false);
    assert.match(result.error, /No unpinned Q available/);
    console.log('✓ Test 6: Rejection on piece unavailable passed.');
  }

  // Test 7: Race condition / Compare-and-Swap rejection (User D moved Qd1-a4 before User A's pluck arrived)
  {
    const game = {
      chessA: new Chess('4k3/4P3/8/8/8/8/8/4K3 w - - 0 1'),
      // Board B state after User D already played Qd1-a4
      chessB: new Chess('rnbqkbnr/pppppppp/8/8/Q7/8/PPPPPPPP/RNB1KBNR b KQkq - 1 1'),
      pockets: {
        A_W: { p: 0, n: 0, b: 0, r: 0, q: 0 },
        A_B: { p: 0, n: 0, b: 0, r: 0, q: 0 },
        B_W: { p: 0, n: 0, b: 0, r: 0, q: 0 },
        B_B: { p: 0, n: 0, b: 0, r: 0, q: 0 },
      },
    };

    // User A's stale request specifying d1
    const result = executeCannibalPromotion(game, 'A', 'w', 'q', {
      source: 'board',
      square: 'd1',
      expectedPiece: 'q',
    });

    assert.strictEqual(result.success, false);
    assert.strictEqual(result.reason, 'REQUISITION_TARGET_STALE');
    assert.strictEqual(result.targetBoard, 'B');
    assert.strictEqual(result.freshFen, game.chessB.fen());
    assert.strictEqual(game.chessB.get('a4').type, 'q', 'Queen on a4 is untouched and not ghost-removed');
    assert.strictEqual(game.pockets.B_B.p, 0, 'No ghost pawn added');
    console.log('✓ Test 7: Race condition (REQUISITION_TARGET_STALE) Compare-and-Swap passed.');
  }

  console.log('ALL TESTS PASSED! Teammate pieces are safe; opponent piece plucked; race conditions rejected! 🎉');
}

runTests();
