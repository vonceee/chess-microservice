const { games, activePlayers, matchmakingQueue, checkAndFlagTimeout, getEffectiveTimes, getLegalMoves, getGameStatus, validateMove, handlePlayerReconnection, startAbandonmentCountdown, clearAbandonmentTimer, sanitizeGame } = require('./game');

// Game Heartbeat Timer: Checks for timeouts every 1s
let lastSyncTime = 0;
setInterval(() => {
  const server = require('./server'); 
  const io = server.io; // Get io from server.js
  if (!io) return;

  for (const [gameId, game] of games.entries()) {
    if (game.status === 'active' && !game.bufferCountdown) {
      // 1. Authoritative internal tick
      const tickNow = new Date();
      // --- ABORT LOGIC ---
      // If the first player (White) or the second player (Black) hasn't made their first move within 30s, abort.
      if (game.moves.length < 2 && game.turnStartedAt) {
        const totalElapsed = tickNow - game.turnStartedAt;
        if (totalElapsed > 30000) {
          game.status = 'aborted';
          game.termination = 'abandoned';
          io.to(gameId).emit('move_made', {
            gameId,
            status: 'aborted',
            termination: 'abandoned',
            whiteTimeRemainingMs: game.whiteTimeRemainingMs,
            blackTimeRemainingMs: game.blackTimeRemainingMs
          });
          continue;
        }
      }
      // --------------------

      if (game.lastMoveTimestamp) {
        const elapsed = tickNow - game.lastMoveTimestamp;
        
        // --- ADDED ABORT LOGIC ---
        // If no moves have been made and the player has been inactive for 30s, abort.
        if (game.moves.length === 0 && elapsed > 30000) {
          game.status = 'aborted';
          game.termination = 'abandoned';
          io.to(gameId).emit('move_made', {
            gameId,
            status: 'aborted',
            termination: 'abandoned',
            whiteTimeRemainingMs: game.whiteTimeRemainingMs,
            blackTimeRemainingMs: game.blackTimeRemainingMs
          });
          continue;
        }
        // -------------------------

        if (game.turn === 'white') {
          game.whiteTimeRemainingMs = Math.max(0, game.whiteTimeRemainingMs - elapsed);
        } else {
          game.blackTimeRemainingMs = Math.max(0, game.blackTimeRemainingMs - elapsed);
        }
      }
      game.lastMoveTimestamp = tickNow;

      // 2. Check for timeout
      const wasTimedOut = checkAndFlagTimeout(game);
      if (wasTimedOut) {
        io.to(gameId).emit('game_ended', {
          gameId,
          result: game.result,
          termination: game.termination,
          status: 'completed'
        });
        continue;
      }

      // 3. Periodic UI Sync (every 5s)
      const nowMs = Date.now();
      if (nowMs - lastSyncTime >= 5000) {
        io.to(gameId).emit('clock_sync', {
          whiteTimeRemainingMs: game.whiteTimeRemainingMs,
          blackTimeRemainingMs: game.blackTimeRemainingMs,
          turn: game.turn,
          serverTimestamp: game.lastMoveTimestamp.toISOString(),
          opponentAwayCountdown: game.opponentAwayCountdown
        });
      }
    }
  }
  
  if (Date.now() - lastSyncTime >= 5000) {
    lastSyncTime = Date.now();
  }
}, 1000);

function setupSocketHandlers(io) {
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
        handlePlayerReconnection(game, playerColor, io);
      }

      // Send current game state
      const effectiveTimes = getEffectiveTimes(game);
      socket.emit('game_state', {
        game: {
          ...sanitizeGame(game),
          my_color: playerColor,
          whiteTimeRemainingMs: effectiveTimes.whiteTimeRemainingMs,
          blackTimeRemainingMs: effectiveTimes.blackTimeRemainingMs,
          serverTimestamp: effectiveTimes.serverTimestamp,
          opponentAwayCountdown: game.opponentAwayCountdown,
          bufferCountdown: game.bufferCountdown
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

      // Authoritative Tick handles deduction every second
      // Here we only deduct the final fractional elapsed time since the very last 1s tick
      // and add the increment.
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
        opponentAwayCountdown: game.opponentAwayCountdown,
        bufferCountdown: game.bufferCountdown
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
      const timedOut = checkAndFlagTimeout(game);
      if (timedOut) {
        socket.emit('clock_sync', {
          whiteTimeRemainingMs: game.whiteTimeRemainingMs,
          blackTimeRemainingMs: game.blackTimeRemainingMs,
          serverTimestamp: new Date().toISOString(),
          gameStatus: 'completed',
          result: game.result,
          termination: game.termination,
        });
        return;
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
            startAbandonmentCountdown(game, disconnectedColor, io);
          }
        }
      }
    });
  });
}

module.exports = { setupSocketHandlers };