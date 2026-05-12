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
              name: data.name,
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
      name: arena.options.name || arenaId,
      timeControl: arena.options.timeControl,
      startTime: arena.startTime,
      endTime: arena.endTime, 
      isWaiting: arena.waitingRoom.has(socket.userId),
      status: arena.getStatus(),
      winner: arena.getWinner()
    });
    arena.broadcastLeaderboard();
    broadcastViewers(io, arenaId);
  });

  socket.on('start_pairing', (arenaId) => {
    const arena = arenas.get(arenaId);
    if (arena) {
      arena.join({ userId: socket.userId }, true);
      socket.emit('pairing_started', { arenaId });
      arena.broadcastLeaderboard();
      broadcastViewers(io, arenaId);
    }
  });

  socket.on('stop_pairing', (arenaId) => {
    const arena = arenas.get(arenaId);
    if (arena) {
      arena.leave(socket.userId);
      socket.emit('pairing_stopped', { arenaId });
      arena.broadcastLeaderboard();
      broadcastViewers(io, arenaId);
    }
  });

  socket.on('leave_arena', (arenaId) => {
    const arena = arenas.get(arenaId);
    if (arena) {
      arena.leave(socket.userId);
      socket.leave(`arena:${arenaId}`);
      broadcastViewers(io, arenaId);
    }
  });

  socket.on('arena_send_chat', (data) => {
    const { arenaId, text } = data;
    const arena = arenas.get(arenaId);
    if (!arena) return;

    const message = {
      text,
      senderName: socket.userName || 'Anonymous',
      senderId: socket.userId,
      timestamp: new Date().toISOString()
    };

    io.to(`arena:${arenaId}`).emit('arena_chat_message', message);
  });

  socket.on('disconnecting', async () => {
    for (const room of socket.rooms) {
      if (room.startsWith('arena:')) {
        const arenaId = room.split(':')[1];
        // We need a slight delay or use to(room).emit to reach others before we're fully gone
        const sockets = await io.in(room).fetchSockets();
        if (sockets) {
          const uniqueViewers = new Map();
          for (const s of sockets) {
            if (s.id === socket.id) continue;
            const uId = s.data?.userId || s.userId;
            const uName = s.data?.userName || s.userName;
            if (uName && uId) {
              uniqueViewers.set(uId, uName);
            }
          }
          const viewers = Array.from(uniqueViewers.values());
          socket.to(room).emit('viewer_list_update', { 
            arenaId, 
            viewers, 
            count: sockets.length - 1 
          });
        }
      }
    }
  });
}

async function broadcastViewers(io, arenaId) {
  const roomId = `arena:${arenaId}`;
  try {
    const sockets = await io.in(roomId).fetchSockets();
    
    if (!sockets || sockets.length === 0) {
      return;
    }

    const uniqueViewers = new Map(); // userId -> userName
    for (const s of sockets) {
      const uId = s.data?.userId || s.userId;
      const uName = s.data?.userName || s.userName;
      if (uName && uId) {
        uniqueViewers.set(uId, uName);
      }
    }

    const viewers = Array.from(uniqueViewers.values());
    io.to(roomId).emit('viewer_list_update', { 
      arenaId, 
      viewers, 
      count: sockets.length 
    });
  } catch (err) {
    console.error('[Arena] broadcastViewers error:', err);
  }
}

module.exports = { setupArenaHandlers };
