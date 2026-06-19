const { setupStudyHandlers } = require('./study.handler');
const { activePlayers } = require('../active-players');

function setupSocketHandlers(io) {
  io.on('connection', (socket) => {
    // Basic account tracking
    activePlayers.set(socket.userId, socket.id);

    // Notify all clients about user presence
    io.emit('presence_update', { userId: socket.userId, online: true });

    // Wire up modular handlers (Only Study is kept)
    setupStudyHandlers(socket, io);

    // Global disconnection handler
    socket.on('disconnect', () => {
      // Remove from active players only if this is the active socket for the user
      if (activePlayers.get(socket.userId) === socket.id) {
        activePlayers.delete(socket.userId);
        // Notify all clients about user presence
        io.emit('presence_update', { userId: socket.userId, online: false });
      }
    });
  });
}

module.exports = { setupSocketHandlers };
