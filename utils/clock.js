/**
 * Helper function to check for timeout (Lichess-style)
 */
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

/**
 * Helper function to get effective times for client (Lichess-style)
 */
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

  if (game.status === 'active') {
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

/**
 * Helper function to sanitize game object for JSON/Socket emission
 */
function sanitizeGame(game) {
  if (!game) return null;
  const { abandonmentTimers, ...sanitized } = game;
  return {
    ...sanitized,
    abandonmentTimers: {
      white: { startTime: abandonmentTimers?.white?.startTime },
      black: { startTime: abandonmentTimers?.black?.startTime }
    }
  };
}

module.exports = {
  checkAndFlagTimeout,
  getEffectiveTimes,
  sanitizeGame
};
