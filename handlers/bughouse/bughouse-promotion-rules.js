const { Chess } = require('chess.js');

/**
 * Resolves the target board, reserve pockets, and target pluck color for a promoting player.
 * 
 * WHY: In Bughouse:
 *      - Partners play opposite colors on opposite boards.
 *      - White on Board A is partnered with Black on Board B.
 *      - The promoting player (e.g. White on Board A) needs a WHITE piece.
 *      - On Board B, the WHITE pieces belong to the teammate's OPPONENT.
 *      - Therefore, an active board pluck removes the OPPONENT's piece on Board B,
 *        NOT the teammate's piece!
 *      - Captured pieces belonging to the promoting player's color are held in the promoting
 *        player's OWN pocket (`ownPocketKey`).
 *      - Disposed pawns are passed to the teammate's pocket (`partnerPocketKey`).
 * 
 * @param {'A' | 'B'} board The promoting player's board.
 * @param {'w' | 'b'} color The promoting player's color.
 * @return {{ otherBoard: 'A' | 'B', ownPocketKey: string, partnerPocketKey: string, targetPluckColor: 'w' | 'b', partnerColor: 'w' | 'b' }}
 */
function getCannibalTargetInfo(board, color) {
  const otherBoard = board === 'A' ? 'B' : 'A';
  const ownPocketKey = `${board}_${color.toUpperCase()}`;
  const partnerColor = color === 'w' ? 'b' : 'w';
  const partnerPocketKey = `${otherBoard}_${partnerColor.toUpperCase()}`;
  const targetPluckColor = color;

  return { otherBoard, ownPocketKey, partnerPocketKey, targetPluckColor, partnerColor };
}

/**
 * Backwards-compatible alias for partner info.
 */
function getPartnerInfo(board, color) {
  return getCannibalTargetInfo(board, color);
}

/**
 * Checks if a specific color's King is in check on a given chess instance, 
 * regardless of whose turn it currently is.
 * 
 * WHY: chess.js only tests `in_check()` for the side whose turn it is.
 *      When plucking a piece off the other board, removing that piece must not leave
 *      that side's King (or the opposing King) in illegal check.
 * 
 * @param {Chess} chess The chess instance to inspect.
 * @param {'w' | 'b'} color The color of the King to verify.
 * @return {boolean} True if the King of the specified color is attacked.
 */
function isKingInCheckForColor(chess, color) {
  const parts = chess.fen().split(' ');
  // TRADEOFF: Force turn marker to `color` in a clone to evaluate king threat without altering live board turn.
  parts[1] = color;
  parts[3] = '-'; // strip en-passant square to avoid FEN parsing exceptions
  try {
    const testChess = new Chess();
    testChess.load(parts.join(' '));
    return testChess.in_check();
  } catch (e) {
    console.error('[BughousePromotionRules] Failed to parse FEN for king-safety check:', e);
    return true; // fail-safe: assume unsafe
  }
}

/**
 * Finds all active candidate squares on the other board for a requested piece type,
 * filtering out any square that would expose either King to check.
 * 
 * @param {Chess} otherChess The live chess instance of the other board.
 * @param {'w' | 'b'} targetPluckColor The color of the pieces to pluck (the opponent's pieces on that board).
 * @param {'w' | 'b'} partnerColor The color of the teammate's pieces on that board.
 * @param {'q' | 'r' | 'b' | 'n'} pieceType The piece type to locate.
 * @return {string[]} Array of legal algebraic squares (e.g. ['d1']).
 */
function getLegalPluckSquares(otherChess, targetPluckColor, pieceType, partnerColor) {
  const legalSquares = [];
  const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
  const ranks = ['1', '2', '3', '4', '5', '6', '7', '8'];

  for (const f of files) {
    for (const r of ranks) {
      const sq = f + r;
      const piece = otherChess.get(sq);
      if (piece && piece.type === pieceType && piece.color === targetPluckColor) {
        // Clone and test removal safety
        const clone = new Chess(otherChess.fen());
        clone.remove(sq);
        // Neither King may be exposed to illegal check
        const opponentCheck = isKingInCheckForColor(clone, targetPluckColor);
        const partnerCheck = partnerColor ? isKingInCheckForColor(clone, partnerColor) : false;
        if (!opponentCheck && !partnerCheck) {
          legalSquares.push(sq);
        }
      }
    }
  }

  return legalSquares;
}

/**
 * Computes the full requisition availability summary for a promoting player.
 * 
 * @param {Object} game The active game state.
 * @param {'A' | 'B'} board The promoting player's board.
 * @param {'w' | 'b'} color The promoting player's color.
 * @return {Record<'q'|'r'|'b'|'n', { inPocket: number, boardSquares: string[], totalAvailable: number }>}
 */
function getCannibalAvailability(game, board, color) {
  const { otherBoard, ownPocketKey, targetPluckColor, partnerColor } = getCannibalTargetInfo(board, color);
  const otherChess = otherBoard === 'A' ? game.chessA : game.chessB;
  const pocket = game.pockets[ownPocketKey] || { p: 0, n: 0, b: 0, r: 0, q: 0 };

  const pieceTypes = ['q', 'r', 'b', 'n'];
  const result = {};

  for (const type of pieceTypes) {
    const inPocket = pocket[type] || 0;
    const boardSquares = getLegalPluckSquares(otherChess, targetPluckColor, type, partnerColor);
    result[type] = {
      inPocket,
      boardSquares,
      totalAvailable: inPocket + boardSquares.length,
    };
  }

  return result;
}

/**
 * Compares and asserts that the target square on otherChess contains the expected piece
 * and that removing it is legal and safe (Compare-and-Swap).
 * 
 * @param {Object} otherChess The chess.js instance of the board being plucked from.
 * @param {{ square: string, expectedPiece?: string }} requisition
 * @param {string} targetPluckColor Color of the piece to be plucked.
 * @param {string} [partnerColor] Color of partner for king-safety check.
 * @return {{ valid: boolean, reason?: string, message?: string, freshFen?: string }}
 */
function validateBoardPluck(otherChess, requisition, targetPluckColor, partnerColor) {
  if (!requisition || !requisition.square) {
    return {
      valid: false,
      reason: 'REQUISITION_TARGET_STALE',
      message: 'No target pluck square specified.',
      freshFen: otherChess.fen(),
    };
  }

  const currentPiece = otherChess.get(requisition.square);

  // Fails if opponent moved the piece or captured it before this packet arrived
  if (
    !currentPiece ||
    (requisition.expectedPiece && currentPiece.type !== requisition.expectedPiece) ||
    currentPiece.color !== targetPluckColor
  ) {
    return {
      valid: false,
      reason: 'REQUISITION_TARGET_STALE',
      message: 'Target piece moved! Reselect your piece.',
      freshFen: otherChess.fen(),
    };
  }

  // Verify that removing this piece does not expose either King to check
  const clone = new Chess(otherChess.fen());
  clone.remove(requisition.square);
  const opponentCheck = isKingInCheckForColor(clone, targetPluckColor);
  const partnerCheck = partnerColor ? isKingInCheckForColor(clone, partnerColor) : false;

  if (opponentCheck || partnerCheck) {
    return {
      valid: false,
      reason: 'REQUISITION_TARGET_STALE',
      message: 'Plucking this piece would expose King to check! Reselect your piece.',
      freshFen: otherChess.fen(),
    };
  }

  return { valid: true };
}

/**
 * Validates and applies a Bughouse Promotion atomically across both boards and pockets.
 * 
 * WHY: Strict piece conservation requires atomic execution. If Board B pluck fails,
 *      Board A's pawn move must roll back to avoid piece duplication or board desync.
 * 
 * @param {Object} game Active Bughouse game state.
 * @param {'A' | 'B'} board Promoting player's board.
 * @param {'w' | 'b'} color Promoting player's color.
 * @param {string} pieceType Target piece ('q', 'r', 'b', 'n').
 * @param {Object} [requisition] Optional requisition specification { source: 'pocket'|'board', square?: string }.
 * @return {{ success: boolean, reason?: string, error?: string, freshFen?: string, targetBoard?: string, plucked?: { board: 'A'|'B', square?: string, piece: string, source: 'pocket'|'board' } }}
 */
function executeCannibalPromotion(game, board, color, pieceType, requisition) {
  const { otherBoard, ownPocketKey, partnerPocketKey, targetPluckColor, partnerColor } = getCannibalTargetInfo(board, color);
  const otherChess = otherBoard === 'A' ? game.chessA : game.chessB;
  const ownPocket = game.pockets[ownPocketKey];
  const partnerPocket = game.pockets[partnerPocketKey];

  const piece = pieceType.toLowerCase();
  if (!['q', 'r', 'b', 'n'].includes(piece)) {
    return { success: false, error: `Invalid promotion piece: ${pieceType}` };
  }

  // 1. REQUISITION HIERARCHY: Pocket First by default, with manual override if requested
  let source = requisition?.source;
  let square = requisition?.square;

  if (!source) {
    if (ownPocket && ownPocket[piece] > 0) {
      source = 'pocket';
    } else {
      source = 'board';
    }
  }

  if (source === 'pocket') {
    if (!ownPocket || ownPocket[piece] <= 0) {
      return {
        success: false,
        reason: 'REQUISITION_POCKET_EMPTY',
        error: `No ${piece.toUpperCase()} available in reserve.`,
        targetBoard: otherBoard,
        freshFen: otherChess.fen(),
      };
    }
    // Deduct from promoting player's pocket
    ownPocket[piece]--;

    // Dispose promoted pawn into partner's drop pocket
    partnerPocket.p = (partnerPocket.p || 0) + 1;

    return {
      success: true,
      plucked: { board: otherBoard, piece, source: 'pocket' },
    };
  }

  if (source === 'board') {
    let targetSquare = square;

    // If square not specified, try to auto-select if exactly 1 candidate exists
    if (!targetSquare) {
      const legalSquares = getLegalPluckSquares(otherChess, targetPluckColor, piece, partnerColor);
      if (legalSquares.length === 1) {
        targetSquare = legalSquares[0];
      } else if (legalSquares.length === 0) {
        return {
          success: false,
          reason: 'REQUISITION_TARGET_STALE',
          error: `No unpinned ${piece.toUpperCase()} available to pluck on Board ${otherBoard}.`,
          freshFen: otherChess.fen(),
          targetBoard: otherBoard,
        };
      } else {
        return {
          success: false,
          reason: 'REQUISITION_DISAMBIGUATION_REQUIRED',
          error: `Multiple candidate pieces exist. Specify a square to pluck.`,
          freshFen: otherChess.fen(),
          targetBoard: otherBoard,
        };
      }
    }

    // Atomic Compare-and-Swap check
    const pluckValidation = validateBoardPluck(
      otherChess,
      { square: targetSquare, expectedPiece: piece },
      targetPluckColor,
      partnerColor
    );

    if (!pluckValidation.valid) {
      return {
        success: false,
        reason: pluckValidation.reason,
        error: pluckValidation.message || 'Target piece moved or is no longer pluckable.',
        freshFen: pluckValidation.freshFen,
        targetBoard: otherBoard,
      };
    }

    // Atomically pluck opponent's piece from other board
    const removedPiece = otherChess.remove(targetSquare);
    if (!removedPiece || removedPiece.type !== piece || removedPiece.color !== targetPluckColor) {
      return {
        success: false,
        reason: 'REQUISITION_TARGET_STALE',
        error: `Failed to remove piece from ${targetSquare} on Board ${otherBoard}.`,
        freshFen: otherChess.fen(),
        targetBoard: otherBoard,
      };
    }

    // Re-verify king safety after removal
    if (isKingInCheckForColor(otherChess, targetPluckColor) || isKingInCheckForColor(otherChess, partnerColor)) {
      // Rollback piece to board
      otherChess.put(removedPiece, targetSquare);
      return {
        success: false,
        reason: 'REQUISITION_TARGET_STALE',
        error: `Plucking from ${targetSquare} exposes King to check!`,
        freshFen: otherChess.fen(),
        targetBoard: otherBoard,
      };
    }

    // Dispose promoted pawn into partner's drop pocket
    partnerPocket.p = (partnerPocket.p || 0) + 1;

    return {
      success: true,
      plucked: { board: otherBoard, square: targetSquare, piece, source: 'board' },
    };
  }

  return { success: false, error: 'Unknown requisition source.' };
}

module.exports = {
  getCannibalTargetInfo,
  getPartnerInfo,
  isKingInCheckForColor,
  getLegalPluckSquares,
  getCannibalAvailability,
  getPromotionPieceAvailability: getCannibalAvailability,
  validateBoardPluck,
  executeCannibalPromotion,
  executeBughousePromotion: executeCannibalPromotion,
};
