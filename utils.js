const { Chess } = require('chess.js');

// Helper function to parse time control
function parseTimeControl(timeControl) {
  const [base, increment] = timeControl.split('+').map(Number);
  return {
    initialTimeMs: base * 1000,
    incrementMs: increment * 1000
  };
}

// Helper function to validate move
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

// Helper function to check game status
function getGameStatus(fen) {
  const chess = new Chess(fen);

  if (chess.in_checkmate()) return 'checkmate';
  if (chess.in_stalemate()) return 'stalemate';
  if (chess.in_threefold_repetition()) return 'draw';
  if (chess.insufficient_material()) return 'draw';
  if (chess.in_check()) return 'check';
  return 'ongoing';
}

// Helper function to get legal moves in UCI format
function getLegalMoves(fen) {
  const chess = new Chess(fen);
  const moves = chess.moves({ verbose: true });
  return moves.map(move => move.from + move.to + (move.promotion || ''));
}

// Helper function to check for timeout (Lichess-style)
function checkAndFlagTimeout(game) {
  if (game.status !== 'active') return false;

  const now = new Date();
  let elapsedMs = 0;

  if (game.lastMoveTimestamp) {
    elapsedMs = now - game.lastMoveTimestamp;
  }

  // Check the current player's time
  const currentPlayerTime = game.turn === 'white' ? game.whiteTimeRemainingMs : game.blackTimeRemainingMs;
  const timeRemaining = Math.max(0, currentPlayerTime - elapsedMs);

  if (timeRemaining <= 0) {
    // Flag the current player
    game.status = 'completed';
    game.result = game.turn === 'white' ? '0-1' : '1-0';
    game.termination = 'timeout';
    return true;
  }

  return false;
}

// Helper function to get effective times for client (Lichess-style)
function getEffectiveTimes(game) {
  const now = new Date();

  if (game.status !== 'active') {
    return {
      whiteTimeRemainingMs: game.whiteTimeRemainingMs,
      blackTimeRemainingMs: game.blackTimeRemainingMs,
      serverTimestamp: now.toISOString()
    };
  }

  // If no moves yet, return initial time
  if (!game.lastMoveTimestamp) {
    return {
      whiteTimeRemainingMs: game.initialTimeMs,
      blackTimeRemainingMs: game.initialTimeMs,
      serverTimestamp: now.toISOString()
    };
  }

  // Calculate current effective times by deducting any elapsed time from the active player
  let whiteTime = game.whiteTimeRemainingMs;
  let blackTime = game.blackTimeRemainingMs;

  const elapsedMs = game.lastMoveTimestamp ? (now - game.lastMoveTimestamp) : 0;

  if (game.status === 'active' && !game.bufferCountdown) {
    if (game.turn === 'white') {
      whiteTime = Math.max(0, whiteTime - elapsedMs);
    } else {
      blackTime = Math.max(0, blackTime - elapsedMs);
    }
  }

  return {
    whiteTimeRemainingMs: whiteTime,
    blackTimeRemainingMs: blackTime,
    turn: game.turn,
    serverTimestamp: game.lastMoveTimestamp ? game.lastMoveTimestamp.toISOString() : now.toISOString()
  };
}

// Helper function to sanitize game object for JSON/Socket emission
function sanitizeGame(game) {
  if (!game) return null;
  const { bufferTimer, abandonmentTimers, ...sanitized } = game;
  return {
    ...sanitized,
    abandonmentTimers: {
      white: { startTime: abandonmentTimers ?.white ?.startTime },
      black: { startTime: abandonmentTimers ?.black ?.startTime }
    }
  };
}

module.exports = {
  parseTimeControl,
  validateMove,
  getGameStatus,
  getLegalMoves,
  checkAndFlagTimeout,
  getEffectiveTimes,
  sanitizeGame
};