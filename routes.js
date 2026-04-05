const express = require('express');
const router = express.Router();

// Import game state and functions from game.js
const { games, activePlayers, checkAndFlagTimeout, getEffectiveTimes, getLegalMoves, getGameStatus, validateMove, createGame } = require('./game');

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeGames: games.size,
    activePlayers: activePlayers.size
  });
});

// API endpoint for Laravel to create games
router.post('/create-game', express.json(), (req, res) => {
  const gameData = req.body;

  const game = createGame(gameData);
  res.json({ success: true, gameId: game.id });
});

// Get game state endpoint for Laravel API calls
router.get('/games/:gameId', (req, res) => {
  const { gameId } = req.params;
  const game = games.get(gameId);

  if (!game) {
    return res.status(404).json({ message: 'Game not found' });
  }

  const times = getEffectiveTimes(game);
  
  res.json({
    id: game.id,
    status: game.status,
    fen: game.fen,
    turn: game.turn,
    whiteTimeRemainingMs: times.whiteTimeRemainingMs,
    blackTimeRemainingMs: times.blackTimeRemainingMs,
    moves: game.moves,
    result: game.result,
    termination: game.termination,
    bufferCountdown: game.bufferCountdown,
    gameStartedAt: game.gameStartedAt,
    legalMoves: getLegalMoves(game.fen),
    serverTimestamp: times.serverTimestamp
  });
});

// API endpoint for move (proxied from Laravel)
router.post('/move', express.json(), (req, res) => {
  const { gameId, userId, move: uciMove } = req.body;

  if (!gameId || !userId || !uciMove) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  const game = games.get(gameId);
  if (!game || game.status !== 'active') {
    return res.status(422).json({ message: 'Invalid game' });
  }

  // Find the socket for this user
  const socketId = activePlayers.get(userId);
  if (!socketId) {
    return res.status(403).json({ message: 'Player not connected' });
  }

  const socket = io.sockets.sockets.get(socketId);
  if (!socket) {
    return res.status(403).json({ message: 'Player not connected' });
  }

  // Check if it's player's turn
  const isWhite = game.whitePlayer.userId === userId;
  const isBlack = game.blackPlayer.userId === userId;

  if (!isWhite && !isBlack) {
    return res.status(403).json({ message: 'Not authorized' });
  }

  const playerColor = isWhite ? 'white' : 'black';
  if (playerColor !== game.turn) {
    return res.status(422).json({ message: 'Not your turn' });
  }

  // Check for timeout before processing move
  if (checkAndFlagTimeout(game)) {
    return res.json({
      message: 'Time expired',
      game_status: 'completed',
      result: game.result,
      termination: game.termination,
      fen: game.fen,
    });
  }

  // Validate move
  const moveResult = validateMove(game.fen, uciMove);
  if (!moveResult) {
    return res.status(422).json({ message: 'Illegal move' });
  }

  // Update game state with Lichess-style clock management
  const now = new Date();

  // Calculate elapsed time since last move
  let elapsedMs = 0;
  if (game.lastMoveTimestamp) {
    elapsedMs = now - game.lastMoveTimestamp;
  }

  // Apply time deduction and increment to the player who just moved
  if (playerColor === 'white') {
    game.whiteTimeRemainingMs = Math.max(0, game.whiteTimeRemainingMs - elapsedMs + game.incrementMs);
  } else {
    game.blackTimeRemainingMs = Math.max(0, game.blackTimeRemainingMs - elapsedMs + game.incrementMs);
  }

  game.fen = moveResult.fen;
  game.moves.push(uciMove);
  game.lastMoveTimestamp = now;

  // Check for game end conditions
  const status = getGameStatus(game.fen);
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

  // Switch turn if game not ended
  if (game.status === 'active') {
    game.turn = game.turn === 'white' ? 'black' : 'white';
  }

  // Prepare response data
  const responseData = {
    move: uciMove,
    san: moveResult.san,
    fen: game.fen,
    turn: game.turn,
    status: game.status,
    result: game.result,
    termination: game.termination,
    whiteTimeRemainingMs: game.whiteTimeRemainingMs,
    blackTimeRemainingMs: game.blackTimeRemainingMs,
    serverTimestamp: game.lastMoveTimestamp.toISOString(),
    legalMoves: getLegalMoves(game.fen),
    isCheck: getGameStatus(game.fen) === 'check',
    isCheckmate: game.status === 'completed' && game.termination === 'checkmate',
    isStalemate: game.status === 'completed' && game.termination === 'stalemate',
    isDraw: game.status === 'completed' && game.termination === 'draw',
    opponentAwayCountdown: game.opponentAwayCountdown,
    bufferCountdown: game.bufferCountdown
  };

  res.json(responseData);
});

// API endpoint for resign (proxied from Laravel)
router.post('/resign', express.json(), (req, res) => {
  const { gameId, userId } = req.body;

  if (!gameId || !userId) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  const game = games.get(gameId);
  if (!game || game.status !== 'active') {
    return res.status(422).json({ message: 'Invalid game' });
  }

  // Check if player is in this game
  const isWhite = game.whitePlayer.userId === userId;
  const isBlack = game.blackPlayer.userId === userId;

  if (!isWhite && !isBlack) {
    return res.status(403).json({ message: 'Not authorized' });
  }

  const playerColor = isWhite ? 'white' : 'black';
  game.status = 'completed';
  game.result = playerColor === 'white' ? '0-1' : '1-0';
  game.termination = 'resignation';

  // --- ADDED BROADCAST ---
  const server = require('./server');
  const io = server.io;
  if (io) {
    io.to(gameId).emit('game_ended', {
      gameId,
      result: game.result,
      termination: 'resignation',
      status: 'completed'
    });
  }

  res.json({
    message: 'You resigned',
    result: game.result,
    termination: 'resignation',
  });
});

// API endpoint for draw actions (proxied from Laravel)
router.post('/draw', express.json(), (req, res) => {
  const { gameId, userId, action } = req.body;

  if (!gameId || !userId || !action) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  const game = games.get(gameId);
  if (!game || game.status !== 'active') {
    return res.status(422).json({ message: 'Invalid game' });
  }

  // Check if player is in this game
  const isWhite = game.whitePlayer.userId === userId;
  const isBlack = game.blackPlayer.userId === userId;

  if (!isWhite && !isBlack) {
    return res.status(403).json({ message: 'Not authorized' });
  }

  const playerColor = isWhite ? 'white' : 'black';

  if (action === 'offer') {
    // --- ADDED BROADCAST ---
    const server = require('./server');
    const io = server.io;
    if (io) {
      io.to(gameId).emit('draw_offered', {
        gameId,
        offered_by_user_id: userId,
        offered_by: playerColor
      });
    }

    return res.json({
      message: 'Draw offered',
      offered_by: playerColor,
    });
  }

  if (action === 'accept') {
    game.status = 'completed';
    game.result = '1/2-1/2';
    game.termination = 'agreement';

    // --- ADDED BROADCAST ---
    const server = require('./server');
    const io = server.io;
    if (io) {
      io.to(gameId).emit('game_ended', {
        gameId,
        result: '1/2-1/2',
        termination: 'agreement',
        status: 'completed'
      });
    }

    return res.json({
      message: 'Draw accepted',
      result: '1/2-1/2',
      termination: 'agreement',
    });
  }

  if (action === 'decline') {
    // Notify offerer that draw was declined
    const offererSocketId = isWhite ? game.blackPlayer.socketId : game.whitePlayer.socketId;
    io.to(offererSocketId).emit('draw_declined', { gameId });

    return res.json({
      message: 'Draw declined',
      declined_by: playerColor,
    });
  }

  return res.status(422).json({ message: 'Invalid action' });
});

// Abort endpoint
router.post('/abort', express.json(), (req, res) => {
  const { gameId, userId } = req.body;

  if (!gameId || !userId) {
    return res.status(400).json({ message: 'gameId and userId required' });
  }

  const game = games.get(gameId);
  if (!game) {
    return res.status(404).json({ message: 'Game not found' });
  }

  // Check if player is in this game
  const isWhite = game.whitePlayer.userId === userId;
  const isBlack = game.blackPlayer.userId === userId;

  if (!isWhite && !isBlack) {
    return res.status(403).json({ message: 'Not authorized' });
  }

  if (game.status !== 'active') {
    return res.status(422).json({ message: 'Game is not active' });
  }

  // Check if any moves have been made
  if (game.moves && game.moves.length > 0) {
    return res.status(422).json({ message: 'Cannot abort after a move has been made. Use resign instead.' });
  }

  // Abort the game
  game.status = 'completed';
  game.result = null;
  game.termination = 'aborted';

  // --- ADDED BROADCAST ---
  const server = require('./server');
  const io = server.io;
  if (io) {
    io.to(gameId).emit('game_ended', {
      gameId,
      result: null,
      termination: 'aborted',
      status: 'completed'
    });
  }

  res.json({
    result: game.result,
    termination: game.termination
  });
});

// API endpoint for clock sync (proxied from Laravel)
router.post('/sync-clock', express.json(), (req, res) => {
  const { gameId, userId } = req.body;

  if (!gameId || !userId) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  const game = games.get(gameId);
  if (!game) {
    return res.status(404).json({ message: 'Game not found' });
  }

  // Check if player is in this game
  const isWhite = game.whitePlayer.userId === userId;
  const isBlack = game.blackPlayer.userId === userId;

  if (!isWhite && !isBlack) {
    return res.status(403).json({ message: 'Not authorized' });
  }

  // Check for timeout
  if (game.status === 'active') {
    const timedOut = checkAndFlagTimeout(game);
    if (timedOut) {
      return res.json({
        message: 'Time expired',
        game_status: 'completed',
        result: game.result,
        termination: game.termination,
        white_time_remaining_ms: game.whiteTimeRemainingMs,
        black_time_remaining_ms: game.blackTimeRemainingMs,
        fen: game.fen,
        serverTimestamp: new Date().toISOString(),
      });
    }
  }

  const times = getEffectiveTimes(game);
  res.json({
    ...times,
    opponentAwayCountdown: game.opponentAwayCountdown
  });
});

module.exports = router;