const { bughouseGames } = require('./state');

const DEFAULT_TIME = 300;

/**
 * Registers Socket.IO event listeners for spectating and leaving spectatorship.
 * 
 * @param {Socket} socket The client's socket connection.
 * @param {Server} io     The main Socket.IO server instance.
 */
function registerSpectatorHandlers(socket, io) {
  socket.on('bughouse_spectate', (data) => {
    const { gameId } = data;
    const game = bughouseGames.get(gameId);
    if (!game || game.status !== 'active') {
      socket.emit('bughouse_error', 'Game is not active or does not exist.');
      return;
    }
    socket.join(`bughouse_game_${gameId}`);
    socket.emit('bughouse_game_start', {
      gameId,
      colors: game.colors,
      teamA: game.teamA,
      teamB: game.teamB,
      boardAFen: game.chessA.fen(),
      boardBFen: game.chessB.fen(),
      pockets: game.pockets,
      clocks: game.clocks,
      timeControl: DEFAULT_TIME,
      isSpectator: true,
    });
  });

  socket.on('bughouse_leave_spectate', (data) => {
    const { gameId } = data;
    const game = bughouseGames.get(gameId);

    // CRITICAL: Prevent active players from leaving their game room channel when the frontend TV Stream effect cleans up.
    // Otherwise, they will stop receiving game move broadcasts and clock ticks.
    const myUserId = String(socket.userId);
    if (game && game.status === 'active' && game.colors[myUserId]) {
      console.log(`[Bughouse] Prevented active player ${myUserId} from leaving game room ${gameId} via leave_spectate`);
      return;
    }

    socket.leave(`bughouse_game_${gameId}`);
  });
}

module.exports = { registerSpectatorHandlers };
