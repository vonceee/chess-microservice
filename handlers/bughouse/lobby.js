const { activePlayers } = require('../../active-players');
const { bughouseLobbies, activePlayersLobby, bughouseQueue } = require('./state');
const { leaveCurrentLobby } = require('./utils');

function registerLobbyHandlers(socket, io) {
  socket.on('bughouse_sync_invites', () => {
    console.log(`[Bughouse] Received bughouse_sync_invites from user: ${socket.userId}`);
    for (const [lobbyId, lobby] of bughouseLobbies.entries()) {
      const hasInvite = lobby.invitees && lobby.invitees.has(String(socket.userId));
      if (hasInvite) {
        socket.emit('bughouse_invite_received', {
          lobbyId,
          senderId: lobby.captain.userId,
          senderName: lobby.captain.userName,
        });
        console.log(`[Bughouse] Synced active invite from ${lobby.captain.userId} to user ${socket.userId}`);
      }
    }
  });

  socket.on('bughouse_create_lobby', () => {
    const lobbyId = String(socket.userId);
    leaveCurrentLobby(socket, io);

    const lobby = {
      lobbyId,
      captain: { userId: socket.userId, userName: socket.userName, rating: 1600 },
      partner: null,
      status: 'waiting',
      variant: 'cannibal',
    };

    bughouseLobbies.set(lobbyId, lobby);
    activePlayersLobby.set(String(socket.userId), lobbyId);
    socket.join(`bughouse_lobby_${lobbyId}`);
    socket.emit('bughouse_lobby_sync', lobby);
    console.log(`[Bughouse] Lobby created by captain ${socket.userId}`);
  });

  socket.on('bughouse_set_variant', (data) => {
    const lobbyId = String(socket.userId);
    const lobby = bughouseLobbies.get(lobbyId);
    if (!lobby || String(lobby.captain.userId) !== String(socket.userId)) return;
    lobby.variant = data.variant === 'standard' ? 'standard' : 'cannibal';
    io.to(`bughouse_lobby_${lobbyId}`).emit('bughouse_lobby_sync', lobby);
  });

  socket.on('bughouse_invite_player', (data) => {
    const { receiverId, receiverName } = data;
    const lobbyId = String(socket.userId);

    if (String(receiverId) === String(socket.userId)) {
      socket.emit('bughouse_error', 'You cannot invite yourself.');
      return;
    }

    let lobby = bughouseLobbies.get(lobbyId);
    if (!lobby) {
      lobby = {
        lobbyId,
        captain: { userId: socket.userId, userName: socket.userName, rating: 1600 },
        partner: null,
        status: 'waiting',
        invitees: new Set(),
        inviteeList: [],
      };
      bughouseLobbies.set(lobbyId, lobby);
      activePlayersLobby.set(String(socket.userId), lobbyId);
      socket.join(`bughouse_lobby_${lobbyId}`);
    }

    if (!lobby.invitees) {
      lobby.invitees = new Set();
    }
    lobby.invitees.add(String(receiverId));

    if (!lobby.inviteeList) {
      lobby.inviteeList = [];
    }
    if (!lobby.inviteeList.some(i => String(i.userId) === String(receiverId))) {
      lobby.inviteeList.push({ userId: String(receiverId), userName: receiverName });
    }

    io.to(`bughouse_lobby_${lobbyId}`).emit('bughouse_lobby_sync', lobby);

    const receiverSocketId = activePlayers.get(String(receiverId));
    if (receiverSocketId) {
      io.to(receiverSocketId).emit('bughouse_invite_received', {
        lobbyId,
        senderId: socket.userId,
        senderName: socket.userName,
      });
      console.log(`[Bughouse] Live invite sent from ${socket.userId} to ${receiverId}`);
    } else {
      console.log(`[Bughouse] Receiver ${receiverId} offline — database fallback handles notification.`);
    }
  });

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
    if (lobby.inviteeList) {
      lobby.inviteeList = [];
    }

    lobby.partner = { userId: socket.userId, userName: socket.userName, rating: 1600 };
    activePlayersLobby.set(String(socket.userId), String(lobbyId));
    socket.join(`bughouse_lobby_${lobbyId}`);

    io.to(`bughouse_lobby_${lobbyId}`).emit('bughouse_lobby_sync', lobby);
    console.log(`[Bughouse] User ${socket.userId} joined lobby ${lobbyId} as partner`);
  });

  socket.on('bughouse_reject_invite', (data) => {
    const { lobbyId } = data;
    const lobby = bughouseLobbies.get(String(lobbyId));
    if (lobby) {
      if (lobby.invitees) {
        lobby.invitees.delete(String(socket.userId));
      }
      if (lobby.inviteeList) {
        lobby.inviteeList = lobby.inviteeList.filter(i => String(i.userId) !== String(socket.userId));
      }
      io.to(`bughouse_lobby_${lobbyId}`).emit('bughouse_lobby_sync', lobby);
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

  socket.on('bughouse_leave_lobby', () => {
    leaveCurrentLobby(socket, io);
  });
}

module.exports = { registerLobbyHandlers };
