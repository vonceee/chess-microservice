const { bughouseGames } = require('./state');
const { applyDropToChess, transferCapture, checkGameOverOnChess, endBughouseGame } = require('./utils');

function registerGameplayHandlers(socket, io) {
  socket.on('bughouse_move', (data) => {
    const { gameId, board, move, fen } = data;
    const game = bughouseGames.get(gameId);
    if (!game || game.status !== 'active') return;

    const myUserId = String(socket.userId);
    const colorInfo = game.colors[myUserId];
    if (!colorInfo || colorInfo.board !== board) return;

    const chess = board === 'A' ? game.chessA : game.chessB;

    if (chess.turn() !== colorInfo.color) {
      console.warn(`[Bughouse] Out-of-turn move attempt by ${myUserId}`);
      return;
    }

    chess.load(fen);

    let pocketUpdate = null;
    if (move.captured) {
      const piece = move.captured;
      transferCapture(game.pockets, board, move.color, piece);
      pocketUpdate = { board, capturedBy: move.color, piece };
    }

    io.to(`bughouse_game_${gameId}`).emit('bughouse_move_broadcast', {
      gameId,
      board,
      fen: chess.fen(),
      move,
      pocketUpdate,
      pockets: game.pockets,
      senderId: myUserId,
    });

    const over = checkGameOverOnChess(chess, board, game);
    if (over) {
      endBughouseGame(io, game, over.winner, over.reason);
    }
  });

  socket.on('bughouse_drop', (data) => {
    const { gameId, board, piece, square, color } = data;
    const game = bughouseGames.get(gameId);
    if (!game || game.status !== 'active') return;

    const myUserId = String(socket.userId);
    const colorInfo = game.colors[myUserId];
    if (!colorInfo || colorInfo.board !== board || colorInfo.color !== color) return;

    const chess = board === 'A' ? game.chessA : game.chessB;

    if (chess.turn() !== color) return;

    const pocketKey = `${board}_${color.toUpperCase()}`;
    const pocket = game.pockets[pocketKey];
    if (!pocket || pocket[piece] <= 0) return;

    if (chess.get(square)) return;

    if (piece === 'p') {
      const rank = square[1];
      if (rank === '1' || rank === '8') return;
    }

    const newFen = applyDropToChess(chess, piece, color, square);
    pocket[piece] = Math.max(0, pocket[piece] - 1);

    const moveSan = `${piece.toUpperCase() === 'P' ? '' : piece.toUpperCase()}@${square}`;

    io.to(`bughouse_game_${gameId}`).emit('bughouse_move_broadcast', {
      gameId,
      board,
      fen: newFen,
      move: { san: moveSan, flags: 'd', color, captured: null },
      pocketUpdate: null,
      pockets: game.pockets,
      senderId: myUserId,
    });

    const over = checkGameOverOnChess(chess, board, game);
    if (over) {
      endBughouseGame(io, game, over.winner, over.reason);
    }
  });

  socket.on('bughouse_resign', (data) => {
    const { gameId } = data;
    const game = bughouseGames.get(gameId);
    if (!game || game.status !== 'active') return;

    const myUserId = String(socket.userId);
    const colorInfo = game.colors[myUserId];
    if (!colorInfo) return;

    let losingTeam;
    const isTeamA =
      String(game.teamA.captainId) === myUserId ||
      String(game.teamA.partnerId) === myUserId;
    losingTeam = isTeamA ? 'Team A' : 'Team B';
    const winner = losingTeam === 'Team A' ? 'Team B' : 'Team A';

    endBughouseGame(io, game, winner, `${socket.userName} resigned`);
  });
}

module.exports = { registerGameplayHandlers };
