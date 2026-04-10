const { validateMove, getGameStatus, getLegalMoves } = require('../utils/chess');
const { checkAndFlagTimeout } = require('../utils/clock');
const { finalizeGame } = require('../utils/game-finisher');
const { getFeaturedGameIds, featuredGames } = require('../tv');

/**
 * Handles processing a chess move for both socket and HTTP requests.
 * @param {Object} game - The game object from in-memory Map
 * @param {string} uciMove - The move in UCI format (e.g., 'e2e4')
 * @param {string} playerColor - 'white' or 'black'
 * @param {Object} io - Socket.io instance
 * @returns {Object|null} - The move result or null if illegal
 */
function handleProcessMove(game, uciMove, playerColor, io) {
  // Check for timeout before processing move
  if (checkAndFlagTimeout(game)) {
    finalizeGame(game, io);
    return { error: 'Time expired', timedOut: true };
  }

  // Validate move
  const moveResult = validateMove(game.fen, uciMove);
  if (!moveResult) {
    return { error: 'Illegal move' };
  }

  // Update game clock
  const now = new Date();
  if (game.lastMoveTimestamp) {
    const elapsed = now - game.lastMoveTimestamp;
    if (playerColor === 'white') {
      game.whiteTimeRemainingMs = Math.max(0, game.whiteTimeRemainingMs - elapsed + (game.incrementMs || 0));
    } else {
      game.blackTimeRemainingMs = Math.max(0, game.blackTimeRemainingMs - elapsed + (game.incrementMs || 0));
    }
  }

  game.fen = moveResult.fen;
  game.moves.push(uciMove);
  game.lastMoveTimestamp = now;
  game.turnStartedAt = now; // Mark start of the next player's turn

  // Check for game end conditions
  let status = getGameStatus(game.fen);
  game.turn = game.turn === 'white' ? 'black' : 'white';

  if (status === 'checkmate') {
    game.status = 'completed';
    game.result = game.turn === 'white' ? '0-1' : '1-0';
    game.termination = 'checkmate';
  } else if (status === 'stalemate') {
    game.status = 'completed';
    game.result = '1/2-1/2';
    game.termination = 'stalemate';
  } else if (status === 'draw') {
    game.status = 'completed';
    game.result = '1/2-1/2';
    game.termination = 'draw';
  }

  const responseData = {
    gameId: game.id,
    move: uciMove,
    san: moveResult.san,
    fen: game.fen,
    turn: game.turn,
    whiteTimeRemainingMs: game.whiteTimeRemainingMs,
    blackTimeRemainingMs: game.blackTimeRemainingMs,
    serverTimestamp: game.lastMoveTimestamp.toISOString(),
    status: game.status,
    result: game.result,
    termination: game.termination,
    legalMoves: getLegalMoves(game.fen),
    isCheck: getGameStatus(game.fen) === 'check',
    isCheckmate: game.status === 'completed' && game.termination === 'checkmate',
    isStalemate: game.status === 'completed' && game.termination === 'stalemate',
    isDraw: game.status === 'completed' && game.termination === 'draw',
    opponentAwayCountdown: game.opponentAwayCountdown
  };

  // Broadcast move to game room
  if (io) {
    console.log(`[Game] Emitting move_made for game ${game.id} to room ${game.id}`);
    io.to(game.id).emit('move_made', responseData);

    // Broadcast to TV if this is a featured game
    if (getFeaturedGameIds().includes(game.id)) {
      let category = null;
      if (featuredGames.bullet === game.id) category = 'bullet';
      else if (featuredGames.blitz === game.id) category = 'blitz';
      else if (featuredGames.rapid === game.id) category = 'rapid';

      if (category) {
        io.to('tv_global').emit('tv_move', { ...responseData, category });
      }
    }

    // Authoritative finalization
    if (game.status === 'completed') {
      finalizeGame(game, io);
    }
  }

  return responseData;
}

/**
 * Handles resignation for both socket and HTTP requests.
 */
function handleProcessResign(game, playerColor, io) {
  if (game.status !== 'active') return { error: 'Game not active' };

  game.status = 'completed';
  game.result = playerColor === 'white' ? '0-1' : '1-0';
  game.termination = 'resignation';

  finalizeGame(game, io);

  return {
    status: game.status,
    result: game.result,
    termination: game.termination
  };
}

/**
 * Handles game abort for both socket and HTTP requests.
 */
function handleProcessAbort(game, playerColor, io) {
  if (game.status !== 'active') return { error: 'Game not active' };
  if (game.moves && game.moves.length > 0) {
    return { error: 'Cannot abort after move' };
  }

  game.status = 'aborted';
  game.result = null;
  game.termination = playerColor ? `aborted_${playerColor}` : 'aborted';

  if (io) {
    io.to(game.id).emit('game_ended', {
      gameId: game.id,
      status: 'aborted',
      result: null,
      termination: game.termination
    });
  }

  finalizeGame(game, io);

  return {
    status: game.status,
    result: null,
    termination: game.termination
  };
}

module.exports = {
  handleProcessMove,
  handleProcessResign,
  handleProcessAbort
};
