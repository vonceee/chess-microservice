const { Chess } = require('chess.js');

/**
 * Helper function to parse time control
 */
function parseTimeControl(timeControl) {
  const [base, increment] = timeControl.split('+').map(Number);
  return {
    initialTimeMs: base * 1000,
    incrementMs: increment * 1000
  };
}

/**
 * Helper function to validate move
 */
function validateMove(fen, uciMove) {
  try {
    const chess = new Chess(fen);

    // Convert UCI to chess.js move format
    const from = uciMove.substring(0, 2);
    const to = uciMove.substring(2, 4);
    const promotion = uciMove.length > 4 ? uciMove[4] : undefined;

    const move = chess.move({ from, to, promotion });
    if (!move) return null;

    return {
      fen: chess.fen(),
      san: move.san
    };
  } catch (error) {
    return null;
  }
}

/**
 * Helper function to check game status
 */
function getGameStatus(fen) {
  const chess = new Chess(fen);

  if (chess.in_checkmate()) return 'checkmate';
  if (chess.in_stalemate()) return 'stalemate';
  if (chess.in_threefold_repetition()) return 'draw';
  if (chess.insufficient_material()) return 'draw';
  if (chess.in_check()) return 'check';
  return 'ongoing';
}

/**
 * Helper function to get legal moves in UCI format
 */
function getLegalMoves(fen) {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  return moves.map(move => move.from + move.to + (move.promotion || ''));
}

module.exports = {
  parseTimeControl,
  validateMove,
  getGameStatus,
  getLegalMoves
};
