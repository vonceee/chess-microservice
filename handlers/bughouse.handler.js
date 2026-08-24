// chess.js v0.12 uses CommonJS require
const Chess = require('chess.js').Chess;
const { activePlayers } = require('../active-players');

// ── In-memory stores ─────────────────────────────────────────────────────────

/** lobbyId (captain's userId) → lobby state */
const bughouseLobbies = new Map();
/** Set of lobbyIds currently searching for a match */
const bughouseQueue = new Set();
/** Quick lookup: userId → lobbyId */
const activePlayersLobby = new Map();

/**
 * gameId → {
 *   gameId, teamA, teamB,
 *   colors: { [userId]: { board: 'A'|'B', color: 'w'|'b' } },
 *   chessA, chessB,           ← server-side chess.js instances
 *   pockets: {
 *     A_W, A_B, B_W, B_B     ← Record<pieceType, count>
 *   },
 *   clocks: { A_W, A_B, B_W, B_B },  ← remaining seconds
 *   status: 'active' | 'ended',
 *   winner: null | 'Team A' | 'Team B' | 'Draw',
 *   clockInterval: null,
 * }
 */
const bughouseGames = new Map();

const DEFAULT_TIME = 300; // 5 minutes
const PIECE_TYPES  = ['p', 'n', 'b', 'r', 'q'];

// ── Utility ───────────────────────────────────────────────────────────────────

function emptyPocket() {
  return { p: 0, n: 0, b: 0, r: 0, q: 0 };
}

/**
 * Apply a pocket-drop FEN manipulation identical to the frontend approach.
 * chess.put() places the piece but doesn't flip the active turn.
 * We must mutate the raw FEN string to flip it.
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

/**
 * Transfer a captured piece to the capturing player's partner's pocket.
 * Board A: white captures → partner (Board B black) gains piece
 *          black captures → partner (Board B white) gains piece
 * Board B: white captures → partner (Board A black) gains piece
 *          black captures → partner (Board A white) gains piece
 */
function transferCapture(pockets, board, capturerColor, piece) {
  // Piece reverts to pawn if promoted queen was captured (chess.js already handles this)
  // In standard bughouse, promoted pieces revert to pawns when captured.
  const normalised = piece === 'q' ? 'q' : piece; // keep queens for now — full revert is a stretch goal
  if (board === 'A') {
    if (capturerColor === 'w') pockets.B_B[normalised]++;
    else                        pockets.B_W[normalised]++;
  } else {
    if (capturerColor === 'w') pockets.A_B[normalised]++;
    else                        pockets.A_W[normalised]++;
  }
}

function checkGameOverOnChess(chess, board, game) {
  if (chess.in_checkmate()) {
    // The side to move is in checkmate, so the OTHER side wins
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

/**
 * End a game: stop the clock, persist winner, emit game_over to all 4 clients.
 */
function endBughouseGame(io, game, winner, reason) {
  if (game.status === 'ended') return;
  game.status = 'ended';
  game.winner = winner;

  if (game.clockInterval) {
    clearInterval(game.clockInterval);
    game.clockInterval = null;
  }

  io.to(`bughouse_game_${game.gameId}`).emit('bughouse_game_over', { winner, reason });
  console.log(`[Bughouse] Game ${game.gameId} ended — ${winner}: ${reason}`);
}

// ── Handler setup ─────────────────────────────────────────────────────────────

function setupBughouseHandlers(socket, io) {
  console.log(`[Bughouse] setupBughouseHandlers for user: ${socket.userId}, socket: ${socket.id}`);
  // Push any existing active invites to this user upon connecting
  for (const [lobbyId, lobby] of bughouseLobbies.entries()) {
    const hasInvite = lobby.invitees && lobby.invitees.has(String(socket.userId));
    console.log(`[Bughouse] Checking lobby ${lobbyId}. Captain: ${lobby.captain.userId}. Invitees set contains user ${socket.userId}? ${hasInvite}`);
    if (hasInvite) {
      socket.emit('bughouse_invite_received', {
        lobbyId,
        senderId:   lobby.captain.userId,
        senderName: lobby.captain.userName,
      });
      console.log(`[Bughouse] Pushed existing invite from ${lobby.captain.userId} to newly connected user ${socket.userId}`);
    }
  }

  // 1. User joins the Bughouse page: sync their current lobby if any
  socket.on('bughouse_sync_invites', () => {
    console.log(`[Bughouse] Received bughouse_sync_invites from user: ${socket.userId}`);
    for (const [lobbyId, lobby] of bughouseLobbies.entries()) {
      const hasInvite = lobby.invitees && lobby.invitees.has(String(socket.userId));
      if (hasInvite) {
        socket.emit('bughouse_invite_received', {
          lobbyId,
          senderId:   lobby.captain.userId,
          senderName: lobby.captain.userName,
        });
        console.log(`[Bughouse] Synced active invite from ${lobby.captain.userId} to user ${socket.userId}`);
      }
    }
  });
  socket.on('bughouse_join', () => {
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
  });

  // 2. Captain creates a lobby (when inviting or opening lobby)
  socket.on('bughouse_create_lobby', () => {
    const lobbyId = String(socket.userId);

    leaveCurrentLobby(socket, io);

    const lobby = {
      lobbyId,
      captain: { userId: socket.userId, userName: socket.userName, rating: 1600 },
      partner: null,
      status:  'waiting',
    };

    bughouseLobbies.set(lobbyId, lobby);
    activePlayersLobby.set(String(socket.userId), lobbyId);
    socket.join(`bughouse_lobby_${lobbyId}`);
    socket.emit('bughouse_lobby_sync', lobby);
    console.log(`[Bughouse] Lobby created by captain ${socket.userId}`);
  });

  // 3. Captain sends an invite to another player
  socket.on('bughouse_invite_player', (data) => {
    const { receiverId, receiverName } = data;
    const lobbyId = String(socket.userId);

    let lobby = bughouseLobbies.get(lobbyId);
    if (!lobby) {
      lobby = {
        lobbyId,
        captain: { userId: socket.userId, userName: socket.userName, rating: 1600 },
        partner: null,
        status:  'waiting',
        invitees: new Set(),
      };
      bughouseLobbies.set(lobbyId, lobby);
      activePlayersLobby.set(String(socket.userId), lobbyId);
      socket.join(`bughouse_lobby_${lobbyId}`);
    }

    if (!lobby.invitees) {
      lobby.invitees = new Set();
    }
    lobby.invitees.add(String(receiverId));

    const receiverSocketId = activePlayers.get(String(receiverId));
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('bughouse_invite_received', {
        lobbyId,
        senderId:   socket.userId,
        senderName: socket.userName,
      });
      console.log(`[Bughouse] Live invite sent from ${socket.userId} to ${receiverId}`);
    } else {
      console.log(`[Bughouse] Receiver ${receiverId} offline — database fallback handles notification.`);
    }
  });

  // 4. Invitee accepts the invite
  socket.on('bughouse_accept_invite', (data) => {
    const { lobbyId } = data;
    const lobby = bughouseLobbies.get(String(lobbyId));

    if (!lobby) {
      socket.emit('bughouse_error', 'Lobby no longer exists.');
      return;
    }
    if (lobby.partner) {
      socket.emit('bughouse_error', 'Lobby is already full.');
      return;
    }

    leaveCurrentLobby(socket, io);

    // Cancel all other invitations for this lobby
    if (lobby.invitees) {
      for (const inviteeId of lobby.invitees) {
        if (String(inviteeId) === String(socket.userId)) continue;
        const inviteeSocketId = activePlayers.get(String(inviteeId));
        if (inviteeSocketId) {
          io.to(inviteeSocketId).emit('bughouse_invite_cancelled', {
            lobbyId,
            senderId: lobby.captain.userId,
          });
        }
      }
      lobby.invitees.clear();
    }

    lobby.partner = { userId: socket.userId, userName: socket.userName, rating: 1600 };
    activePlayersLobby.set(String(socket.userId), String(lobbyId));
    socket.join(`bughouse_lobby_${lobbyId}`);

    io.to(`bughouse_lobby_${lobbyId}`).emit('bughouse_lobby_sync', lobby);
    console.log(`[Bughouse] User ${socket.userId} joined lobby ${lobbyId} as partner`);
  });

  // 5. Invitee rejects or Captain cancels the invite
  socket.on('bughouse_reject_invite', (data) => {
    const { lobbyId } = data;
    const lobby = bughouseLobbies.get(String(lobbyId));
    if (lobby && lobby.invitees) {
      lobby.invitees.delete(String(socket.userId));
    }

    const captainSocketId = activePlayers.get(String(lobbyId));
    if (captainSocketId) {
      io.to(captainSocketId).emit('bughouse_invite_rejected', { inviteeName: socket.userName });
    }
  });

  socket.on('bughouse_kick_partner', () => {
    const lobbyId = String(socket.userId);
    const lobby = bughouseLobbies.get(lobbyId);

    if (lobby && lobby.partner) {
      const partnerId = String(lobby.partner.userId);
      lobby.partner = null;
      activePlayersLobby.delete(partnerId);

      const partnerSocketId = activePlayers.get(partnerId);
      if (partnerSocketId) {
        const partnerSocket = io.sockets.sockets.get(partnerSocketId);
        if (partnerSocket) {
          partnerSocket.leave(`bughouse_lobby_${lobbyId}`);
          partnerSocket.emit('bughouse_kicked');
          partnerSocket.emit('bughouse_lobby_sync', null);
        }
      }

      io.to(`bughouse_lobby_${lobbyId}`).emit('bughouse_lobby_sync', lobby);
      console.log(`[Bughouse] Captain ${socket.userId} kicked partner ${partnerId}`);
    }
  });

  // 7. User leaves lobby
  socket.on('bughouse_leave_lobby', () => {
    leaveCurrentLobby(socket, io);
  });

  // 8. Captain starts queuing for matchmaking
  socket.on('bughouse_join_queue', () => {
    const lobbyId = String(socket.userId);
    const lobby = bughouseLobbies.get(lobbyId);

    if (lobby && lobby.partner && lobby.status === 'waiting') {
      lobby.status = 'queued';
      bughouseQueue.add(lobbyId);
      io.to(`bughouse_lobby_${lobbyId}`).emit('bughouse_lobby_sync', lobby);
      console.log(`[Bughouse] Lobby ${lobbyId} joined matchmaking queue`);

      checkAndMatchLobbies(io);
    }
  });

  // 9. Captain cancels matchmaking queue
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

  // ── Gameplay ──────────────────────────────────────────────────────────────

  // 10. Client reports a regular chess move
  socket.on('bughouse_move', (data) => {
    const { gameId, board, move, fen } = data;
    const game = bughouseGames.get(gameId);
    if (!game || game.status !== 'active') return;

    const myUserId  = String(socket.userId);
    const colorInfo = game.colors[myUserId];
    if (!colorInfo || colorInfo.board !== board) return; // wrong board

    const chess = board === 'A' ? game.chessA : game.chessB;

    // Validate it is this player's turn
    if (chess.turn() !== colorInfo.color) {
      console.warn(`[Bughouse] Out-of-turn move attempt by ${myUserId}`);
      return;
    }

    // Load the FEN the client sent (it already validated the move locally)
    chess.load(fen);

    // Handle pocket transfer if there was a capture
    let pocketUpdate = null;
    if (move.captured) {
      const piece = move.captured;
      transferCapture(game.pockets, board, move.color, piece);
      pocketUpdate = { board, capturedBy: move.color, piece };
    }

    // Broadcast to all 4 clients in the game room
    io.to(`bughouse_game_${gameId}`).emit('bughouse_move_broadcast', {
      gameId,
      board,
      fen:          chess.fen(),
      move,
      pocketUpdate,
      pockets:      game.pockets,   // full authoritative pocket state
      senderId:     myUserId,
    });

    // Check game-over
    const over = checkGameOverOnChess(chess, board, game);
    if (over) {
      endBughouseGame(io, game, over.winner, over.reason);
    }
  });

  // 11. Client reports a pocket drop
  socket.on('bughouse_drop', (data) => {
    const { gameId, board, piece, square, color } = data;
    const game = bughouseGames.get(gameId);
    if (!game || game.status !== 'active') return;

    const myUserId  = String(socket.userId);
    const colorInfo = game.colors[myUserId];
    if (!colorInfo || colorInfo.board !== board || colorInfo.color !== color) return;

    const chess = board === 'A' ? game.chessA : game.chessB;

    // Validate turn
    if (chess.turn() !== color) return;

    // Validate pocket count
    const pocketKey = `${board}_${color.toUpperCase()}`;
    const pocket = game.pockets[pocketKey];
    if (!pocket || pocket[piece] <= 0) return;

    // Validate square is empty
    if (chess.get(square)) return;

    // Validate pawn rank rule
    if (piece === 'p') {
      const rank = square[1];
      if (rank === '1' || rank === '8') return;
    }

    // Apply the drop (mutate FEN to flip turn, as chess.js doesn't natively support drops)
    const newFen = applyDropToChess(chess, piece, color, square);

    // Decrement pocket
    pocket[piece] = Math.max(0, pocket[piece] - 1);

    const moveSan = `${piece.toUpperCase() === 'P' ? '' : piece.toUpperCase()}@${square}`;

    // Broadcast
    io.to(`bughouse_game_${gameId}`).emit('bughouse_move_broadcast', {
      gameId,
      board,
      fen:    newFen,
      move:   { san: moveSan, flags: 'd', color, captured: null },
      pocketUpdate: null,    // drop doesn't generate a capture
      pockets: game.pockets, // full authoritative state
      senderId: myUserId,
    });

    // Check game-over (e.g. drop causes checkmate)
    const over = checkGameOverOnChess(chess, board, game);
    if (over) {
      endBughouseGame(io, game, over.winner, over.reason);
    }
  });

  // 12. Player resigns
  socket.on('bughouse_resign', (data) => {
    const { gameId } = data;
    const game = bughouseGames.get(gameId);
    if (!game || game.status !== 'active') return;

    const myUserId  = String(socket.userId);
    const colorInfo = game.colors[myUserId];
    if (!colorInfo) return;

    // Determine losing team from the resigning player's board & color
    let losingTeam;
    const isTeamA =
      String(game.teamA.captainId) === myUserId ||
      String(game.teamA.partnerId) === myUserId;
    losingTeam = isTeamA ? 'Team A' : 'Team B';
    const winner = losingTeam === 'Team A' ? 'Team B' : 'Team A';

    endBughouseGame(io, game, winner, `${socket.userName} resigned`);
  });

  // ── Disconnect ────────────────────────────────────────────────────────────

  socket.on('disconnect', () => {
    // If this player is in an active game, the other team wins by forfeit
    const myUserId = String(socket.userId);

    for (const [gameId, game] of bughouseGames) {
      if (game.status !== 'active') continue;
      const colorInfo = game.colors[myUserId];
      if (!colorInfo) continue;

      const isTeamA =
        String(game.teamA.captainId) === myUserId ||
        String(game.teamA.partnerId) === myUserId;
      const winner = isTeamA ? 'Team B' : 'Team A';

      // Notify remaining players before ending
      io.to(`bughouse_game_${gameId}`).emit('bughouse_opponent_disconnected', {
        playerName: socket.userName,
      });

      endBughouseGame(io, game, winner, `${socket.userName} disconnected`);
      break;
    }
  });
}

// ── Lobby leave helper ────────────────────────────────────────────────────────

function leaveCurrentLobby(socket, io) {
  const userId  = String(socket.userId);
  const lobbyId = activePlayersLobby.get(userId);
  if (!lobbyId) return;

  const lobby = bughouseLobbies.get(lobbyId);
  if (!lobby) return;

  if (lobby.lobbyId === userId) {
    // Captain leaves: destroy entire lobby
    console.log(`[Bughouse] Captain ${userId} left. Destroying lobby ${lobbyId}`);

    // Cancel all pending invitations
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

    if (lobby.partner) {
      const partnerId       = String(lobby.partner.userId);
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
    // Partner leaves
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

// ── Matchmaking ───────────────────────────────────────────────────────────────

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

  lobby1.status = 'matched';
  lobby2.status = 'matched';

  console.log(`[Matchmaking] Matched team ${lobbyId1} with team ${lobbyId2}`);

  // ── Random color assignment ──────────────────────────────────────────────
  // Flip a coin: if 0, lobby1 captain is White on Board A; if 1, lobby2 captain is White.
  const flip = Math.random() < 0.5 ? 0 : 1;

  let whiteA_id, blackA_id, blackB_id, whiteB_id;
  let teamA_captainId, teamA_partnerId, teamB_captainId, teamB_partnerId;
  let teamA_captainName, teamA_partnerName, teamB_captainName, teamB_partnerName;

  if (flip === 0) {
    // lobby1 = Team A (White Board A / Black Board B)
    // lobby2 = Team B (Black Board A / White Board B)
    whiteA_id  = String(lobby1.captain.userId);
    blackB_id  = String(lobby1.partner.userId);
    blackA_id  = String(lobby2.captain.userId);
    whiteB_id  = String(lobby2.partner.userId);

    teamA_captainId   = String(lobby1.captain.userId);
    teamA_partnerId   = String(lobby1.partner.userId);
    teamA_captainName = lobby1.captain.userName;
    teamA_partnerName = lobby1.partner.userName;
    teamB_captainId   = String(lobby2.captain.userId);
    teamB_partnerId   = String(lobby2.partner.userId);
    teamB_captainName = lobby2.captain.userName;
    teamB_partnerName = lobby2.partner.userName;
  } else {
    // lobby2 = Team A (White Board A / Black Board B)
    // lobby1 = Team B (Black Board A / White Board B)
    whiteA_id  = String(lobby2.captain.userId);
    blackB_id  = String(lobby2.partner.userId);
    blackA_id  = String(lobby1.captain.userId);
    whiteB_id  = String(lobby1.partner.userId);

    teamA_captainId   = String(lobby2.captain.userId);
    teamA_partnerId   = String(lobby2.partner.userId);
    teamA_captainName = lobby2.captain.userName;
    teamA_partnerName = lobby2.partner.userName;
    teamB_captainId   = String(lobby1.captain.userId);
    teamB_partnerId   = String(lobby1.partner.userId);
    teamB_captainName = lobby1.captain.userName;
    teamB_partnerName = lobby1.partner.userName;
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
    clocks:  { ...initialClocks },
    status:  'active',
    winner:  null,
    clockInterval: null,
  };

  bughouseGames.set(gameId, game);

  // Move all 4 sockets into a shared game room
  const gameRoom = `bughouse_game_${gameId}`;
  const allUserIds = [teamA_captainId, teamA_partnerId, teamB_captainId, teamB_partnerId];
  for (const uid of allUserIds) {
    const socketId = activePlayers.get(uid);
    if (socketId) {
      const s = io.sockets.sockets.get(socketId);
      if (s) s.join(gameRoom);
    }
  }

  // Build per-player game_start payloads (each player needs opponent info)
  const startPayload = {
    gameId,
    colors,
    teamA: { captainName: teamA_captainName, partnerId: teamA_partnerId, partnerName: teamA_partnerName, captainId: teamA_captainId },
    teamB: { captainName: teamB_captainName, partnerId: teamB_partnerId, partnerName: teamB_partnerName, captainId: teamB_captainId },
    boardAFen:   chessA.fen(),
    boardBFen:   chessB.fen(),
    pockets:     game.pockets,
    clocks:      initialClocks,
    timeControl: DEFAULT_TIME,
  };

  // Send individual game_start to each player with their personal board/color assignment.
  // This avoids any client-side userId key-lookup mismatch.
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

  // Also broadcast matched info (for the countdown screen that still runs)
  io.to(`bughouse_lobby_${lobbyId1}`).emit('bughouse_matched', {
    opponent1: { name: teamB_captainName, rating: 1600 },
    opponent2: { name: teamB_partnerName, rating: 1600 },
  });
  io.to(`bughouse_lobby_${lobbyId2}`).emit('bughouse_matched', {
    opponent1: { name: teamA_captainName, rating: 1600 },
    opponent2: { name: teamA_partnerName, rating: 1600 },
  });

  // ── Server-side clock (1-second authority tick) ───────────────────────────
  // Delay by 5.5 s to allow the client countdown to finish before ticking.
  setTimeout(() => {
    if (game.status !== 'active') return;
    game.clockInterval = setInterval(() => {
      if (game.status !== 'active') {
        clearInterval(game.clockInterval);
        return;
      }

    const clocks = game.clocks;
    const turnA  = game.chessA.turn(); // 'w' or 'b'
    const turnB  = game.chessB.turn();

    // Decrement active clocks
    if (turnA === 'w') { clocks.A_W = Math.max(0, clocks.A_W - 1); }
    else               { clocks.A_B = Math.max(0, clocks.A_B - 1); }
    if (turnB === 'w') { clocks.B_W = Math.max(0, clocks.B_W - 1); }
    else               { clocks.B_B = Math.max(0, clocks.B_B - 1); }

    io.to(gameRoom).emit('bughouse_clock_tick', { clocks });

    // Flag check
    if (clocks.A_W <= 0) { endBughouseGame(io, game, 'Team B', 'Board A White flagged'); }
    else if (clocks.A_B <= 0) { endBughouseGame(io, game, 'Team A', 'Board A Black flagged'); }
    else if (clocks.B_W <= 0) { endBughouseGame(io, game, 'Team A', 'Board B White flagged'); }
    else if (clocks.B_B <= 0) { endBughouseGame(io, game, 'Team B', 'Board B Black flagged'); }
    }, 1000);
  }, 5500); // 5.5 s delay matches the client-side countdown

  console.log(`[Bughouse] Game ${gameId} started. Colors: WhiteA=${whiteA_id} BlackA=${blackA_id} WhiteB=${whiteB_id} BlackB=${blackB_id}`);
}

module.exports = { setupBughouseHandlers };
