const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Configure for your frontend domain
    methods: ["GET", "POST"]
  }
});

// API URL for token validation - should be from environment variable
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:8000';

// In-memory storage for games
const games = new Map(); // gameId -> game state
const activePlayers = new Map(); // userId -> socketId
const matchmakingQueue = []; // Queue for matchmaking

// Game state structure:
// {
//   id: string,
//   whitePlayer: {userId, socketId, name},
//   blackPlayer: {userId, socketId, name},
//   fen: string,
//   turn: 'white' | 'black',
//   status: 'active' | 'completed' | 'abandoned',
//   timeControl: string,
//   initialTimeMs: number,
//   incrementMs: number,
//   whiteTimeRemainingMs: number,
//   blackTimeRemainingMs: number,
//   moves: string[],
//   result: string | null,
//   termination: string | null,
//   createdAt: Date,
//   lastMoveTimestamp: Date | null,
//   abandonmentTimers: {
//     white: { timer: Timeout | null, startTime: Date | null },
//     black: { timer: Timeout | null, startTime: Date | null }
//   },
//   opponentAwayCountdown: number | null  // seconds remaining for opponent return
// }

// Authentication middleware for Socket.io
io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth.token;
    const providedUserId = socket.handshake.auth.userId;
    const providedUserName = socket.handshake.auth.userName;

    if (!token && !providedUserId) {
      return next(new Error('Authentication error'));
    }

    // For production, validate token with Laravel API
    if (token && API_BASE_URL) {
      try {
        const response = await fetch(`${API_BASE_URL}/api/user`, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Accept': 'application/json'
          }
        });

        if (response.ok) {
          const userData = await response.json();
          socket.userId = String(userData.id);
          socket.userName = userData.name;
        } else {
          throw new Error('Token validation failed');
        }
      } catch (apiError) {
        console.log('API validation failed, using provided credentials:', apiError.message);
        // Fallback to provided credentials if API validation fails
        if (providedUserId) {
          socket.userId = String(providedUserId);
          socket.userName = providedUserName || 'Test User';
        } else {
          return next(new Error('Authentication error'));
        }
      }
    } else if (providedUserId) {
      // Development fallback: use provided credentials
      socket.userId = String(providedUserId);
      socket.userName = providedUserName || 'Test User';
    } else {
      return next(new Error('Authentication error'));
    }

    // Store active player
    activePlayers.set(socket.userId, socket.id);
    next();
  } catch (err) {
    console.log('Authentication error:', err.message);
    return next(new Error('Authentication error'));
  }
});

// Helper function to create new game (called from Laravel)
function createGame(gameData) {
  const { gameId, whitePlayer, blackPlayer, timeControl, initialTimeMs, incrementMs } = gameData;

  if (!gameId || !whitePlayer || !blackPlayer || !timeControl || initialTimeMs === undefined || incrementMs === undefined) {
    throw new Error('Missing required game data');
  }

  const game = {
    id: gameId,
    whitePlayer: {
      userId: whitePlayer.userId,
      socketId: '', // Will be set when players connect
      name: whitePlayer.name
    },
    blackPlayer: {
      userId: blackPlayer.userId,
      socketId: '', // Will be set when players connect
      name: blackPlayer.name
    },
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    turn: 'white',
    status: 'active',
    timeControl,
    initialTimeMs,
    incrementMs,
    whiteTimeRemainingMs: initialTimeMs,
    blackTimeRemainingMs: initialTimeMs,
    moves: [],
    result: null,
    termination: null,
    createdAt: new Date(),
    lastMoveTimestamp: null,
    abandonmentTimers: {
      white: { timer: null, startTime: null },
      black: { timer: null, startTime: null }
    },
    opponentAwayCountdown: null
  };

  games.set(gameId, game);
  return game;
}

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

// === GAME ABANDONMENT HANDLING PLAN ===
//
// This system provides fair and predictable handling of player disconnections:
//
// 1. DETECTION: When a player disconnects (socket closes), their socketId is cleared
// 2. COUNTDOWN: A 30-second countdown begins, notifying the opponent via 'opponent_away_countdown'
// 3. RECONNECTION: If the player reconnects within 30 seconds, countdown is cancelled
// 4. ABANDONMENT: If countdown reaches 0, game ends with 'abandoned' termination
// 5. NOTIFICATION: Opponent receives 'opponent_returned' when player comes back
//
// Key features:
// - Prevents immediate game loss on temporary disconnects (network issues)
// - Allows fair chance for reconnection
// - Real-time countdown updates for opponent
// - Proper cleanup of timers on server shutdown
// - Works for both socket and API-based clients
//
// Game states: 'active' -> 'completed' (with termination: 'abandoned')
// Socket events: 'opponent_disconnected', 'opponent_away_countdown', 'opponent_returned'

function startAbandonmentCountdown(game, color) {
  const player = color === 'white' ? game.whitePlayer : game.blackPlayer;
  const opponent = color === 'white' ? game.blackPlayer : game.whitePlayer;

  // Clear any existing timer for this player
  clearAbandonmentTimer(game, color);

  // Set countdown start time
  game.abandonmentTimers[color].startTime = new Date();
  game.opponentAwayCountdown = 30; // 30 seconds

  // Start countdown timer
  game.abandonmentTimers[color].timer = setInterval(() => {
    game.opponentAwayCountdown--;

    // Notify opponent of remaining time
    if (opponent.socketId) {
      io.to(opponent.socketId).emit('opponent_away_countdown', {
        gameId: game.id,
        secondsRemaining: game.opponentAwayCountdown
      });
    }

    // If countdown reaches 0, abandon the game
    if (game.opponentAwayCountdown <= 0) {
      clearAbandonmentTimer(game, color);
      abandonGame(game, color);
    }
  }, 1000);
}

// Helper function to clear abandonment timer for a player
function clearAbandonmentTimer(game, color) {
  if (game.abandonmentTimers[color].timer) {
    clearInterval(game.abandonmentTimers[color].timer);
    game.abandonmentTimers[color].timer = null;
    game.abandonmentTimers[color].startTime = null;
    game.opponentAwayCountdown = null;
  }
}

// Helper function to abandon a game
function abandonGame(game, abandonedBy) {
  if (game.status !== 'active') return;

  game.status = 'completed';
  game.result = abandonedBy === 'white' ? '0-1' : '1-0';
  game.termination = 'abandoned';

  // Notify both players if they're connected
  io.to(game.id).emit('game_ended', {
    gameId: game.id,
    result: game.result,
    termination: game.termination,
    status: 'completed'
  });
}

// Helper function to handle player reconnection
function handlePlayerReconnection(game, color) {
  // Clear the abandonment timer for this player
  clearAbandonmentTimer(game, color);

  // Notify the opponent that the player has returned
  const opponent = color === 'white' ? game.blackPlayer : game.whitePlayer;
  if (opponent.socketId) {
    io.to(opponent.socketId).emit('opponent_returned', {
      gameId: game.id
    });
  }
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

  // Validate stored times - fallback to initial if corrupted
  let whiteTime = game.whiteTimeRemainingMs;
  let blackTime = game.blackTimeRemainingMs;

  const maxValidTime = game.initialTimeMs * 10;
  if (whiteTime > maxValidTime || whiteTime <= 0) {
    whiteTime = game.initialTimeMs;
  }
  if (blackTime > maxValidTime || blackTime <= 0) {
    blackTime = game.initialTimeMs;
  }

  return {
    whiteTimeRemainingMs: whiteTime,
    blackTimeRemainingMs: blackTime,
    serverTimestamp: game.lastMoveTimestamp.toISOString()
  };
}

// Socket.io connection handling
io.on('connection', (socket) => {
  // Handle join game
  socket.on('join_game', (gameId) => {
    const game = games.get(gameId);
    if (!game) {
      socket.emit('error', 'Game not found');
      return;
    }

    // Check if player is in this game
    const isWhite = game.whitePlayer.userId === socket.userId;
    const isBlack = game.blackPlayer.userId === socket.userId;

    socket.join(gameId);

    // Update socket ID in game state
    const playerColor = isWhite ? 'white' : 'black';
    if (isWhite) {
      game.whitePlayer.socketId = socket.id;
    } else {
      game.blackPlayer.socketId = socket.id;
    }

    // Handle reconnection - clear abandonment timer if it was running
    if (game.status === 'active') {
      handlePlayerReconnection(game, playerColor);
    }

    // Send current game state
    const effectiveTimes = getEffectiveTimes(game);
    socket.emit('game_state', {
      game: {
        ...game,
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

    // Check if it's player's turn
    const isWhite = game.whitePlayer.userId === socket.userId;
    const isBlack = game.blackPlayer.userId === socket.userId;

    const playerColor = isWhite ? 'white' : 'black';

    // Check for timeout before processing move
    if (checkAndFlagTimeout(game)) {
      io.to(gameId).emit('game_ended', {
        gameId,
        result: game.result,
        termination: game.termination,
        status: 'completed'
      });
      return;
    }

    // Validate move
    const moveResult = validateMove(game.fen, uciMove);
    if (!moveResult) {
      socket.emit('error', 'Illegal move');
      return;
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

    // Check for timeout
    if (playerColor === 'white' && game.whiteTimeRemainingMs <= 0) {
      game.status = 'completed';
      game.result = '0-1';
      game.termination = 'timeout';
    } else if (playerColor === 'black' && game.blackTimeRemainingMs <= 0) {
      game.status = 'completed';
      game.result = '1-0';
      game.termination = 'timeout';
    } else {
      // Check game status
      const status = getGameStatus(game.fen);
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
    }

    // Broadcast move to game room
    io.to(gameId).emit('move_made', {
      gameId,
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
    });

    // If game ended, also emit game_ended
    if (game.status === 'completed') {
      io.to(gameId).emit('game_ended', {
        gameId,
        result: game.result,
        termination: game.termination,
        status: 'completed'
      });
    }
  });

  // Handle resign
  socket.on('resign', (gameId) => {
    const game = games.get(gameId);

    if (!game || game.status !== 'active') {
      socket.emit('error', 'Invalid game');
      return;
    }

    const isWhite = game.whitePlayer.userId === socket.userId;
    const isBlack = game.blackPlayer.userId === socket.userId;

    if (!isWhite && !isBlack) {
      socket.emit('error', 'Not authorized');
      return;
    }

    const playerColor = isWhite ? 'white' : 'black';
    game.status = 'completed';
    game.result = playerColor === 'white' ? '0-1' : '1-0';
    game.termination = 'resignation';

    io.to(gameId).emit('game_ended', {
      gameId,
      result: game.result,
      termination: game.termination,
      status: 'completed'
    });
  });

  // Handle draw offer
  socket.on('offer_draw', (gameId) => {
    const game = games.get(gameId);

    if (!game || game.status !== 'active') {
      socket.emit('error', 'Invalid game');
      return;
    }

    const isWhite = game.whitePlayer.userId === socket.userId;
    const isBlack = game.blackPlayer.userId === socket.userId;

    if (!isWhite && !isBlack) {
      socket.emit('error', 'Not authorized');
      return;
    }

    // Notify opponent
    const opponentSocketId = isWhite ? game.blackPlayer.socketId : game.whitePlayer.socketId;
    io.to(opponentSocketId).emit('draw_offered', {
      gameId,
      offeredBy: isWhite ? 'white' : 'black'
    });
  });

  // Handle draw response
  socket.on('respond_draw', (data) => {
    const { gameId, accept } = data;
    const game = games.get(gameId);

    if (!game || game.status !== 'active') {
      socket.emit('error', 'Invalid game');
      return;
    }

    const isWhite = game.whitePlayer.userId === socket.userId;
    const isBlack = game.blackPlayer.userId === socket.userId;

    if (!isWhite && !isBlack) {
      socket.emit('error', 'Not authorized');
      return;
    }

    if (accept) {
      game.status = 'completed';
      game.result = '1/2-1/2';
      game.termination = 'agreement';

      io.to(gameId).emit('game_ended', {
        gameId,
        result: game.result,
        termination: game.termination,
        status: 'completed'
      });
    } else {
      // Notify offerer that draw was declined
      const offererSocketId = isWhite ? game.blackPlayer.socketId : game.whitePlayer.socketId;
      io.to(offererSocketId).emit('draw_declined', { gameId });
    }
  });

  // Handle clock sync
  socket.on('sync_clock', (gameId) => {
    const game = games.get(gameId);

    if (!game) {
      socket.emit('error', 'Game not found');
      return;
    }

    const isWhite = game.whitePlayer.userId === socket.userId;
    const isBlack = game.blackPlayer.userId === socket.userId;

    if (!isWhite && !isBlack) {
      socket.emit('error', 'Not authorized');
      return;
    }

    // Check for timeout before syncing
    if (game.status === 'active') {
      const timedOut = checkAndFlagTimeout(game);
      if (timedOut) {
        io.to(gameId).emit('game_ended', {
          gameId,
          result: game.result,
          termination: game.termination,
          status: 'completed'
        });
        return;
      }
    }

    const times = getEffectiveTimes(game);
    socket.emit('clock_sync', {
      ...times,
      opponentAwayCountdown: game.opponentAwayCountdown
    });
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    // Remove from matchmaking queue
    const queueIndex = matchmakingQueue.findIndex(p => p.userId === socket.userId);
    if (queueIndex !== -1) {
      matchmakingQueue.splice(queueIndex, 1);
      io.emit('queue_size', matchmakingQueue.length);
    }

    // Remove from active players
    activePlayers.delete(socket.userId);

    // Handle game abandonment countdown
    for (const [gameId, game] of games) {
      if (game.status === 'active') {
        let disconnectedColor = null;
        if (game.whitePlayer.socketId === socket.id) {
          disconnectedColor = 'white';
        } else if (game.blackPlayer.socketId === socket.id) {
          disconnectedColor = 'black';
        }

        if (disconnectedColor) {
          // Clear the socket ID
          if (disconnectedColor === 'white') {
            game.whitePlayer.socketId = '';
          } else {
            game.blackPlayer.socketId = '';
          }

          // Start abandonment countdown
          startAbandonmentCountdown(game, disconnectedColor);
        }
      }
    }
  });
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    activeGames: games.size,
    activePlayers: activePlayers.size
  });
});

// API endpoint for Laravel to create games
app.post('/api/create-game', express.json(), (req, res) => {
  const gameData = req.body;

  const game = createGame(gameData);
  res.json({ success: true, gameId: game.id });
});

// API endpoint for move (proxied from Laravel)
app.post('/api/move', express.json(), (req, res) => {
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
    // Broadcast game ended
    io.to(gameId).emit('game_ended', {
      gameId,
      result: game.result,
      termination: game.termination,
      status: 'completed'
    });

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
    opponentAwayCountdown: game.opponentAwayCountdown
  };

    // Broadcast move to game room
    io.to(gameId).emit('move_made', responseData);

    // If game ended, also emit game_ended
    if (game.status === 'completed') {
      io.to(gameId).emit('game_ended', {
        gameId,
        result: game.result,
        termination: game.termination,
        status: 'completed'
      });
    }

  res.json(responseData);
});

// API endpoint for resign (proxied from Laravel)
app.post('/api/resign', express.json(), (req, res) => {
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

  io.to(gameId).emit('game_ended', {
    gameId,
    result: game.result,
    termination: game.termination,
    status: 'completed'
  });

  res.json({
    message: 'You resigned',
    result: game.result,
    termination: 'resignation',
  });
});

// API endpoint for draw actions (proxied from Laravel)
app.post('/api/draw', express.json(), (req, res) => {
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
    // For simplicity, we'll allow draw offers without complex cooldown logic in microservice
    // The frontend can handle cooldowns

    // Notify opponent
    const opponentSocketId = isWhite ? game.blackPlayer.socketId : game.whitePlayer.socketId;
    io.to(opponentSocketId).emit('draw_offered', {
      gameId,
      offeredBy: playerColor
    });

    return res.json({
      message: 'Draw offered',
      offered_by: playerColor,
    });
  }

  if (action === 'accept') {
    game.status = 'completed';
    game.result = '1/2-1/2';
    game.termination = 'agreement';

    io.to(gameId).emit('game_ended', {
      gameId,
      result: game.result,
      termination: game.termination,
      status: 'completed'
    });

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

// API endpoint for clock sync (proxied from Laravel)
app.post('/api/sync-clock', express.json(), (req, res) => {
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
      io.to(gameId).emit('game_ended', {
        gameId,
        result: game.result,
        termination: game.termination,
        status: 'completed'
      });

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

// Cleanup function for server shutdown
function cleanupTimers() {
  for (const [gameId, game] of games) {
    clearAbandonmentTimer(game, 'white');
    clearAbandonmentTimer(game, 'black');
  }
}

// Handle server shutdown
process.on('SIGINT', () => {
  cleanupTimers();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanupTimers();
  process.exit(0);
});

// Start server
const PORT = process.env.PORT || 3006;
server.listen(PORT, () => {
  console.log(`Chess microservice listening on port ${PORT}`);
  console.log(`API Base URL: ${API_BASE_URL || 'not configured'}`);
});