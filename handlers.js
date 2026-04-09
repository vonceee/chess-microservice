const { games, activePlayers, matchmakingQueue, checkAndFlagTimeout, getEffectiveTimes, getLegalMoves, getGameStatus, validateMove, handlePlayerReconnection, startAbandonmentCountdown, clearAbandonmentTimer, sanitizeGame } = require('./game');
const { finalizeGame } = require('./utils/game-finisher');
const config = require('./config');
const { arenas, Arena, setIo } = require('./arena');
const { getFeaturedGamesData, getFeaturedGameIds, featuredGames } = require('./tv');

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
            fen: game.fen,
            turn: game.turn,
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
            fen: game.fen,
            turn: game.turn,
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
        finalizeGame(game, io);
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
  setIo(io);
  io.on('connection', (socket) => {
    // Handle join TV
    socket.on('join_tv', () => {
      socket.join('tv_global');
      socket.emit('tv_state', getFeaturedGamesData());
    });

    socket.on('leave_tv', () => {
      socket.leave('tv_global');
    });

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
        finalizeGame(game, io);
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

      // Broadcast to TV if this is a featured game
      if (getFeaturedGameIds().includes(gameId)) {
        let category = null;
        if (featuredGames.bullet === gameId) category = 'bullet';
        else if (featuredGames.blitz === gameId) category = 'blitz';
        else if (featuredGames.rapid === gameId) category = 'rapid';

        if (category) {
          io.to('tv_global').emit('tv_move', {
            category,
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
            termination: game.termination
          });
        }
      }

      // If game ended, also emit game_ended authoritatively
      if (game.status === 'completed') {
        finalizeGame(game, io);
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

      finalizeGame(game, io);
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

        finalizeGame(game, io);
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
        finalizeGame(game, io);
        return;
      }

      const times = getEffectiveTimes(game);
      socket.emit('clock_sync', {
        ...times,
        opponentAwayCountdown: game.opponentAwayCountdown
      });
    });

    // Handle rematch offer
    socket.on('offer_rematch', (gameId) => {
      const game = games.get(gameId);
      if (!game || (game.status !== 'completed' && game.status !== 'aborted')) {
        socket.emit('error', 'Game not finished');
        return;
      }

      const isWhite = game.whitePlayer.userId === socket.userId;
      const isBlack = game.blackPlayer.userId === socket.userId;
      if (!isWhite && !isBlack) {
        socket.emit('error', 'Not authorized');
        return;
      }

      game.rematchOffer = socket.userId;
      const opponentSocketId = isWhite ? game.blackPlayer.socketId : game.whitePlayer.socketId;
      
      if (opponentSocketId) {
        io.to(opponentSocketId).emit('rematch_offered', {
          gameId,
          offeredBy: socket.userId
        });
      }
    });

    // Handle rematch acceptance
    socket.on('accept_rematch', async (gameId) => {
      const game = games.get(gameId);
      if (!game || !game.rematchOffer || game.rematchAccepted) {
        socket.emit('error', 'No rematch offer found');
        return;
      }

      if (game.rematchOffer === socket.userId) {
        socket.emit('error', 'Cannot accept your own offer');
        return;
      }

      const isWhite = game.whitePlayer.userId === socket.userId;
      const isBlack = game.blackPlayer.userId === socket.userId;
      if (!isWhite && !isBlack) {
        socket.emit('error', 'Not authorized');
        return;
      }

      game.rematchAccepted = true;

      // Swapped colors for rematch
      const whitePlayer = isWhite ? game.blackPlayer : game.whitePlayer;
      const blackPlayer = isWhite ? game.whitePlayer : game.blackPlayer;

      try {
        // Create new game in Laravel backend
        const response = await fetch(`${config.API_BASE_URL}/api/internal/game/create`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Internal-Secret': config.INTERNAL_SECRET
          },
          body: JSON.stringify({
            white_id: whitePlayer.userId,
            black_id: blackPlayer.userId,
            time_control: game.timeControl
          })
        });

        if (!response.ok) {
          const err = await response.text();
          throw new Error(`Laravel error: ${err}`);
        }

        const data = await response.json();
        const newGameId = data.game_id;

        // Broadcast to both players
        io.to(gameId).emit('rematch_accepted', {
          oldGameId: gameId,
          newGameId: newGameId
        });
      } catch (err) {
        console.error('[Rematch] Failed to create new game:', err);
        socket.emit('error', 'Failed to create rematch game');
        game.rematchAccepted = false;
      }
    });

    // Handle rematch declined
    socket.on('decline_rematch', (gameId) => {
      const game = games.get(gameId);
      if (!game || !game.rematchOffer) return;

      const isWhite = game.whitePlayer.userId === socket.userId;
      const opponentSocketId = isWhite ? game.blackPlayer.socketId : game.whitePlayer.socketId;

      if (opponentSocketId) {
        io.to(opponentSocketId).emit('rematch_declined', { gameId });
      }
      game.rematchOffer = null;
    });

    socket.on('join_arena', async (dataFromClient) => {
      const { arenaId, name, rating } = dataFromClient;
      if (!arenaId) return;

      let arena = arenas.get(arenaId);
      
      if (!arena) {
        try {
          const dt = await fetch(`${config.API_BASE_URL}/api/tournaments/${arenaId}`);
          if (!dt.ok) throw new Error('Failed to load arena from backend');
          const responseJson = await dt.json();
          const data = responseJson.data || responseJson;
          
          let durationMinutes = 60;
          let timeControl = data.timeControl || '3+0';

          // data.schedule might contain [{ durationMinutes: 60 }]
          if (data.schedule && data.schedule.length > 0 && data.schedule[0].durationMinutes) {
            durationMinutes = data.schedule[0].durationMinutes;
          }

          let initialTimeMs = 180000;
          let incrementMs = 0;
          if (timeControl) {
            const parts = timeControl.split('+');
            if (parts.length >= 1) initialTimeMs = parseInt(parts[0]) * 1000;
            if (parts.length >= 2) incrementMs = parseInt(parts[1]) * 1000;
          }

          arena = new Arena(arenaId, {
            timeControl: timeControl,
            durationMinutes: durationMinutes,
            initialTimeMs: initialTimeMs,
            incrementMs: incrementMs
          });
          arenas.set(arenaId, arena);
        } catch (err) {
          console.error('[Arena] Failed to fetch arena config:', err);
          socket.emit('error', 'Failed to fetch arena details');
          return;
        }
      }

      socket.join(`arena:${arenaId}`);
      arena.join({
        userId: socket.userId,
        name: name || 'Guest',
        rating: rating || 1500
      }, false); // wait=false: Don't join waiting list yet

      // Acknowledge joining with endTime
      socket.emit('arena_joined', {
        arenaId,
        endTime: arena.endTime,
        isWaiting: false
      });

      // Send initial leaderboard
      arena.broadcastLeaderboard();
      
      console.log(`[Arena] User ${socket.userId} joined arena lobby ${arenaId}`);
    });

    socket.on('start_pairing', (arenaId) => {
      const arena = arenas.get(arenaId);
      if (arena) {
        arena.join({ userId: socket.userId }, true); // join waiting list
        socket.emit('pairing_started', { arenaId });
        arena.broadcastLeaderboard();
        console.log(`[Arena] User ${socket.userId} entered waiting list for arena ${arenaId}`);
      }
    });

    socket.on('stop_pairing', (arenaId) => {
      const arena = arenas.get(arenaId);
      if (arena) {
        arena.leave(socket.userId);
        socket.emit('pairing_stopped', { arenaId });
        arena.broadcastLeaderboard();
        console.log(`[Arena] User ${socket.userId} left waiting list for arena ${arenaId}`);
      }
    });

    socket.on('leave_arena', (arenaId) => {
      const arena = arenas.get(arenaId);
      if (arena) {
        arena.leave(socket.userId);
        socket.leave(`arena:${arenaId}`);
        console.log(`[Arena] User ${socket.userId} left arena ${arenaId}`);
      }
    });
    // ----------------------

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

      // Remove from all arena waiting rooms
      for (const arena of arenas.values()) {
        arena.leave(socket.userId);
      }

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