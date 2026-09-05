const crypto = require('crypto');
const Chess = require('chess.js').Chess;
const { activePlayers } = require('../../active-players');
const { bughouseLobbies, bughouseQueue, bughouseGames, activePlayerGames, bughouseRematches, declinedLobbies, activePlayersLobby } = require('./state');
const { emptyPocket, endBughouseGame, broadcastActiveGames } = require('./utils');

const DEFAULT_TIME = 300;

function registerMatchmakerHandlers(socket, io) {
  socket.on('bughouse_join_queue', () => {
    const lobbyId = String(socket.userId);
    const lobby = bughouseLobbies.get(lobbyId);

    if (lobby && lobby.partner && (lobby.status === 'waiting' || lobby.status === 'matched')) {
      for (const [gameId, rematch] of bughouseRematches.entries()) {
        if (rematch.lobbyId1 === lobbyId || rematch.lobbyId2 === lobbyId) {
          if (rematch.offerTimeoutId) {
            clearTimeout(rematch.offerTimeoutId);
          }
          if (rematch.silentCleanupId) {
            clearTimeout(rematch.silentCleanupId);
          }
          if (rematch.offers.size > 0) {
            io.to(`bughouse_game_${gameId}`).emit('bughouse_rematch_cancelled', { gameId, reason: 'joined_queue' });
          }
          bughouseRematches.delete(gameId);
          // console.log(`[Bughouse] Rematch for game ${gameId} cleaned up as lobby ${lobbyId} joined public queue.`);
        }
      }

      lobby.status = 'queued';
      bughouseQueue.add(lobbyId);
      io.to(`bughouse_lobby_${lobbyId}`).emit('bughouse_lobby_sync', lobby);
      // console.log(`[Bughouse] Lobby ${lobbyId} joined matchmaking queue`);

      checkAndMatchLobbies(io);
    }
  });

  /**
   * Cancels matchmaking queue for the current lobby.
   * 
   * WHY: Enables both lobby host (captain) and teammate (partner) to abort matchmaking search
   *      without forcing the partner to abandon/leave the lobby.
   */
  socket.on('bughouse_cancel_queue', () => {
    const userId = String(socket.userId);
    let lobbyId = activePlayersLobby.get(userId) || userId;
    let lobby = bughouseLobbies.get(lobbyId);

    if (!lobby) {
      for (const [id, l] of bughouseLobbies.entries()) {
        if (String(l.captain?.userId) === userId || String(l.partner?.userId) === userId) {
          lobbyId = id;
          lobby = l;
          break;
        }
      }
    }

    if (lobby && lobby.status === 'queued') {
      const isParticipant = String(lobby.captain?.userId) === userId || String(lobby.partner?.userId) === userId;
      if (isParticipant) {
        lobby.status = 'waiting';
        bughouseQueue.delete(lobbyId);
        io.to(`bughouse_lobby_${lobbyId}`).emit('bughouse_lobby_sync', lobby);
        io.to(`bughouse_lobby_${lobbyId}`).emit('bughouse_queue_cancelled', {
          cancelledByUserId: userId,
          cancelledByName: socket.userName,
        });
        console.log(`[Bughouse] Matchmaking search cancelled by user ${socket.userName} (${userId}) for lobby ${lobbyId}`);
      }
    }
  });

  function broadcastRematchEvent(io, rematch, eventName, payload) {
    if (!rematch) return;
    const gameId = rematch.gameId;

    // console.log(`[Bughouse Rematch] broadcastRematchEvent: ${eventName}`, {
    //   gameId,
    //   lobby1: rematch.lobbyId1,
    //   lobby2: rematch.lobbyId2,
    //   offers: payload.offers,
    // });

    io.to(`bughouse_game_${gameId}`).emit(eventName, payload);

    if (rematch.lobbyId1) io.to(`bughouse_lobby_${rematch.lobbyId1}`).emit(eventName, payload);
    if (rematch.lobbyId2) io.to(`bughouse_lobby_${rematch.lobbyId2}`).emit(eventName, payload);

    const allPlayerIds = Array.from(new Set([
      ...(rematch.allPlayers || []),
      ...(rematch.teamAPlayers || []),
      ...(rematch.teamBPlayers || []),
      rematch.lobbyId1,
      rematch.lobbyId2,
    ])).filter(Boolean).map(String);

    for (const pId of allPlayerIds) {
      const sId = activePlayers.get(pId) || activePlayers.get(Number(pId));
      if (sId) {
        io.to(sId).emit(eventName, payload);
      }
    }

    if (io.sockets && io.sockets.sockets) {
      try {
        const socketEntries = typeof io.sockets.sockets.entries === 'function'
          ? Array.from(io.sockets.sockets.entries())
          : Object.entries(io.sockets.sockets);

        for (const [socketId, s] of socketEntries) {
          const sUid = s.userId || (s.data && s.data.userId);
          if (sUid && allPlayerIds.includes(String(sUid))) {
            s.join(`bughouse_game_${gameId}`);
            s.emit(eventName, payload);
            console.log(`[Bughouse Rematch] Delivered ${eventName} directly to user ${sUid} on socket ${socketId}`);
          }
        }
      } catch (err) {
        console.error('[Bughouse Rematch] Error during socket traversal:', err);
      }
    }
  }

  function handleRematchYes(socket, io, data) {
    const { gameId } = data || {};
    const rematch = bughouseRematches.get(gameId);
    if (!rematch) {
      socket.emit('bughouse_error', 'Rematch offer has expired or is invalid.');
      return;
    }

    socket.join(`bughouse_game_${gameId}`);

    const userId = String(socket.userId);
    let userLobbyId = null;
    let opponentPlayers = [];

    const isCaptainA = (userId === String(rematch.lobbyId1));
    const isCaptainB = (userId === String(rematch.lobbyId2));

    if (!isCaptainA && !isCaptainB) {
      socket.emit('bughouse_error', 'Only team captains can offer or accept a rematch.');
      return;
    }

    if (isCaptainA) {
      userLobbyId = String(rematch.lobbyId1);
      opponentPlayers = rematch.teamBPlayers || [];
    } else {
      userLobbyId = String(rematch.lobbyId2);
      opponentPlayers = rematch.teamAPlayers || [];
    }

    const opponentOnline = opponentPlayers.some(id => activePlayers.has(String(id)));
    if (!opponentOnline) {
      socket.emit('bughouse_error', 'Opponent team is offline.');
      return;
    }

    const lobbyCooldown = declinedLobbies.get(userLobbyId) || 0;
    const matchCooldown = rematch.cooldownUntil || 0;
    const activeCooldown = Math.max(lobbyCooldown, matchCooldown);
    if (activeCooldown && Date.now() < activeCooldown) {
      const remainingSecs = Math.ceil((activeCooldown - Date.now()) / 1000);
      socket.emit('bughouse_error', `Please wait ${remainingSecs}s before offering a rematch again.`);
      return;
    }

    const now = Date.now();
    if (!rematch.rateLimits) rematch.rateLimits = new Map();
    const timestamps = (rematch.rateLimits.get(userLobbyId) || []).filter(t => now - t < 60000);
    if (timestamps.length >= 2) {
      socket.emit('bughouse_error', 'Rematch offers rate-limited (max 2 per minute).');
      return;
    }
    timestamps.push(now);
    rematch.rateLimits.set(userLobbyId, timestamps);

    rematch.offers.add(userLobbyId);

    if (rematch.offers.size === 1) {
      if (rematch.offerTimeoutId) {
        clearTimeout(rematch.offerTimeoutId);
      }
      const OFFER_TIMEOUT_MS = 60000;
      rematch.offerTimeoutId = setTimeout(() => {
        if (bughouseRematches.has(gameId)) {
          const currentRematch = bughouseRematches.get(gameId);
          if (currentRematch.offers.size === 1) {
            currentRematch.offers.clear();
            currentRematch.offerTimeoutId = null;
            broadcastRematchEvent(io, currentRematch, 'bughouse_rematch_offer_expired', {
              gameId,
              message: 'Rematch offer expired (no response).',
            });
            broadcastRematchEvent(io, currentRematch, 'bughouse_rematch_status', {
              gameId,
              offers: [],
              seriesRound: currentRematch.seriesRound,
            });
            console.log(`[Bughouse] Rematch offer for game ${gameId} expired due to no response.`);
          }
        }
      }, OFFER_TIMEOUT_MS);
    }

    broadcastRematchEvent(io, rematch, 'bughouse_rematch_status', {
      gameId,
      offers: Array.from(rematch.offers),
      seriesRound: rematch.seriesRound,
    });

    // console.log(`[Bughouse] Team ${userLobbyId} offered/accepted rematch for game ${gameId}`);

    if (rematch.offers.size === 2) {
      if (rematch.offerTimeoutId) {
        clearTimeout(rematch.offerTimeoutId);
        rematch.offerTimeoutId = null;
      }
      if (rematch.silentCleanupId) {
        clearTimeout(rematch.silentCleanupId);
        rematch.silentCleanupId = null;
      }
      bughouseRematches.delete(gameId);

      const lobby1 = bughouseLobbies.get(rematch.lobbyId1);
      const lobby2 = bughouseLobbies.get(rematch.lobbyId2);

      createBughouseMatch(io, lobby1, lobby2, rematch.previousColors, {
        prevGameId: gameId,
        seriesRound: rematch.seriesRound,
        seriesScore: rematch.seriesScore,
      });
    }
  }

  function handleRematchNo(socket, io, data) {
    const { gameId } = data || {};
    const rematch = bughouseRematches.get(gameId);
    if (!rematch) return;

    socket.join(`bughouse_game_${gameId}`);

    const userId = String(socket.userId);
    const isCaptainA = (userId === String(rematch.lobbyId1));
    const isCaptainB = (userId === String(rematch.lobbyId2));

    if (!isCaptainA && !isCaptainB) {
      socket.emit('bughouse_error', 'Only team captains can decline or cancel a rematch.');
      return;
    }

    const userLobbyId = isCaptainA ? String(rematch.lobbyId1) : String(rematch.lobbyId2);

    if (rematch.offerTimeoutId) {
      clearTimeout(rematch.offerTimeoutId);
      rematch.offerTimeoutId = null;
    }

    if (rematch.offers.has(userLobbyId) && rematch.offers.size === 1) {
      rematch.offers.clear();
      broadcastRematchEvent(io, rematch, 'bughouse_rematch_status', {
        gameId,
        offers: [],
        seriesRound: rematch.seriesRound,
      });
      broadcastRematchEvent(io, rematch, 'bughouse_rematch_cancelled', {
        gameId,
        reason: 'cancelled_by_team',
      });
      console.log(`[Bughouse] Rematch offer for game ${gameId} was cancelled by offerer team ${userLobbyId}`);
      return;
    }

    rematch.offers.clear();
    const COOLDOWN_MS = 60000;
    const cooldownUntil = Date.now() + COOLDOWN_MS;
    rematch.cooldownUntil = cooldownUntil;

    declinedLobbies.set(String(rematch.lobbyId1), cooldownUntil);
    declinedLobbies.set(String(rematch.lobbyId2), cooldownUntil);

    broadcastRematchEvent(io, rematch, 'bughouse_rematch_declined', {
      gameId,
      declinedBy: userId,
      cooldownMs: COOLDOWN_MS,
      cooldownUntil,
    });
    broadcastRematchEvent(io, rematch, 'bughouse_rematch_status', {
      gameId,
      offers: [],
      seriesRound: rematch.seriesRound,
    });

    console.log(`[Bughouse] Rematch offer for game ${gameId} declined by team ${userLobbyId}. 60s cooldown applied.`);
  }

  socket.on('bughouse_rematch_yes', (data) => handleRematchYes(socket, io, data));
  socket.on('bughouse_offer_rematch', (data) => handleRematchYes(socket, io, data));

  socket.on('bughouse_rematch_no', (data) => handleRematchNo(socket, io, data));
  socket.on('bughouse_decline_rematch', (data) => handleRematchNo(socket, io, data));
  socket.on('bughouse_cancel_rematch', (data) => handleRematchNo(socket, io, data));
}

function checkAndMatchLobbies(io) {
  if (bughouseQueue.size < 2) return;

  const iterator = bughouseQueue.values();
  const lobbyId1 = iterator.next().value;
  const lobbyId2 = iterator.next().value;

  bughouseQueue.delete(lobbyId1);
  bughouseQueue.delete(lobbyId2);

  const lobby1 = bughouseLobbies.get(lobbyId1);
  const lobby2 = bughouseLobbies.get(lobbyId2);

  if (!lobby1 || !lobby2) return;

  createBughouseMatch(io, lobby1, lobby2);
}

/**
 * Initializes and starts a Bughouse game between two lobbies.
 * Alternates board colors if a previous match state is provided.
 * 
 * WHY: Extracted from checkAndMatchLobbies to allow direct re-matching 
 *      bypassing the public matchmaking queue, with validation and board color alternation.
 * 
 * @param {Server} io                 The Socket.IO server.
 * @param {Object} lobby1             The first team lobby.
 * @param {Object} lobby2             The second team lobby.
 * @param {Object|null} previousColors Optional colors assignment from the previous game to alternate.
 */
function createBughouseMatch(io, lobby1, lobby2, previousColors = null, rematchMeta = null) {
  if (!lobby1 || !lobby2) return;
  if (!lobby1.partner || !lobby2.partner) return;

  const players = [
    String(lobby1.captain.userId),
    String(lobby1.partner.userId),
    String(lobby2.captain.userId),
    String(lobby2.partner.userId),
  ];
  for (const uid of players) {
    if (activePlayerGames.has(uid)) {
      // console.log(`[Matchmaking] Cannot create match: Player ${uid} is already in an active game.`);
      return;
    }
  }

  lobby1.status = 'matched';
  lobby2.status = 'matched';

  const lobbyId1 = lobby1.lobbyId;
  const lobbyId2 = lobby2.lobbyId;

  console.log(`[Matchmaking] Matching team ${lobbyId1} with team ${lobbyId2}`);

  let whiteA_id, blackA_id, blackB_id, whiteB_id;
  let teamA_captainId, teamA_partnerId, teamB_captainId, teamB_partnerId;
  let teamA_captainName, teamA_partnerName, teamB_captainName, teamB_partnerName;

  if (previousColors) {
    const players = [
      String(lobby1.captain.userId),
      String(lobby1.partner.userId),
      String(lobby2.captain.userId),
      String(lobby2.partner.userId),
    ];
    const colors = {};
    for (const uid of players) {
      const prev = previousColors[uid];
      if (prev) {
        colors[uid] = {
          board: prev.board,
          color: prev.color === 'w' ? 'b' : 'w',
        };
      }
    }

    for (const uid in colors) {
      const assignment = colors[uid];
      if (assignment.board === 'A' && assignment.color === 'w') whiteA_id = uid;
      if (assignment.board === 'A' && assignment.color === 'b') blackA_id = uid;
      if (assignment.board === 'B' && assignment.color === 'w') whiteB_id = uid;
      if (assignment.board === 'B' && assignment.color === 'b') blackB_id = uid;
    }

    teamA_captainId = String(lobby1.captain.userId);
    teamA_partnerId = String(lobby1.partner.userId);
    teamA_captainName = lobby1.captain.userName;
    teamA_partnerName = lobby1.partner.userName;
    teamB_captainId = String(lobby2.captain.userId);
    teamB_partnerId = String(lobby2.partner.userId);
    teamB_captainName = lobby2.captain.userName;
    teamB_partnerName = lobby2.partner.userName;
  } else {
    const flip = Math.random() < 0.5 ? 0 : 1;
    if (flip === 0) {
      whiteA_id = String(lobby1.captain.userId);
      blackB_id = String(lobby1.partner.userId);
      blackA_id = String(lobby2.captain.userId);
      whiteB_id = String(lobby2.partner.userId);

      teamA_captainId = String(lobby1.captain.userId);
      teamA_partnerId = String(lobby1.partner.userId);
      teamA_captainName = lobby1.captain.userName;
      teamA_partnerName = lobby1.partner.userName;
      teamB_captainId = String(lobby2.captain.userId);
      teamB_partnerId = String(lobby2.partner.userId);
      teamB_captainName = lobby2.captain.userName;
      teamB_partnerName = lobby2.partner.userName;
    } else {
      whiteA_id = String(lobby2.captain.userId);
      blackB_id = String(lobby2.partner.userId);
      blackA_id = String(lobby1.captain.userId);
      whiteB_id = String(lobby1.partner.userId);

      teamA_captainId = String(lobby2.captain.userId);
      teamA_partnerId = String(lobby2.partner.userId);
      teamA_captainName = lobby2.captain.userName;
      teamA_partnerName = lobby2.partner.userName;
      teamB_captainId = String(lobby1.captain.userId);
      teamB_partnerId = String(lobby1.partner.userId);
      teamB_captainName = lobby1.captain.userName;
      teamB_partnerName = lobby1.partner.userName;
    }
  }

  const colors = {
    [whiteA_id]: { board: 'A', color: 'w' },
    [blackA_id]: { board: 'A', color: 'b' },
    [blackB_id]: { board: 'B', color: 'b' },
    [whiteB_id]: { board: 'B', color: 'w' },
  };

  const cryptoSuffix = crypto.randomBytes(4).toString('hex');
  const gameId = `${lobbyId1}_${lobbyId2}_${cryptoSuffix}`;
  const chessA = new Chess();
  const chessB = new Chess();

  const initialClocks = { A_W: DEFAULT_TIME, A_B: DEFAULT_TIME, B_W: DEFAULT_TIME, B_B: DEFAULT_TIME };
  const variant = lobby1.variant || lobby2.variant || 'cannibal';

  const seriesRound = rematchMeta ? (rematchMeta.seriesRound || 1) + 1 : 1;
  const seriesScore = rematchMeta?.seriesScore || { [teamA_captainId]: 0, [teamB_captainId]: 0 };
  const rematchOf = rematchMeta?.prevGameId || null;

  const game = {
    gameId,
    rematchOf,
    seriesRound,
    seriesScore,
    variant,
    teamA: { captainId: teamA_captainId, partnerId: teamA_partnerId, captainName: teamA_captainName, partnerName: teamA_partnerName },
    teamB: { captainId: teamB_captainId, partnerId: teamB_partnerId, captainName: teamB_captainName, partnerName: teamB_partnerName },
    colors,
    chessA,
    chessB,
    pockets: { A_W: emptyPocket(), A_B: emptyPocket(), B_W: emptyPocket(), B_B: emptyPocket() },
    clocks: { ...initialClocks },
    status: 'active',
    winner: null,
    clockInterval: null,
    disconnectedPlayers: {},
    reconnectGraceMs: 45000,
    movesHistory: [],
  };

  bughouseGames.set(gameId, game);

  const gameRoom = `bughouse_game_${gameId}`;
  const allUserIds = [teamA_captainId, teamA_partnerId, teamB_captainId, teamB_partnerId];
  for (const uid of allUserIds) {
    activePlayerGames.set(uid, gameId);
    const socketId = activePlayers.get(uid);
    if (socketId) {
      const s = io.sockets.sockets.get(socketId);
      if (s) s.join(gameRoom);
    }
  }

  if (rematchOf) {
    const takenPayload = {
      prevGameId: rematchOf,
      nextGameId: gameId,
      seriesRound,
      seriesScore,
    };
    io.to(`bughouse_game_${rematchOf}`).emit('bughouse_rematch_taken', takenPayload);
    for (const uid of allUserIds) {
      const socketId = activePlayers.get(uid);
      if (socketId) {
        io.to(socketId).emit('bughouse_rematch_taken', takenPayload);
      }
    }
    io.to(`bughouse_lobby_${lobbyId1}`).emit('bughouse_rematch_taken', takenPayload);
    io.to(`bughouse_lobby_${lobbyId2}`).emit('bughouse_rematch_taken', takenPayload);
    console.log(`[Bughouse] Emitted bughouse_rematch_taken: ${rematchOf} -> ${gameId} (Round ${seriesRound})`);
  }

  const startPayload = {
    gameId,
    rematchOf,
    seriesRound,
    seriesScore,
    variant,
    colors,
    teamA: { captainName: teamA_captainName, partnerId: teamA_partnerId, partnerName: teamA_partnerName, captainId: teamA_captainId },
    teamB: { captainName: teamB_captainName, partnerId: teamB_partnerId, partnerName: teamB_partnerName, captainId: teamB_captainId },
    boardAFen: chessA.fen(),
    boardBFen: chessB.fen(),
    pockets: game.pockets,
    clocks: initialClocks,
    timeControl: DEFAULT_TIME,
    movesHistory: [],
  };

  for (const uid of allUserIds) {
    const socketId = activePlayers.get(uid);
    if (socketId) {
      io.to(socketId).emit('bughouse_game_start', {
        ...startPayload,
        yourBoard: colors[uid].board,
        yourColor: colors[uid].color,
      });
    }
  }

  io.to(`bughouse_lobby_${lobbyId1}`).emit('bughouse_matched', {
    opponent1: { name: lobby2.captain.userName, rating: 1600 },
    opponent2: { name: lobby2.partner.userName, rating: 1600 },
  });
  io.to(`bughouse_lobby_${lobbyId2}`).emit('bughouse_matched', {
    opponent1: { name: lobby1.captain.userName, rating: 1600 },
    opponent2: { name: lobby1.partner.userName, rating: 1600 },
  });

  setTimeout(() => {
    if (game.status !== 'active') return;
    game.clockInterval = setInterval(() => {
      if (game.status !== 'active') {
        clearInterval(game.clockInterval);
        return;
      }

      const clocks = game.clocks;
      const turnA = game.chessA.turn();
      const turnB = game.chessB.turn();

      if (turnA === 'w') { clocks.A_W = Math.max(0, clocks.A_W - 1); }
      else { clocks.A_B = Math.max(0, clocks.A_B - 1); }
      if (turnB === 'w') { clocks.B_W = Math.max(0, clocks.B_W - 1); }
      else { clocks.B_B = Math.max(0, clocks.B_B - 1); }

      io.to(gameRoom).emit('bughouse_clock_tick', { gameId: game.gameId, clocks });

      if (clocks.A_W <= 0) { endBughouseGame(io, game, 'Team B', 'Board A White flagged'); }
      else if (clocks.A_B <= 0) { endBughouseGame(io, game, 'Team A', 'Board A Black flagged'); }
      else if (clocks.B_W <= 0) { endBughouseGame(io, game, 'Team A', 'Board B White flagged'); }
      else if (clocks.B_B <= 0) { endBughouseGame(io, game, 'Team B', 'Board B Black flagged'); }
    }, 1000);
  }, 5500);

  console.log(`[Bughouse] Game ${gameId} started. Colors: WhiteA=${whiteA_id} BlackA=${blackA_id} WhiteB=${whiteB_id} BlackB=${blackB_id}`);
  broadcastActiveGames(io);
}

module.exports = { registerMatchmakerHandlers, checkAndMatchLobbies, createBughouseMatch };
