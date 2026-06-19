const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

// Import modular components
const { socketAuth } = require('./auth');
const { setupSocketHandlers } = require('./handlers');

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

// Basic routes
app.get('/ping', (req, res) => res.json({ timestamp: new Date().toISOString() }));
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Fallback for /api/ping in case frontend uses the prefix
app.get('/api/ping', (req, res) => res.json({ timestamp: new Date().toISOString() }));
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

console.log('[Bootstrap] Setup complete. System ready.');

// Handle server shutdown
process.on('SIGINT', () => {
  process.exit(0);
});

process.on('SIGTERM', () => {
  process.exit(0);
});