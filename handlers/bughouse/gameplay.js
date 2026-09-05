const { activePlayers } = require('../../active-players');
const { bughouseGames } = require('./state');
const { applyDropToChess, transferCapture, checkGameOverOnChess, endBughouseGame } = require('./utils');
const { executeCannibalPromotion, getCannibalAvailability } = require('./bughouse-promotion-rules');

function registerGameplayHandlers(socket, io) {
  socket.on('bughouse_get_cannibal_availability', (data) => {
    const { gameId, board } = data;
    const game = bughouseGames.get(gameId);
    if (!game || game.status !== 'active') return;

    const myUserId = String(socket.userId);
    const colorInfo = game.colors[myUserId];
    if (!colorInfo || colorInfo.board !== board) return;

    const availability = getCannibalAvailability(game, board, colorInfo.color);
    socket.emit('bughouse_cannibal_availability_response', {
      gameId,
      board,
      color: colorInfo.color,
      availability,
    });
  });

  socket.on('bughouse_move', (data) => {
    const { gameId, board, move, fen, requisition } = data;
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

    const isPromotion = (move.flags && move.flags.includes('p')) || !!move.promotion;
    const isCannibal = (game.variant || 'cannibal') === 'cannibal';
    let cannibalResult = null;

    if (isPromotion && isCannibal) {
      const promotionPiece = move.promotion || 'q';
      cannibalResult = executeCannibalPromotion(game, board, colorInfo.color, promotionPiece, requisition);

      if (!cannibalResult.success) {
        if (cannibalResult.reason === 'REQUISITION_TARGET_STALE' || cannibalResult.reason === 'REQUISITION_POCKET_EMPTY') {
          socket.emit('bughouse_requisition_stale', {
            gameId,
            code: cannibalResult.reason,
            message: cannibalResult.error || 'Target piece moved! Reselect your piece.',
            board,
            targetBoard: cannibalResult.targetBoard,
            freshFen: cannibalResult.freshFen,
            fenA: game.chessA.fen(),
            fenB: game.chessB.fen(),
            pockets: game.pockets,
          });
          return;
        }

        socket.emit('bughouse_error', cannibalResult.error || 'Cannibal promotion failed.');
        socket.emit('bughouse_move_broadcast', {
          gameId,
          board,
          fen: chess.fen(),
          fenA: game.chessA.fen(),
          fenB: game.chessB.fen(),
          move: null,
          pocketUpdate: null,
          pockets: game.pockets,
          plucked: null,
          senderId: 'server_rollback',
        });
        return;
      }
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
      fenA: game.chessA.fen(),
      fenB: game.chessB.fen(),
      move,
      pocketUpdate,
      pockets: game.pockets,
      plucked: cannibalResult ? cannibalResult.plucked : null,
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
      fenA: game.chessA.fen(),
      fenB: game.chessB.fen(),
      move: { san: moveSan, flags: 'd', color, captured: null },
      pocketUpdate: null,
      pockets: game.pockets,
      plucked: null,
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

    const isTeamACaptain = String(game.teamA.captainId) === myUserId;
    const isTeamBCaptain = String(game.teamB.captainId) === myUserId;
    if (!isTeamACaptain && !isTeamBCaptain) {
      socket.emit('bughouse_error', 'Only team captains can resign.');
      return;
    }

    const winner = isTeamACaptain ? 'Team B' : 'Team A';

    endBughouseGame(io, game, winner, `${socket.userName || 'Captain'} resigned`);
  });

  socket.on('bughouse_offer_draw', (data) => {
    const { gameId } = data;
    const game = bughouseGames.get(gameId);
    if (!game || game.status !== 'active') return;

    const myUserId = String(socket.userId);
    const colorInfo = game.colors[myUserId];
    if (!colorInfo) return;

    const isTeamACaptain = String(game.teamA.captainId) === myUserId;
    const isTeamBCaptain = String(game.teamB.captainId) === myUserId;
    if (!isTeamACaptain && !isTeamBCaptain) {
      socket.emit('bughouse_error', 'Only team captains can offer a draw.');
      return;
    }

    if (!game.drawOffers) game.drawOffers = new Set();
    game.drawOffers.add(myUserId);

    const captainA = String(game.teamA.captainId);
    const captainB = String(game.teamB.captainId);

    if (game.drawOffers.has(captainA) && game.drawOffers.has(captainB)) {
      endBughouseGame(io, game, 'Draw', 'Draw by mutual agreement');
      return;
    }

    const otherCaptainId = isTeamACaptain ? captainB : captainA;
    const otherCaptainSocketId = activePlayers.get(otherCaptainId);
    if (otherCaptainSocketId) {
      io.to(otherCaptainSocketId).emit('bughouse_draw_offered', {
        gameId,
        offeredBy: socket.userName,
      });
    }
  });
}

module.exports = { registerGameplayHandlers };
