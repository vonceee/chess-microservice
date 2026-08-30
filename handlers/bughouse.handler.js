const { bughouseLobbies } = require('./bughouse/state');
const { registerLobbyHandlers } = require('./bughouse/lobby');
const { registerMatchmakerHandlers } = require('./bughouse/matchmaker');
const { registerGameplayHandlers } = require('./bughouse/gameplay');
const { registerSpectatorHandlers } = require('./bughouse/spectator');
const { handleJoin, handleDisconnect } = require('./bughouse/connection');

/**
 * Registers all Bughouse sub-handlers, invite synchronization hooks, 
 * and handles connection/disconnection lifecycle wiring.
 * 
 * WHY: Decoupled monolithic code into modular handlers to keep individual files single-purpose
 *      and maintainable while preserving Socket.IO reference scopes.
 * 
 * @param {Socket} socket  The client's socket connection.
 * @param {Server} io      The main Socket.IO server instance.
 * 
 * ASSUMPTIONS/EDGE CASES:
 * - Assumes the socket auth middleware has populated `socket.userId` and `socket.userName`.
 */
function setupBughouseHandlers(socket, io) {
  console.log(`[Bughouse] setupBughouseHandlers for user: ${socket.userId}, socket: ${socket.id}`);

  for (const [lobbyId, lobby] of bughouseLobbies.entries()) {
    const hasInvite = lobby.invitees && lobby.invitees.has(String(socket.userId));
    if (hasInvite) {
      socket.emit('bughouse_invite_received', {
        lobbyId,
        senderId: lobby.captain.userId,
        senderName: lobby.captain.userName,
      });
      console.log(`[Bughouse] Pushed existing invite from ${lobby.captain.userId} to newly connected user ${socket.userId}`);
    }
  }

  registerLobbyHandlers(socket, io);
  registerMatchmakerHandlers(socket, io);
  registerGameplayHandlers(socket, io);
  registerSpectatorHandlers(socket, io);

  socket.on('bughouse_join', () => handleJoin(socket, io));
  socket.on('disconnect', () => handleDisconnect(socket, io));
}

module.exports = { setupBughouseHandlers };
