const { activePlayers } = require('../../active-players');
const { bughouseGames, bughouseLobbies, activePlayersLobby, bughouseQueue, activePlayerGames } = require('./state');
const { getActiveGamesList, endBughouseGame, leaveCurrentLobby } = require('./utils');

const DEFAULT_TIME = 300;

/**
 * Handles client connection initialization, active match reconnection, 
 * and lobby synchronization.
 * 
 * WHY: Replaces O(N) active game iteration queries with an O(1) player lookup index 
 *      to ensure instant page load/reconnection times even under heavy loads.
 * 
 * @param {Socket} socket  The client's socket connection.
 * @param {Server} io      The main Socket.IO server instance.
 */
function handleJoin(socket, io) {
  socket.join('bughouse_global');
  socket.emit('bughouse_active_games', getActiveGamesList());

  const myUserId = String(socket.userId);

  // Check if user is in an active game via O(1) lookup
  const gameId = activePlayerGames.get(myUserId);
  if (gameId) {
    const game = bughouseGames.get(gameId);
    if (game && game.status === 'active' && game.colors[myUserId]) {
      // Clear pending forfeit timer if present
      if (game.disconnectedPlayers[myUserId]) {
        clearTimeout(game.disconnectedPlayers[myUserId].timeoutId);
        delete game.disconnectedPlayers[myUserId];
      }

      // Re-join Socket.IO room
      socket.join(`bughouse_game_${gameId}`);

      // Notify other players
      socket.to(`bughouse_game_${gameId}`).emit('bughouse_player_reconnected', {
        userId: myUserId,
        playerName: socket.userName,
      });

      // Resync by emitting bughouse_game_start to the reconnected socket
      socket.emit('bughouse_game_start', {
        gameId: game.gameId,
        colors: game.colors,
        teamA: { captainName: game.teamA.captainName, partnerId: game.teamA.partnerId, partnerName: game.teamA.partnerName, captainId: game.teamA.captainId },
        teamB: { captainName: game.teamB.captainName, partnerId: game.teamB.partnerId, partnerName: game.teamB.partnerName, captainId: game.teamB.captainId },
        boardAFen: game.chessA.fen(),
        boardBFen: game.chessB.fen(),
        pockets: game.pockets,
        clocks: game.clocks,
        timeControl: DEFAULT_TIME,
        yourBoard: game.colors[myUserId].board,
        yourColor: game.colors[myUserId].color,
        movesHistory: game.movesHistory || [],
      });

      console.log(`[Bughouse] Active game player ${myUserId} reconnected via bughouse_join. Synced and rejoined room.`);
      return;
    }
  }

  // Sync lobby state
  const lobbyId = activePlayersLobby.get(String(socket.userId));
  if (lobbyId) {
    const lobby = bughouseLobbies.get(lobbyId);
    if (lobby) {
      socket.join(`bughouse_lobby_${lobbyId}`);
      socket.emit('bughouse_lobby_sync', lobby);
      console.log(`[Bughouse] Synced user ${socket.userId} with lobby ${lobbyId}`);
      return;
    }
  }
  socket.emit('bughouse_lobby_sync', null);
}

/**
 * Handles player disconnections with grace periods to allow client refreshes/reconnects.
 * 
 * WHY: Replaced immediate game forfeiture with a 45-second buffer (reconnectGraceMs) 
 *      to ensure network glitches don't instantly end active matches.
 * 
 * @param {Socket} socket  The disconnecting socket connection.
 * @param {Server} io      The main Socket.IO server instance.
 * 
 * ASSUMPTIONS/EDGE CASES:
 * - 15-second lobby grace check: verifies if they reconnected on a new socket ID.
 * - 45-second game grace check: schedules a timeout to forfeit the game to the opponent 
 *   unless cleared in handleJoin.
 */
function handleDisconnect(socket, io) {
  const userId = String(socket.userId);

  // 1. Clean up lobby and matchmaking queue state with a 15s grace period to allow reloads
  setTimeout(() => {
    const activeSocketId = activePlayers.get(userId);
    if (!activeSocketId) {
      leaveCurrentLobby(socket, io);
    } else {
      console.log(`[Bughouse] Captain/User ${userId} reconnected. Lobby preserved.`);
    }
  }, 15000);

  // 2. If this player is in an active game, start disconnection grace timer via O(1) lookup
  const myUserId = String(socket.userId);
  const gameId = activePlayerGames.get(myUserId);

  if (gameId) {
    const game = bughouseGames.get(gameId);
    if (game && game.status === 'active') {
      const colorInfo = game.colors[myUserId];
      if (colorInfo) {
        const slotKey = `${colorInfo.board}_${colorInfo.color.toUpperCase()}`;

        // Broadcast disconnection notice to all remaining 3 players
        io.to(`bughouse_game_${gameId}`).emit('bughouse_player_disconnected', {
          userId: myUserId,
          playerName: socket.userName,
          slot: slotKey,
          gracePeriodMs: game.reconnectGraceMs,
        });

        io.to(`bughouse_game_${gameId}`).emit('bughouse_opponent_disconnected', {
          playerName: socket.userName,
        });

        // Start disconnection grace timer (45 seconds)
        const timeoutId = setTimeout(() => {
          if (game.status === 'active' && game.disconnectedPlayers[myUserId]) {
            delete game.disconnectedPlayers[myUserId];

            const isTeamA =
              String(game.teamA.captainId) === myUserId ||
              String(game.teamA.partnerId) === myUserId;
            const winner = isTeamA ? 'Team B' : 'Team A';

            endBughouseGame(
              io,
              game,
              winner,
              `${socket.userName} abandoned the match (reconnection timeout)`
            );
          }
        }, game.reconnectGraceMs);

        game.disconnectedPlayers[myUserId] = {
          disconnectedAt: Date.now(),
          timeoutId,
          playerName: socket.userName,
          slot: slotKey,
        };
      }
    }
  }
}

module.exports = { handleJoin, handleDisconnect };
