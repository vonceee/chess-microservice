const { games, handlePlayerReconnection, sanitizeGame } = require('../game');
const { getLegalMoves } = require('../utils/chess');
const { checkAndFlagTimeout, getEffectiveTimes } = require('../utils/clock');
const { finalizeGame } = require('../utils/game-finisher');
const { handleProcessMove, handleProcessResign, handleProcessAbort } = require('../services/game-logic');
const { activePlayers, challenges } = require('../game');
const botEngineService = require('../services/bot-engine.service');
const config = require('../config');
const axios = require('axios');

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

    // If it's a bot's turn and no moves have been made yet, trigger it
    if (game.moves.length === 0 && ((playerColor === 'black' && game.turn === 'white') || (playerColor === 'white' && game.turn === 'black'))) {
        checkAndTriggerBotMove(game, io);
    }
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
    } else {
      // After a successful move, check if the next turn is a bot
      checkAndTriggerBotMove(game, io);
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

  // Handle draw offer cancellation
  socket.on('cancel_draw_offer', (gameId) => {
    const game = games.get(gameId);
    if (!game || game.status !== 'active') return;

    const isWhite = String(game.whitePlayer.userId) === String(socket.userId);
    const isBlack = String(game.blackPlayer.userId) === String(socket.userId);
    if (!isWhite && !isBlack) return;

    const opponentSocketId = isWhite ? game.blackPlayer.socketId : game.whitePlayer.socketId;
    io.to(opponentSocketId).emit('draw_declined', { gameId });
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
      const response = await axios.post(`${config.API_BASE_URL}/api/internal/game/create`, {
        white_id: whitePlayer.userId,
        black_id: blackPlayer.userId,
        time_control: game.timeControl
      }, {
        headers: { 
          'Content-Type': 'application/json', 
          'X-Internal-Secret': config.INTERNAL_SECRET 
        }
      });

      const newGameId = response.data.game_id;

      [whitePlayer.userId, blackPlayer.userId].forEach(id => {
        const sid = activePlayers.get(String(id));
        if (sid) io.to(sid).emit('rematch_accepted', { oldGameId: gameId, newGameId });
      });
    } catch (err) {
      console.error('[Rematch] Error:', err.message);
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

  // Direct Challenge handlers
  socket.on('issue_challenge', (data) => {
    const { targetUserId, settings } = data;
    const targetSocketId = activePlayers.get(String(targetUserId));
    
    if (!targetSocketId) {
      socket.emit('error', 'User is offline');
      return;
    }

    const challengeId = Math.random().toString(36).substring(2, 9);
    const challenge = {
      id: challengeId,
      challenger: { userId: socket.userId, name: socket.userName },
      recipient: { userId: targetUserId, name: '' }, // Name filled if needed
      settings,
      status: 'pending',
      createdAt: new Date().toISOString()
    };

    challenges.set(challengeId, challenge);
    
    // Notify recipient
    io.to(targetSocketId).emit('challenge_offered', challenge);
    // Notify challenger
    socket.emit('challenge_issued', challenge);

    // Auto-expire challenge after 5 minutes
    setTimeout(() => {
      if (challenges.has(challengeId)) {
        challenges.delete(challengeId);
        socket.emit('challenge_expired', { challengeId });
        io.to(targetSocketId).emit('challenge_expired', { challengeId });
      }
    }, 5 * 60 * 1000);
  });

  socket.on('accept_challenge', async (data) => {
    const { challengeId } = data;
    const challenge = challenges.get(challengeId);

    if (!challenge || String(challenge.recipient.userId) !== String(socket.userId)) {
      socket.emit('error', 'Challenge not found or already processed');
      return;
    }

    try {
      // Determine colors
      let whiteId, blackId;
      if (challenge.settings.color === 'random') {
        whiteId = Math.random() > 0.5 ? challenge.challenger.userId : socket.userId;
        blackId = whiteId === challenge.challenger.userId ? socket.userId : challenge.challenger.userId;
      } else if (challenge.settings.color === 'white') {
        whiteId = challenge.challenger.userId;
        blackId = socket.userId;
      } else {
        whiteId = socket.userId;
        blackId = challenge.challenger.userId;
      }

      const response = await axios.post(`${config.API_BASE_URL}/api/internal/game/create`, {
        white_id: whiteId,
        black_id: blackId,
        time_control: challenge.settings.timeControl
      }, {
        headers: { 
          'Content-Type': 'application/json', 
          'X-Internal-Secret': config.INTERNAL_SECRET 
        }
      });

      const gameId = response.data.game_id;
      challenges.delete(challengeId);

      const challengerSocketId = activePlayers.get(String(challenge.challenger.userId));
      const recipientSocketId = socket.id;

      if (challengerSocketId) io.to(challengerSocketId).emit('challenge_accepted', { challengeId, gameId });
      if (recipientSocketId) io.to(recipientSocketId).emit('challenge_accepted', { challengeId, gameId });

    } catch (err) {
      console.error('[Challenge] Accept error:', err.message);
      socket.emit('error', 'Failed to create game');
    }
  });

  socket.on('decline_challenge', (data) => {
    const { challengeId } = data;
    const challenge = challenges.get(challengeId);
    if (!challenge) return;

    const challengerSocketId = activePlayers.get(String(challenge.challenger.userId));
    if (challengerSocketId) io.to(challengerSocketId).emit('challenge_declined', { challengeId });
    
    challenges.delete(challengeId);
  });

  socket.on('cancel_challenge', (data) => {
    const { challengeId } = data;
    const challenge = challenges.get(challengeId);
    if (!challenge) return;

    const recipientSocketId = activePlayers.get(String(challenge.recipient.userId));
    if (recipientSocketId) io.to(recipientSocketId).emit('challenge_canceled', { challengeId });
    
    challenges.delete(challengeId);
  });
}

async function checkAndTriggerBotMove(game, io) {
  if (game.status !== 'active') return;

  const currentTurn = game.turn;
  const player = currentTurn === 'white' ? game.whitePlayer : game.blackPlayer;

  if (!player.isBot) return;

  console.log(`[BotMatch] Thinking for ${player.name} (${currentTurn})...`);

  // 1. Human-like delay: Faster for first move to avoid auto-abort (1-3s), normal after (2-6s)
  const isFirstMove = game.moves.length === 0;
  const delay = isFirstMove 
    ? Math.floor(Math.random() * 2000) + 1000 
    : Math.floor(Math.random() * 4000) + 2000;
  
  setTimeout(async () => {
    // Re-verify game state hasn't changed during delay
    if (game.status !== 'active' || game.turn !== currentTurn) return;

    try {
      // 2. Map rating to Stockfish skill level (0-20)
      const rating = player.rating || 1500;
      const skillLevel = Math.max(0, Math.min(20, Math.floor((rating - 400) / 100)));

      // 3. Get best move
      const move = await botEngineService.getBestMove(game.fen, skillLevel);
      
      if (move) {
        console.log(`[BotMatch] ${player.name} plays ${move.from}${move.to}${move.promotion || ''}`);
        
        // 4. Process the move (use same logic as human player)
        // We simulate the 'io' and 'game' context
        handleProcessMove(game, `${move.from}${move.to}${move.promotion || ''}`, currentTurn, io);
        
        // 5. Check if next turn is ALSO a bot (rare but possible in bot vs bot)
        checkAndTriggerBotMove(game, io);
      }
    } catch (err) {
      console.error('[BotMatch] Error generating bot move:', err);
    }
  }, delay);
}

module.exports = { setupGameHandlers };
