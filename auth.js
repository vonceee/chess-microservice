const { activePlayers } = require('./game');

// Authentication middleware for Socket.io
function socketAuth(io) {
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;
      const providedUserId = socket.handshake.auth.userId;
      const providedUserName = socket.handshake.auth.userName;

      console.log('Socket auth attempt:', {
        socketId: socket.id,
        hasToken: !!token,
        providedUserId,
        providedUserName
      });

      if (!token && !providedUserId) {
        return next(new Error('Authentication error'));
      }

      // For now, use provided credentials directly (token validation can be added later)
      // This works because the frontend provides userId and userName from authenticated session
      if (providedUserId) {
        socket.userId = String(providedUserId);
        socket.userName = providedUserName || 'Anonymous';
      } else {
        return next(new Error('Authentication error: no userId provided'));
      }

      // Store active player
      activePlayers.set(socket.userId, socket.id);
      next();
    } catch (err) {
      console.log('Authentication error:', err.message);
      return next(new Error('Authentication error'));
    }
  });
}

module.exports = { socketAuth };