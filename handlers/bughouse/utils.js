const { activePlayers } = require('../../active-players');
const { bughouseGames, bughouseLobbies, bughouseQueue, activePlayersLobby, activePlayerGames, bughouseRematches, declinedLobbies } = require('./state');

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

  if (game.teamA && game.teamA.captainId) {
    const lobbyA = bughouseLobbies.get(String(game.teamA.captainId));
    if (lobbyA) {
      lobbyA.status = 'waiting';
    }
  }
  if (game.teamB && game.teamB.captainId) {
    const lobbyB = bughouseLobbies.get(String(game.teamB.captainId));
    if (lobbyB) {
      lobbyB.status = 'waiting';
    }
  }

  const gameId = game.gameId;
  const silentCleanupId = setTimeout(() => {
    if (bughouseRematches.has(gameId)) {
      bughouseRematches.delete(gameId);
      console.log(`[Bughouse] Stale rematch record silently cleaned up for game ${gameId}`);
    }
  }, 30 * 60 * 1000);

  const teamA_capId = game.teamA ? String(game.teamA.captainId) : '';
  const teamA_partId = game.teamA && game.teamA.partnerId ? String(game.teamA.partnerId) : '';
  const teamB_capId = game.teamB ? String(game.teamB.captainId) : '';
  const teamB_partId = game.teamB && game.teamB.partnerId ? String(game.teamB.partnerId) : '';

  const seriesRound = game.seriesRound || 1;
  const seriesScore = game.seriesScore || { [teamA_capId]: 0, [teamB_capId]: 0 };
  if (winner === 'Team A' && teamA_capId) {
    seriesScore[teamA_capId] = (seriesScore[teamA_capId] || 0) + 1;
  } else if (winner === 'Team B' && teamB_capId) {
    seriesScore[teamB_capId] = (seriesScore[teamB_capId] || 0) + 1;
  }

  const lobby1Cooldown = (teamA_capId && declinedLobbies.get(teamA_capId)) || 0;
  const lobby2Cooldown = (teamB_capId && declinedLobbies.get(teamB_capId)) || 0;
  const activeCooldownUntil = Math.max(lobby1Cooldown, lobby2Cooldown);

  const allGamePlayers = Array.from(new Set([
    teamA_capId,
    teamA_partId,
    teamB_capId,
    teamB_partId,
    ...(game.colors ? Object.keys(game.colors).map(String) : [])
  ])).filter(Boolean);

  bughouseRematches.set(gameId, {
    gameId,
    prevGameId: game.rematchOf || null,
    seriesRound,
    seriesScore,
    lobbyId1: teamA_capId,
    lobbyId2: teamB_capId,
    allPlayers: allGamePlayers,
    teamAPlayers: [teamA_capId, teamA_partId].filter(Boolean),
    teamBPlayers: [teamB_capId, teamB_partId].filter(Boolean),
    previousColors: game.colors,
    offers: new Set(),
    offerTimeoutId: null,
    silentCleanupId,
    cooldownUntil: activeCooldownUntil > Date.now() ? activeCooldownUntil : 0,
    rateLimits: new Map(),
  });

  io.to(`bughouse_game_${game.gameId}`).emit('bughouse_game_over', {
    gameId: game.gameId,
    winner,
    reason,
    seriesRound,
    seriesScore,
    cooldownUntil: activeCooldownUntil > Date.now() ? activeCooldownUntil : 0,
  });
  console.log(`[Bughouse] Game ${game.gameId} ended — ${winner}: ${reason} (Series Round ${seriesRound})`);
  broadcastActiveGames(io);
}

function leaveCurrentLobby(socket, io) {
  const userId = String(socket.userId);
  const lobbyId = activePlayersLobby.get(userId);
  if (!lobbyId) return;

  declinedLobbies.delete(lobbyId);

  for (const [gameId, rematch] of bughouseRematches.entries()) {
    if (rematch.lobbyId1 === lobbyId || rematch.lobbyId2 === lobbyId) {
      if (rematch.offerTimeoutId) {
        clearTimeout(rematch.offerTimeoutId);
      }
      if (rematch.silentCleanupId) {
        clearTimeout(rematch.silentCleanupId);
      }
      if (rematch.offers.size > 0) {
        io.to(`bughouse_game_${gameId}`).emit('bughouse_rematch_cancelled', { gameId, reason: 'lobby_left' });
      }
      bughouseRematches.delete(gameId);
      console.log(`[Bughouse] Rematch for game ${gameId} cleaned up because lobby ${lobbyId} left.`);
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
