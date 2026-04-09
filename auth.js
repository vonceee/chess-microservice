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
        // Allow anonymous users (for TV spectators)
        socket.userId = 'guest_' + Math.random().toString(36).substring(7);
        socket.userName = 'Guest';
      } else if (providedUserId) {
        // For now, use provided credentials directly (token validation can be added later)
        // This works because the frontend provides userId and userName from authenticated session
        socket.userId = String(providedUserId);
        socket.userName = providedUserName || 'Anonymous';
      }

      if (socket.userId && !socket.userId.startsWith('guest_')) {
        // Store active player
        activePlayers.set(socket.userId, socket.id);
      }
      
      next();
    } catch (err) {
      console.log('Authentication error:', err.message);
      return next(new Error('Authentication error'));
    }
  });
}

module.exports = { socketAuth };