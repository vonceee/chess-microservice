const { setupGameHandlers } = require('./game.handler');
const { setupArenaHandlers } = require('./arena.handler');
const { setupTvHandlers } = require('./tv.handler');
const { setupStudyHandlers } = require('./study.handler');
const { setIo } = require('../arena');
const { games, activePlayers, matchmakingQueue, checkAndFlagTimeout, handlePlayerReconnection, startAbandonmentCountdown } = require('../game');
const { finalizeGame } = require('../utils/game-finisher');

let lastSyncTime = 0;

// Game Heartbeat Timer: Checks for timeouts every 1s
setInterval(() => {
  const server = require('../server'); 
  const io = server.io; // Get io from server.js
  if (!io) return;

  for (const [gameId, game] of games.entries()) {
    if (game.status === 'active') {
      const tickNow = new Date();

      // Abort logic for inactive starts
      if (game.moves.length < 2 && game.turnStartedAt) {
        if (tickNow - game.turnStartedAt > 30000) {
          game.status = 'aborted';
          game.termination = 'aborted_server';
          io.to(gameId).emit('game_ended', { 
            gameId, 
            status: 'aborted', 
            termination: 'aborted_server', 
            result: null 
          });
          finalizeGame(game, io);
          continue;
        }
      }

      if (game.lastMoveTimestamp) {
        const elapsed = tickNow - game.lastMoveTimestamp;
        if (game.turn === 'white') {
          game.whiteTimeRemainingMs = Math.max(0, game.whiteTimeRemainingMs - elapsed);
        } else {
          game.blackTimeRemainingMs = Math.max(0, game.blackTimeRemainingMs - elapsed);
        }
      }
      game.lastMoveTimestamp = tickNow;

      if (checkAndFlagTimeout(game)) {
        finalizeGame(game, io);
        continue;
      }

      // Periodic UI Sync (every 5s)
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
    // Basic account tracking
    activePlayers.set(socket.userId, socket.id);

    // Wire up modular handlers
    setupGameHandlers(socket, io);
    setupArenaHandlers(socket, io);
    setupTvHandlers(socket, io);
    setupStudyHandlers(socket, io);

    // Global disconnection handler
    socket.on('disconnect', () => {
      // Remove from matchmaking queue
      const qIdx = matchmakingQueue.findIndex(p => p.userId === socket.userId);
      if (qIdx !== -1) matchmakingQueue.splice(qIdx, 1);

      // Remove from active players
      activePlayers.delete(socket.userId);

      // Handle abandonment
      for (const [gameId, game] of games) {
        if (game.status === 'active') {
          let color = null;
          if (game.whitePlayer.socketId === socket.id) color = 'white';
          else if (game.blackPlayer.socketId === socket.id) color = 'black';

          if (color) {
            if (color === 'white') game.whitePlayer.socketId = '';
            else game.blackPlayer.socketId = '';
            startAbandonmentCountdown(game, color, io);
          }
        }
      }
    });
  });
}

module.exports = { setupSocketHandlers };
