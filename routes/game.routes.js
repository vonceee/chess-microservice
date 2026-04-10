const express = require('express');
const router = express.Router();
const { games, activePlayers, createGame } = require('../game');
const { getEffectiveTimes: getEffectiveTimesClock, sanitizeGame } = require('../utils/clock');
const { getLegalMoves: getLegalMovesChess } = require('../utils/chess');
const { handleProcessMove, handleProcessResign } = require('../services/game-logic');

// Health check endpoint
router.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeGames: games.size,
    activePlayers: activePlayers.size
  });
});

// Create game
router.post('/create-game', express.json(), (req, res) => {
  const game = createGame(req.body);
  res.json({ success: true, gameId: game.id });
});

// Get game state
router.get('/games/:gameId', (req, res) => {
  const game = games.get(req.params.gameId);
  if (!game) return res.status(404).json({ message: 'Game not found' });

  const times = getEffectiveTimesClock(game);
  res.json({
    ...sanitizeGame(game),
    ...times,
    legalMoves: getLegalMovesChess(game.fen)
  });
});

// API move
router.post('/move', express.json(), (req, res) => {
  const { gameId, userId, move } = req.body;
  const game = games.get(gameId);
  if (!game || game.status !== 'active') return res.status(422).json({ message: 'Invalid game' });

  const isWhite = game.whitePlayer.userId === userId;
  const isBlack = game.blackPlayer.userId === userId;
  if (!isWhite && !isBlack) return res.status(403).json({ message: 'Not authorized' });

  const playerColor = isWhite ? 'white' : 'black';
  const server = require('../server');
  const result = handleProcessMove(game, move, playerColor, server.io);
  
  if (result.error) return res.status(422).json(result);
  res.json(result);
});

// Resign
router.post('/resign', express.json(), (req, res) => {
  const { gameId, userId } = req.body;
  const game = games.get(gameId);
  if (!game || game.status !== 'active') return res.status(422).json({ message: 'Invalid game' });

  const isWhite = game.whitePlayer.userId === userId;
  const isBlack = game.blackPlayer.userId === userId;
  if (!isWhite && !isBlack) return res.status(403).json({ message: 'Not authorized' });

  const server = require('../server');
  const result = handleProcessResign(game, isWhite ? 'white' : 'black', server.io);
  res.json(result);
});

// Abort
router.post('/abort', express.json(), (req, res) => {
    const { gameId, userId } = req.body;
    const game = games.get(gameId);
    if (!game || game.status !== 'active') return res.status(422).json({ message: 'Invalid game' });
  
    if (game.moves && game.moves.length > 0) {
      return res.status(422).json({ message: 'Cannot abort after move' });
    }
  
    game.status = 'completed';
    game.result = null;
    game.termination = 'aborted';
  
    const server = require('../server');
    if (server.io) {
      server.io.to(gameId).emit('game_ended', { gameId, result: null, termination: 'aborted', status: 'completed' });
    }
    res.json({ result: null, termination: 'aborted' });
});

// Sync clock
router.post('/sync-clock', express.json(), (req, res) => {
    const game = games.get(req.body.gameId);
    if (!game) return res.status(404).json({ message: 'Not found' });
  
    const times = getEffectiveTimesClock(game);
    res.json({ ...times, opponentAwayCountdown: game.opponentAwayCountdown });
});

module.exports = router;
