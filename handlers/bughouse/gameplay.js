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

    const fenString = chess.fen();
    const parts = fenString.split(' ');
    const fullmove = parseInt(parts[5], 10) || 1;
    const turn = parts[1];
    const moveNo = move.color === 'w' ? fullmove : (turn === 'w' ? fullmove - 1 : fullmove);

    const remainingTime = board === 'A'
      ? (move.color === 'w' ? game.clocks.A_W : game.clocks.A_B)
      : (move.color === 'w' ? game.clocks.B_W : game.clocks.B_B);

    if (!game.movesHistory) {
      game.movesHistory = [];
    }

    const moveEntry = {
      id: `${gameId}_${board}_${game.movesHistory.length}`,
      board,
      moveColor: move.color,
      moveNo,
      san: move.san,
      fen: fenString,
      playerName: socket.userName || 'Unknown',
      remainingTime,
      timestamp: Date.now(),
    };
    game.movesHistory.push(moveEntry);

    io.to(`bughouse_game_${gameId}`).emit('bughouse_move_broadcast', {
      gameId,
      board,
      fen: fenString,
      move,
      pocketUpdate,
      pockets: game.pockets,
      senderId: myUserId,
      moveEntry,
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

    const parts = newFen.split(' ');
    const fullmove = parseInt(parts[5], 10) || 1;
    const turn = parts[1];
    const moveNo = color === 'w' ? fullmove : (turn === 'w' ? fullmove - 1 : fullmove);

    const remainingTime = board === 'A'
      ? (color === 'w' ? game.clocks.A_W : game.clocks.A_B)
      : (color === 'w' ? game.clocks.B_W : game.clocks.B_B);

    if (!game.movesHistory) {
      game.movesHistory = [];
    }

    const moveEntry = {
      id: `${gameId}_${board}_${game.movesHistory.length}`,
      board,
      moveColor: color,
      moveNo,
      san: moveSan,
      fen: newFen,
      playerName: socket.userName || 'Unknown',
      remainingTime,
      timestamp: Date.now(),
    };
    game.movesHistory.push(moveEntry);

    io.to(`bughouse_game_${gameId}`).emit('bughouse_move_broadcast', {
      gameId,
      board,
      fen: newFen,
      move: { san: moveSan, flags: 'd', color, captured: null },
      pocketUpdate: null,
      pockets: game.pockets,
      senderId: myUserId,
      moveEntry,
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
