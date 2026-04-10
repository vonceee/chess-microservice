const { games, handlePlayerReconnection, sanitizeGame } = require('../game');
const { getLegalMoves } = require('../utils/chess');
const { checkAndFlagTimeout, getEffectiveTimes } = require('../utils/clock');
const { finalizeGame } = require('../utils/game-finisher');
const { handleProcessMove, handleProcessResign, handleProcessAbort } = require('../services/game-logic');
const { activePlayers } = require('../game');
const config = require('../config');

function setupGameHandlers(socket, io) {
  // Handle join game
  socket.on('join_game', (gameId) => {
    const game = games.get(gameId);
    if (!game) {
      socket.emit('error', 'Game not found');
      return;
    }

    const isWhite = String(game.whitePlayer.userId) === String(socket.userId);
    const isBlack = String(game.blackPlayer.userId) === String(socket.userId);
    const playerColor = isWhite ? 'white' : 'black';

    socket.join(gameId);

    if (isWhite) {
      game.whitePlayer.socketId = socket.id;
    } else if (isBlack) {
      game.blackPlayer.socketId = socket.id;
    }

    if (game.status === 'active') {
      handlePlayerReconnection(game, playerColor, io);
    }

    const effectiveTimes = getEffectiveTimes(game);
    socket.emit('game_state', {
      game: {
        ...sanitizeGame(game),
        my_color: playerColor,
        whiteTimeRemainingMs: effectiveTimes.whiteTimeRemainingMs,
        blackTimeRemainingMs: effectiveTimes.blackTimeRemainingMs,
        serverTimestamp: effectiveTimes.serverTimestamp,
        opponentAwayCountdown: game.opponentAwayCountdown
      },
      playerColor,
      legalMoves: getLegalMoves(game.fen)
    });
  });

  // Handle move
  socket.on('make_move', (data) => {
    const { gameId, move: uciMove } = data;
    const game = games.get(gameId);

    if (!game || game.status !== 'active') {
      socket.emit('error', 'Invalid game');
      return;
    }

    const isWhite = String(game.whitePlayer.userId) === String(socket.userId);
    const isBlack = String(game.blackPlayer.userId) === String(socket.userId);
    if (!isWhite && !isBlack) {
      socket.emit('error', 'Not authorized');
      return;
    }

    const playerColor = isWhite ? 'white' : 'black';
    if (playerColor !== game.turn) {
      socket.emit('error', 'Not your turn');
      return;
    }

    const result = handleProcessMove(game, uciMove, playerColor, io);
    if (result.error) {
      socket.emit('error', result.error);
    }
  });

  // Handle resign
  socket.on('resign', (gameId) => {
    const game = games.get(gameId);
    if (!game || game.status !== 'active') {
      socket.emit('error', 'Invalid game');
      return;
    }

    const isWhite = String(game.whitePlayer.userId) === String(socket.userId);
    const isBlack = String(game.blackPlayer.userId) === String(socket.userId);
    if (!isWhite && !isBlack) {
      socket.emit('error', 'Not authorized');
      return;
    }

    const playerColor = isWhite ? 'white' : 'black';
    handleProcessResign(game, playerColor, io);
  });

  // Handle abort
  socket.on('abort_game', (gameId) => {
    const game = games.get(gameId);
    if (!game || game.status !== 'active') {
      socket.emit('error', 'Invalid game');
      return;
    }

    const isWhite = String(game.whitePlayer.userId) === String(socket.userId);
    const isBlack = String(game.blackPlayer.userId) === String(socket.userId);
    if (!isWhite && !isBlack) {
      socket.emit('error', 'Not authorized');
      return;
    }

    const playerColor = isWhite ? 'white' : 'black';
    const result = handleProcessAbort(game, playerColor, io);
    if (result.error) {
      socket.emit('error', result.error);
    }
  });

  // Handle draw offer
  socket.on('offer_draw', (gameId) => {
    const game = games.get(gameId);
    if (!game || game.status !== 'active') return;

    const isWhite = String(game.whitePlayer.userId) === String(socket.userId);
    const isBlack = String(game.blackPlayer.userId) === String(socket.userId);
    if (!isWhite && !isBlack) return;

    const opponentSocketId = isWhite ? game.blackPlayer.socketId : game.whitePlayer.socketId;
    io.to(opponentSocketId).emit('draw_offered', {
      gameId,
      offeredBy: isWhite ? 'white' : 'black',
      offeredByUserId: isWhite ? game.whitePlayer.userId : game.blackPlayer.userId
    });
  });

  // Handle draw response
  socket.on('respond_draw', (data) => {
    const { gameId, accept } = data;
    const game = games.get(gameId);
    if (!game || game.status !== 'active') return;

    if (accept) {
      game.status = 'completed';
      game.result = '1/2-1/2';
      game.termination = 'agreement';
      finalizeGame(game, io);
    } else {
      const isWhite = String(game.whitePlayer.userId) === String(socket.userId);
      const offererSocketId = isWhite ? game.blackPlayer.socketId : game.whitePlayer.socketId;
      io.to(offererSocketId).emit('draw_declined', { gameId });
    }
  });

  // Handle clock sync
  socket.on('sync_clock', (gameId) => {
    const game = games.get(gameId);
    if (!game) return;

    // Check for timeout before syncing
    if (checkAndFlagTimeout(game)) {
      finalizeGame(game, io);
      return;
    }

    const times = getEffectiveTimes(game);
    socket.emit('clock_sync', {
      ...times,
      opponentAwayCountdown: game.opponentAwayCountdown
    });
  });

  // Rematch handlers...
  socket.on('offer_rematch', (gameId) => {
    const game = games.get(gameId);
    if (!game || (game.status !== 'completed' && game.status !== 'aborted')) return;

    const userIdNum = Number(socket.userId);
    const isWhite = Number(game.whitePlayer.userId) === userIdNum;
    const isBlack = Number(game.blackPlayer.userId) === userIdNum;
    if (!isWhite && !isBlack) return;

    game.rematchOffer = socket.userId;
    let opponentSocketId = isWhite ? game.blackPlayer.socketId : game.whitePlayer.socketId;
    if (!opponentSocketId) {
      const opponentUserId = isWhite ? game.blackPlayer.userId : game.whitePlayer.userId;
      opponentSocketId = activePlayers.get(String(opponentUserId));
    }
    
    if (opponentSocketId) {
      io.to(opponentSocketId).emit('rematch_offered', { gameId, offeredBy: socket.userId });
    }
  });

  socket.on('accept_rematch', async (gameId) => {
    const game = games.get(gameId);
    if (!game || !game.rematchOffer || game.rematchAccepted) return;

    const userIdNum = Number(socket.userId);
    if (Number(game.rematchOffer) === userIdNum) return;

    const isWhite = Number(game.whitePlayer.userId) === userIdNum;
    const isBlack = Number(game.blackPlayer.userId) === userIdNum;
    if (!isWhite && !isBlack) return;

    game.rematchAccepted = true;
    const whitePlayer = isWhite ? game.blackPlayer : game.whitePlayer;
    const blackPlayer = isWhite ? game.whitePlayer : game.blackPlayer;

    try {
      const response = await fetch(`${config.API_BASE_URL}/api/internal/game/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': config.INTERNAL_SECRET },
        body: JSON.stringify({ white_id: whitePlayer.userId, black_id: blackPlayer.userId, time_control: game.timeControl })
      });

      if (!response.ok) throw new Error('Failed to create rematch');

      const data = await response.json();
      const newGameId = data.game_id;

      [whitePlayer.userId, blackPlayer.userId].forEach(id => {
        const sid = activePlayers.get(String(id));
        if (sid) io.to(sid).emit('rematch_accepted', { oldGameId: gameId, newGameId });
      });
    } catch (err) {
      console.error('[Rematch] Error:', err);
      socket.emit('error', 'Failed to create rematch');
      game.rematchAccepted = false;
    }
  });

  socket.on('decline_rematch', (gameId) => {
    const game = games.get(gameId);
    if (!game || !game.rematchOffer) return;

    const isWhite = Number(game.whitePlayer.userId) === Number(socket.userId);
    let opponentSocketId = (isWhite ? game.blackPlayer.socketId : game.whitePlayer.socketId) || activePlayers.get(String(isWhite ? game.blackPlayer.userId : game.whitePlayer.userId));

    if (opponentSocketId) io.to(opponentSocketId).emit('rematch_declined', { gameId });
    game.rematchOffer = null;
  });
}

module.exports = { setupGameHandlers };
