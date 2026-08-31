const Chess = require('chess.js').Chess;
const { activePlayers } = require('../../active-players');
const { bughouseLobbies, bughouseQueue, bughouseGames, activePlayerGames, bughouseRematches } = require('./state');
const { emptyPocket, endBughouseGame, broadcastActiveGames } = require('./utils');

const DEFAULT_TIME = 300;

function registerMatchmakerHandlers(socket, io) {
  socket.on('bughouse_join_queue', () => {
    const lobbyId = String(socket.userId);
    const lobby = bughouseLobbies.get(lobbyId);

    // Allow matched lobbies to join queue (e.g. after a game has ended)
    if (lobby && lobby.partner && (lobby.status === 'waiting' || lobby.status === 'matched')) {
      // AI-GENERATED WORKAROUND: Cancel and clean up any pending rematches if this lobby queues up.
      for (const [gameId, rematch] of bughouseRematches.entries()) {
        if (rematch.lobbyId1 === lobbyId || rematch.lobbyId2 === lobbyId) {
          if (rematch.timeoutId) {
            clearTimeout(rematch.timeoutId);
          }
          io.to(`bughouse_game_${gameId}`).emit('bughouse_rematch_cancelled', { gameId });
          bughouseRematches.delete(gameId);
          console.log(`[Bughouse] Rematch cancelled for game ${gameId} as lobby ${lobbyId} joined public queue.`);
        }
      }

      lobby.status = 'queued';
      bughouseQueue.add(lobbyId);
      io.to(`bughouse_lobby_${lobbyId}`).emit('bughouse_lobby_sync', lobby);
      console.log(`[Bughouse] Lobby ${lobbyId} joined matchmaking queue`);

      checkAndMatchLobbies(io);
    }
  });

  socket.on('bughouse_cancel_queue', () => {
    const lobbyId = String(socket.userId);
    const lobby = bughouseLobbies.get(lobbyId);

    if (lobby && lobby.status === 'queued') {
      lobby.status = 'waiting';
      bughouseQueue.delete(lobbyId);
      io.to(`bughouse_lobby_${lobbyId}`).emit('bughouse_lobby_sync', lobby);
      console.log(`[Bughouse] Lobby ${lobbyId} left matchmaking queue`);
    }
  });

  // AI-GENERATED WORKAROUND: Handle the bughouse_offer_rematch event from team captains.
  /**
   * Handles rematch offers from players at the end of a game.
   * 
   * WHY: Enables O(1) checks to match the same two teams immediately, 
   *      bypassing the random matchmaking queue.
   */
  socket.on('bughouse_offer_rematch', (data) => {
    const { gameId } = data;
    const rematch = bughouseRematches.get(gameId);
    if (!rematch) {
      socket.emit('bughouse_error', 'Rematch offer has expired or is invalid.');
      return;
    }

    const userId = String(socket.userId);
    let userLobbyId = null;

    // Verify the user is the host/captain of their team
    if (userId === rematch.lobbyId1) {
      userLobbyId = rematch.lobbyId1;
    } else if (userId === rematch.lobbyId2) {
      userLobbyId = rematch.lobbyId2;
    }

    if (!userLobbyId) {
      socket.emit('bughouse_error', 'Only team captains can offer a rematch.');
      return;
    }

    rematch.offers.add(userLobbyId);
    io.to(`bughouse_game_${gameId}`).emit('bughouse_rematch_status', {
      gameId,
      offers: Array.from(rematch.offers),
    });

    console.log(`[Bughouse] Team ${userLobbyId} offered rematch for game ${gameId}`);

    if (rematch.offers.size === 2) {
      if (rematch.timeoutId) {
        clearTimeout(rematch.timeoutId);
      }
      bughouseRematches.delete(gameId);

      const lobby1 = bughouseLobbies.get(rematch.lobbyId1);
      const lobby2 = bughouseLobbies.get(rematch.lobbyId2);

      createBughouseMatch(io, lobby1, lobby2, rematch.previousColors);
    }
  });

  socket.on('bughouse_decline_rematch', (data) => {
    const { gameId } = data;
    const rematch = bughouseRematches.get(gameId);
    if (!rematch) return;

    const userId = String(socket.userId);
    if (userId === rematch.lobbyId1 || userId === rematch.lobbyId2) {
      if (rematch.timeoutId) {
        clearTimeout(rematch.timeoutId);
      }
      bughouseRematches.delete(gameId);
      io.to(`bughouse_game_${gameId}`).emit('bughouse_rematch_cancelled', { gameId });
      console.log(`[Bughouse] Rematch for game ${gameId} was cancelled/declined by ${userId}`);
    }
  });
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
function createBughouseMatch(io, lobby1, lobby2, previousColors = null) {
  // ATOMIC STATE CHECK: Ensure both lobbies exist, are not currently in an active game, and have partners.
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
      console.log(`[Matchmaking] Cannot create match: Player ${uid} is already in an active game.`);
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
    // BUGHOUSE RULE: Invert color assignments for the rematch so players alternate colors
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

    // Resolve IDs based on inverted colors
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

  const gameId = `${lobbyId1}_${lobbyId2}`;
  const chessA = new Chess();
  const chessB = new Chess();

  const initialClocks = { A_W: DEFAULT_TIME, A_B: DEFAULT_TIME, B_W: DEFAULT_TIME, B_B: DEFAULT_TIME };

  const game = {
    gameId,
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

  const startPayload = {
    gameId,
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
    opponent1: { name: teamB_captainName, rating: 1600 },
    opponent2: { name: teamB_partnerName, rating: 1600 },
  });
  io.to(`bughouse_lobby_${lobbyId2}`).emit('bughouse_matched', {
    opponent1: { name: teamA_captainName, rating: 1600 },
    opponent2: { name: teamA_partnerName, rating: 1600 },
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
