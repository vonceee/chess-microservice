const { arenas, Arena } = require('../arena');
const config = require('../config');

function setupArenaHandlers(socket, io) {
  socket.on('join_arena', async (dataFromClient) => {
    const { arenaId, name, rating } = dataFromClient;
    if (!arenaId) return;

    let arena = arenas.get(arenaId);
    
    if (!arena) {
      try {
        const dt = await fetch(`${config.API_BASE_URL}/api/tournaments/${arenaId}`);
        if (!dt.ok) throw new Error('Backend error');
        const responseJson = await dt.json();
        const data = responseJson.data || responseJson;
        
        let durationMinutes = 60;
        let timeControl = data.timeControl || '3+0';

        if (data.schedule && data.schedule.length > 0 && data.schedule[0].durationMinutes) {
          durationMinutes = data.schedule[0].durationMinutes;
        }

        let initialTimeMs = 180000;
        let incrementMs = 0;
        if (timeControl) {
          const parts = timeControl.split('+');
          if (parts.length >= 1) initialTimeMs = parseInt(parts[0]) * 1000;
          if (parts.length >= 2) incrementMs = parseInt(parts[1]) * 1000;
        }

        arena = new Arena(arenaId, {
          timeControl, durationMinutes, initialTimeMs, incrementMs
        });
        arenas.set(arenaId, arena);
      } catch (err) {
        console.error('[Arena] Fetch error:', err);
        socket.emit('error', 'Failed to fetch arena details');
        return;
      }
    }

    socket.join(`arena:${arenaId}`);
    arena.join({ userId: socket.userId, name: name || 'Guest', rating: rating || 1500 }, false);
    socket.emit('arena_joined', { arenaId, endTime: arena.endTime, isWaiting: false });
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
