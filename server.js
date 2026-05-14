const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');

// Import modular components
const config = require('./config');
const { games, activePlayers, matchmakingQueue } = require('./game');
const { socketAuth } = require('./auth');
const { setupSocketHandlers } = require('./handlers');
const routes = require('./routes');
const { initTvDirector } = require('./tv');

const app = express();
app.use(cors());
const server = http.createServer(app);

// START LISTENING IMMEDIATELY
// This prevents "Port scan timeout" on Render while modules load
const PORT = process.env.PORT || 3006;
server.listen(PORT, () => {
  console.log(`[Bootstrap] Chess microservice listening on port ${PORT}`);
  console.log(`[Bootstrap] Binding successful. Initializing modules...`);
});

const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

// Export io for use in other modules
module.exports.io = io;

console.log('[Bootstrap] Initializing authentication...');
socketAuth(io);







// Initialize socket handlers
console.log('[Bootstrap] Setting up socket handlers...');
setupSocketHandlers(io);

// Initialize TV director
console.log('[Bootstrap] Initializing TV director...');
initTvDirector(io);

// Basic routes
app.get('/ping', (req, res) => res.json({ timestamp: new Date().toISOString() }));
app.get('/health', (req, res) => res.json({ status: 'ok', activeGames: games.size }));

// API routes prefix
console.log('[Bootstrap] Mounting routes...');
app.use('/api', routes);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('[Error] Unhandled request error:', {
    message: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
    body: req.body
  });
  res.status(500).json({ 
    message: 'Internal Server Error',
    error: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});
// Fallback for /api/ping in case frontend uses the prefix
app.get('/api/ping', (req, res) => res.json({ timestamp: new Date().toISOString() }));
app.get('/api/health', (req, res) => res.json({ status: 'ok', activeGames: games.size }));

console.log('[Bootstrap] Setup complete. System ready.');

// Cleanup function for server shutdown
function cleanupTimers() {
  const { clearAbandonmentTimer } = require('./abandonment');
  for (const [gameId, game] of games) {
    clearAbandonmentTimer(game, 'white');
    clearAbandonmentTimer(game, 'black');
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

// Start server moved to top for early binding