const { arenas, Arena } = require('../arena');
const config = require('../config');
const axios = require('axios');
const pendingInitializations = new Map(); // arenaId -> Promise

function setupArenaHandlers(socket, io) {
  socket.on('join_arena', async (dataFromClient) => {
    const { arenaId, name, rating } = dataFromClient;
    if (!arenaId) return;

    let arena = arenas.get(arenaId);
    
    if (!arena) {
      // Check if already being initialized
      if (pendingInitializations.has(arenaId)) {
        await pendingInitializations.get(arenaId);
        arena = arenas.get(arenaId);
      } else {
        const initPromise = (async () => {
          try {
            const response = await axios.get(`${config.API_BASE_URL}/api/arenas/${arenaId}`);
            const data = response.data.data || response.data;
            
            let durationMinutes = data.durationMinutes || 60;
            let timeControl = data.timeControl || '3+0';

            let initialTimeMs = 180000;
            let incrementMs = 0;
            if (timeControl) {
              const parts = timeControl.split('+');
              if (parts.length >= 1) initialTimeMs = parseInt(parts[0]) * 1000;
              if (parts.length >= 2) incrementMs = parseInt(parts[1]) * 1000;
            }

            const newArena = new Arena(arenaId, {
              timeControl, 
              durationMinutes, 
              initialTimeMs, 
              incrementMs,
              startsAt: data.start_date
            });
            arenas.set(arenaId, newArena);
          } catch (err) {
            console.error(`[Arena] Fetch error for URL: ${config.API_BASE_URL}/api/arenas/${arenaId}`, err.message);
            socket.emit('error', 'Failed to fetch arena details');
            throw err;
          } finally {
            pendingInitializations.delete(arenaId);
          }
        })();

        pendingInitializations.set(arenaId, initPromise);
        try {
          await initPromise;
          arena = arenas.get(arenaId);
        } catch (err) {
          return;
        }
      }
    }

    socket.join(`arena:${arenaId}`);
    arena.join({ userId: socket.userId, name: name || 'Guest', rating: rating || 1500 }, false);
    socket.emit('arena_joined', { 
      arenaId, 
      startTime: arena.startTime,
      endTime: arena.endTime, 
      isWaiting: arena.waitingRoom.has(socket.userId),
      status: arena.getStatus(),
      winner: arena.getWinner()
    });
    arena.broadcastLeaderboard();
  });

  socket.on('start_pairing', (arenaId) => {
    const arena = arenas.get(arenaId);
    if (arena) {
      arena.join({ userId: socket.userId }, true);
      socket.emit('pairing_started', { arenaId });
      arena.broadcastLeaderboard();
    }
  });

  socket.on('stop_pairing', (arenaId) => {
    const arena = arenas.get(arenaId);
    if (arena) {
      arena.leave(socket.userId);
      socket.emit('pairing_stopped', { arenaId });
      arena.broadcastLeaderboard();
    }
  });

  socket.on('leave_arena', (arenaId) => {
    const arena = arenas.get(arenaId);
    if (arena) {
      arena.leave(socket.userId);
      socket.leave(`arena:${arenaId}`);
    }
  });
}

module.exports = { setupArenaHandlers };
