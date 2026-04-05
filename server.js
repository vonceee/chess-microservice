const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

// Import modular components
const config = require('./config');
const { games, activePlayers, matchmakingQueue, startBufferCountdown } = require('./game');
const { socketAuth } = require('./auth');
const { setupSocketHandlers } = require('./handlers');
const routes = require('./routes');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", // Configure for your frontend domain
    methods: ["GET", "POST"]
  }
});

// Export io for use in other modules
module.exports.io = io;



// Initialize authentication
socketAuth(io);







// Initialize socket handlers
setupSocketHandlers(io);
// Use routes
app.use('/api', routes);

// Cleanup function for server shutdown
function cleanupTimers() {
  const { clearAbandonmentTimer } = require('./abandonment');
  for (const [gameId, game] of games) {
    clearAbandonmentTimer(game, 'white');
    clearAbandonmentTimer(game, 'black');
    // Clear buffer timer
    if (game.bufferTimer) {
      clearInterval(game.bufferTimer);
      game.bufferTimer = null;
    }
  }
}

// Handle server shutdown
process.on('SIGINT', () => {
  cleanupTimers();
  process.exit(0);
});

process.on('SIGTERM', () => {
  cleanupTimers();
  process.exit(0);
});

// Start server
const PORT = process.env.PORT || 3006;
server.listen(PORT, () => {
  console.log(`Chess microservice listening on port ${PORT}`);
  console.log(`Environment: ${config.NODE_ENV}`);
  console.log(`API Base URL: ${config.API_BASE_URL || 'not configured'}`);
  console.log('Available endpoints: /api/create-game, /api/games/:id, /api/move, /api/resign, /api/draw, /api/abort, /api/sync-clock');
});