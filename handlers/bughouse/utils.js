const { activePlayers } = require('../../active-players');
const { bughouseGames, bughouseLobbies, bughouseQueue, activePlayersLobby, activePlayerGames, bughouseRematches } = require('./state');

function emptyPocket() {
  return { p: 0, n: 0, b: 0, r: 0, q: 0 };
}

/**
 * Places a piece dropped from a player pocket onto the chess.js board representation
 * and manually updates FEN turn markers.
 * 
 * WHY: chess.js v0.10.2 does not natively support Bughouse pocket drop operations. 
 *      We use `chess.put()` to place the piece on the board, but must manually mutate the FEN 
 *      string to flip the active color turn and increment move counts before reloading it.
 * 
 * @param {Chess} chess   The chess.js game board instance.
 * @param {string} piece  The chess piece identifier (e.g. 'p', 'n', 'b', 'r', 'q').
 * @param {string} color  The dropping player's color ('w' or 'b').
 * @param {string} square The board square coordinate (e.g. 'e4').
 * @return {string}       The updated authoritative FEN string.
 */
function applyDropToChess(chess, piece, color, square) {
  chess.put({ type: piece, color }, square);
  const parts = chess.fen().split(' ');
  const nextTurn = parts[1] === 'w' ? 'b' : 'w';
  const fullmove = parts[1] === 'b' ? parseInt(parts[5], 10) + 1 : parseInt(parts[5], 10);
  const newFen = `${parts[0]} ${nextTurn} ${parts[2]} - 0 ${fullmove}`;
  chess.load(newFen);
  return newFen;
}

function transferCapture(pockets, board, capturerColor, piece) {
  const normalised = piece === 'q' ? 'q' : piece;
  if (board === 'A') {
    if (capturerColor === 'w') pockets.B_B[normalised]++;
    else pockets.B_W[normalised]++;
  } else {
    if (capturerColor === 'w') pockets.A_B[normalised]++;
    else pockets.A_W[normalised]++;
  }
}

function checkGameOverOnChess(chess, board, game) {
  if (chess.in_checkmate()) {
    const losingColor = chess.turn();
    let winner;
    if (board === 'A') {
      winner = losingColor === 'w' ? 'Team B' : 'Team A';
    } else {
      winner = losingColor === 'w' ? 'Team A' : 'Team B';
    }
    return { winner, reason: `Checkmate on Board ${board}` };
  }
  if (chess.in_draw() || chess.in_stalemate() || chess.in_threefold_repetition() || chess.insufficient_material()) {
    return { winner: 'Draw', reason: `Draw by rule on Board ${board}` };
  }
  return null;
}

function getActiveGamesList() {
  const list = [];
  for (const game of bughouseGames.values()) {
    if (game.status === 'active') {
      list.push({
        gameId: game.gameId,
        teamA: {
          captainName: game.teamA.captainName,
          partnerName: game.teamA.partnerName,
        },
        teamB: {
          captainName: game.teamB.captainName,
          partnerName: game.teamB.partnerName,
        },
      });
    }
  }
  return list;
}

function broadcastActiveGames(io) {
  io.to('bughouse_global').emit('bughouse_active_games', getActiveGamesList());
}

/**
 * Handles the teardown process when a Bughouse game finishes.
 * 
 * WHY: Prevents memory leaks and duplicate triggers by clearing clock intervals, 
 *      cancelling player forfeit grace timeouts, stripping O(1) indices, and deleting 
 *      the game reference from active RAM.
 * 
 * @param {Server} io     The Socket.IO server instance.
 * @param {Object} game   The active game state object.
 * @param {string} winner The winning team ('Team A' | 'Team B' | 'Draw').
 * @param {string} reason The ending context (e.g. Resignation, Flagged, Checkmate).
 */
function endBughouseGame(io, game, winner, reason) {
  if (game.status === 'ended') return;
  game.status = 'ended';
  game.winner = winner;

  if (game.clockInterval) {
    clearInterval(game.clockInterval);
    game.clockInterval = null;
  }

  if (game.disconnectedPlayers) {
    for (const userId in game.disconnectedPlayers) {
      if (game.disconnectedPlayers[userId].timeoutId) {
        clearTimeout(game.disconnectedPlayers[userId].timeoutId);
      }
    }
  }

  if (game.colors) {
    for (const userId in game.colors) {
      activePlayerGames.delete(userId);
    }
  }

  bughouseGames.delete(game.gameId);

  // AI-GENERATED WORKAROUND: Initialize rematch offer record with 90-second TTL to prevent memory leaks.
  const gameId = game.gameId;
  const timeoutId = setTimeout(() => {
    if (bughouseRematches.has(gameId)) {
      bughouseRematches.delete(gameId);
      io.to(`bughouse_game_${gameId}`).emit('bughouse_rematch_cancelled', { gameId });
      console.log(`[Bughouse] Rematch offer expired for game ${gameId}`);
    }
  }, 90000);

  bughouseRematches.set(gameId, {
    gameId,
    lobbyId1: game.teamA.captainId,
    lobbyId2: game.teamB.captainId,
    previousColors: game.colors,
    offers: new Set(),
    timeoutId,
  });

  io.to(`bughouse_game_${game.gameId}`).emit('bughouse_game_over', { gameId: game.gameId, winner, reason });
  console.log(`[Bughouse] Game ${game.gameId} ended — ${winner}: ${reason}`);
  broadcastActiveGames(io);
}

function leaveCurrentLobby(socket, io) {
  const userId = String(socket.userId);
  const lobbyId = activePlayersLobby.get(userId);
  if (!lobbyId) return;

  // AI-GENERATED WORKAROUND: Cancel and clean up any pending rematches associated with the leaving lobby.
  for (const [gameId, rematch] of bughouseRematches.entries()) {
    if (rematch.lobbyId1 === lobbyId || rematch.lobbyId2 === lobbyId) {
      if (rematch.timeoutId) {
        clearTimeout(rematch.timeoutId);
      }
      io.to(`bughouse_game_${gameId}`).emit('bughouse_rematch_cancelled', { gameId });
      bughouseRematches.delete(gameId);
      console.log(`[Bughouse] Rematch for game ${gameId} cancelled because lobby ${lobbyId} left.`);
    }
  }

  const lobby = bughouseLobbies.get(lobbyId);
  if (!lobby) return;

  if (lobby.lobbyId === userId) {
    console.log(`[Bughouse] Captain ${userId} left. Destroying lobby ${lobbyId}`);

    if (lobby.invitees) {
      for (const inviteeId of lobby.invitees) {
        const inviteeSocketId = activePlayers.get(String(inviteeId));
        if (inviteeSocketId) {
          io.to(inviteeSocketId).emit('bughouse_invite_cancelled', {
            lobbyId,
            senderId: userId,
          });
        }
      }
      lobby.invitees.clear();
    }
    if (lobby.inviteeList) {
      lobby.inviteeList = [];
    }

    if (lobby.partner) {
      const partnerId = String(lobby.partner.userId);
      const partnerSocketId = activePlayers.get(partnerId);
      activePlayersLobby.delete(partnerId);
      if (partnerSocketId) {
        const partnerSocket = io.sockets.sockets.get(partnerSocketId);
        if (partnerSocket) {
          partnerSocket.leave(`bughouse_lobby_${lobbyId}`);
          partnerSocket.emit('bughouse_lobby_sync', null);
        }
      }
    }

    bughouseLobbies.delete(lobbyId);
    bughouseQueue.delete(lobbyId);
    activePlayersLobby.delete(userId);
    socket.leave(`bughouse_lobby_${lobbyId}`);
    socket.emit('bughouse_lobby_sync', null);
  } else {
    console.log(`[Bughouse] Partner ${userId} left lobby ${lobbyId}`);
    lobby.partner = null;
    activePlayersLobby.delete(userId);
    socket.leave(`bughouse_lobby_${lobbyId}`);
    socket.emit('bughouse_lobby_sync', null);

    if (lobby.status === 'queued') {
      lobby.status = 'waiting';
      bughouseQueue.delete(lobbyId);
    }

    io.to(`bughouse_lobby_${lobbyId}`).emit('bughouse_lobby_sync', lobby);
  }
}

module.exports = {
  emptyPocket,
  applyDropToChess,
  transferCapture,
  checkGameOverOnChess,
  getActiveGamesList,
  broadcastActiveGames,
  endBughouseGame,
  leaveCurrentLobby,
};
