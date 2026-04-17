const config = require('./config');
// require('./game') is loaded locally to avoid circular dependencies

let io = null;
function setIo(_io) {
  io = _io;
}

class Arena {
  constructor(id, options = {}) {
    this.id = id;
    this.participants = new Map(); // userId -> { score, streak, rating, name, lastOpponentId }
    this.waitingRoom = new Set(); // Set of userIds
    this.activeGames = new Map(); // gameId -> { whiteId, blackId }
    this.options = {
      pairingInterval: options.pairingInterval || 2000,
      timeControl: options.timeControl || '3+0',
      initialTimeMs: options.initialTimeMs || 180000,
      incrementMs: options.incrementMs || 0,
      durationMinutes: options.durationMinutes || 60,
      ...options
    };

    this.startTime = options.startsAt ? new Date(options.startsAt).getTime() : Date.now();
    this.endTime = this.startTime + (this.options.durationMinutes * 60 * 1000);
    
    // Pairing timer starts only if arena is ongoing
    this.pairingTimer = null;
    this.scheduleLifecycle();
  }

  scheduleLifecycle() {
    const now = Date.now();
    
    // 1. Schedule Start
    if (now >= this.startTime && now < this.endTime) {
      this.startPairing();
    } else if (now < this.startTime) {
      const startDelay = this.startTime - now;
      console.log(`[Arena] Scheduling start for ${this.id} in ${startDelay}ms`);
      setTimeout(() => this.startPairing(), startDelay);
    }

    // 2. Schedule End
    if (now < this.endTime) {
      const endDelay = this.endTime - now;
      console.log(`[Arena] lifecycle: ${this.id} ends at ${new Date(this.endTime).toISOString()} (in ${endDelay}ms)`);
      setTimeout(() => this.end(), endDelay);
    } else {
      console.log(`[Arena] lifecycle: ${this.id} is already PAST. now=${new Date(now).toISOString()}, end=${new Date(this.endTime).toISOString()}`);
      this.end();
    }
  }

  startPairing() {
    if (!this.pairingTimer) {
      console.log(`[Arena] Starting pairing for ${this.id}.`);
      this.pairingTimer = setInterval(() => this.pairPlayers(), this.options.pairingInterval);
      if (io) io.to(`arena:${this.id}`).emit('arena_started', { arenaId: this.id });
    }
  }

  join(user, wait = false) {
    if (!this.participants.has(user.userId)) {
      this.participants.set(user.userId, {
        userId: user.userId,
        name: user.name,
        rating: user.rating || 1500,
        score: 0,
        streak: 0,
        lastOpponentId: null,
        isWaiting: false
      });
    }
    
    if (wait) {
      this.waitingRoom.add(user.userId);
      this.participants.get(user.userId).isWaiting = true;
    }
  }

  getStatus() {
    const now = Date.now();
    if (now < this.startTime) return 'upcoming';
    if (now >= this.endTime) return 'past';
    return 'ongoing';
  }

  getWinner() {
    if (this.participants.size === 0) return null;
    const sorted = Array.from(this.participants.values())
      .sort((a, b) => b.score - a.score || b.rating - a.rating);
    return sorted[0].name;
  }

  leave(userId) {
    this.waitingRoom.delete(userId);
    const p = this.participants.get(userId);
    if (p) p.isWaiting = false;
  }

  async pairPlayers() {
    if (this.waitingRoom.size < 2) return;

    // Get all waiting players and their data
    const waitingPlayers = Array.from(this.waitingRoom)
      .map(userId => this.participants.get(userId))
      .filter(p => p !== undefined);

    // Sort by Arena Score (primary) and Rating (secondary)
    waitingPlayers.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.rating - a.rating;
    });

    const pairs = [];
    const paired = new Set();

    for (let i = 0; i < waitingPlayers.length; i++) {
      if (paired.has(waitingPlayers[i].userId)) continue;

      let bestMatchIdx = -1;
      for (let j = i + 1; j < waitingPlayers.length; j++) {
        if (paired.has(waitingPlayers[j].userId)) continue;

        bestMatchIdx = j;
        break;
      }

      // If no valid match found (due to rematch safety), and we have other candidates, 
      // we might just skip this player this cycle or pick the next one if it's the only option.
      // For V1, if no match found that isn't a rematch, we skip to next cycle.
      if (bestMatchIdx !== -1) {
        const p1 = waitingPlayers[i];
        const p2 = waitingPlayers[bestMatchIdx];
        pairs.push([p1, p2]);
        paired.add(p1.userId);
        paired.add(p2.userId);
        
        // Strictly sync isWaiting status
        p1.isWaiting = false;
        p2.isWaiting = false;
        console.log(`[Arena] Paired ${p1.name} with ${p2.name} for arena ${this.id}`);
      }
    }

    // Create games for pairs
    for (const [p1, p2] of pairs) {
      this.waitingRoom.delete(p1.userId);
      this.waitingRoom.delete(p2.userId);

      // Inform Laravel to register the match in the DB
      let gameId;
      try {
        const payload = JSON.stringify({
          white_id: p1.userId,
          black_id: p2.userId,
          arena_id: this.id,
          time_control: this.options.timeControl
        });

        // Use a more robust way to call Laravel that doesn't depend on Node 18 fetch
        gameId = await this.syncMatchToLaravel(payload);
      } catch (err) {
        console.error('[Arena] Failed to sync match to Laravel:', err);
        gameId = Math.random().toString(36).substring(2, 11);
      }
      
      // Update last opponent
      p1.lastOpponentId = p2.userId;
      p2.lastOpponentId = p1.userId;

      // Randomize colors locally for the microservice logic
      const isP1White = Math.random() < 0.5;
      const whitePlayer = isP1White ? p1 : p2;
      const blackPlayer = isP1White ? p2 : p1;

      const gameData = {
        gameId,
        arenaId: this.id,
        whitePlayer: { userId: whitePlayer.userId, name: whitePlayer.name, rating: whitePlayer.rating },
        blackPlayer: { userId: blackPlayer.userId, name: blackPlayer.name, rating: blackPlayer.rating },
        timeControl: this.options.timeControl,
        initialTimeMs: this.options.initialTimeMs,
        incrementMs: this.options.incrementMs
      };

      const { createGame } = require('./game');
      const game = createGame(gameData);
      game.arenaId = this.id;
      this.activeGames.set(gameId, { whiteId: whitePlayer.userId, blackId: blackPlayer.userId });

      // Notify players in the arena room
      if (io) {
        console.log(`[Arena] Broadcasting match ${gameId} to room arena:${this.id}`);
        io.to(`arena:${this.id}`).emit('arena_game_matched', { 
            gameId, 
            arenaId: this.id,
            whiteId: whitePlayer.userId,
            blackId: blackPlayer.userId
        });
      }
    }

    if (pairs.length > 0) {
        this.broadcastLeaderboard();
    }
  }

  async syncToLaravel(endpoint, payload) {
    return new Promise((resolve, reject) => {
      const url = new URL(`${config.API_BASE_URL}${endpoint}`);
      const lib = url.protocol === 'https:' ? require('https') : require('http');
      
      const req = lib.request({
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
          'X-Internal-Secret': config.INTERNAL_SECRET
        }
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => data += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(data ? JSON.parse(data) : {});
            } catch (e) {
              resolve({});
            }
          } else {
            console.error(`[Arena] syncToLaravel FAILED (${res.statusCode}) for ${endpoint}. Body:`, data);
            reject(new Error(`Status: ${res.statusCode}`));
          }
        });
      });

      req.on('error', (err) => reject(err));
      req.write(payload);
      req.end();
    });
  }

  async syncMatchToLaravel(payload) {
    try {
      const data = await this.syncToLaravel('/api/internal/arena/match', payload);
      return data.game_id;
    } catch (err) {
      console.error('[Arena] syncMatchToLaravel failed:', err.message);
      throw err;
    }
  }

  handleGameEnd(gameId, result, winnerId) {
    const { getActivePlayerSocket } = require('./game');
    const activeGame = this.activeGames.get(gameId);
    if (!activeGame) return;

    const { whiteId, blackId } = activeGame;
    this.activeGames.delete(gameId);

    // Update scores and streaks for both players
    this.updatePlayerScore(whiteId, result === '1-0' ? 'win' : (result === '1/2-1/2' ? 'draw' : 'loss'), blackId);
    this.updatePlayerScore(blackId, result === '0-1' ? 'win' : (result === '1/2-1/2' ? 'draw' : 'loss'), whiteId);

    // Do NOT auto-add to waiting room anymore. 
    // Players will join the queue when they return to the lobby.
    
    // Broadcast update
    this.broadcastLeaderboard();
  }

  getTopGameId() {
    if (this.activeGames.size === 0) return null;

    // Get leaderboard sorted by score/rating
    const leaderboard = Array.from(this.participants.values())
      .sort((a, b) => b.score - a.score || b.rating - a.rating);

    // Find the first player who is in an active game
    for (const p of leaderboard) {
      for (const [gameId, players] of this.activeGames.entries()) {
        if (players.whiteId === p.userId || players.blackId === p.userId) {
          return gameId;
        }
      }
    }

    // Fallback: return the first active game recorded if no leaderboard match (unlikely)
    return this.activeGames.keys().next().value || null;
  }

  updatePlayerScore(userId, resultType, opponentId) {
    // If the game ended AFTER the arena ended, don't count the points
    if (Date.now() > this.endTime) {
      console.log(`[Arena] Game ended after arena expiration for user ${userId}. Score not updated.`);
      return;
    }

    const p = this.participants.get(userId);

    let points = 0;
    const isOnFire = p.streak >= 2;

    if (resultType === 'win') {
      points = isOnFire ? 4 : 2;
      p.streak += 1;
    } else if (resultType === 'draw') {
      points = isOnFire ? 2 : 1;
      p.streak = 0; // Draw resets streak as per user request
    } else {
      points = 0;
      p.streak = 0;
    }

    p.score += points;
  }

  broadcastLeaderboard() {
    if (!io) return;

    const leaderboard = Array.from(this.participants.values())
      .map(p => ({
        userId: p.userId,
        name: p.name,
        score: p.score,
        streak: p.streak,
        rating: p.rating,
        isWaiting: this.waitingRoom.has(p.userId)
      }))
      .sort((a, b) => b.score - a.score || b.rating - a.rating);

    io.to(`arena:${this.id}`).emit('arena_leaderboard_update', {
      arenaId: this.id,
      leaderboard,
      topGameId: this.getTopGameId()
    });
  }

  end() {
    if (this.pairingTimer) {
      clearInterval(this.pairingTimer);
      this.pairingTimer = null;
    }
    
    // Notify participants
    if (io) {
      io.to(`arena:${this.id}`).emit('arena_ended', { 
        arenaId: this.id,
        timestamp: Date.now()
      });
    }

    // Sync final standings to Laravel
    this.syncStandingsToLaravel();
  }

  async syncStandingsToLaravel() {
    const leaderboard = Array.from(this.participants.values())
      .map(p => ({
        userId: p.userId,
        score: p.score,
        streak: p.streak
      }))
      .sort((a, b) => b.score - a.score);

    const payload = JSON.stringify({ standings: leaderboard });

    try {
      await this.syncToLaravel(`/api/internal/arena/${this.id}/finalize`, payload);
      console.log(`[Arena] Successfully finalized ${this.id}`);
    } catch (err) {
      console.error(`[Arena] Error syncing standings for ${this.id}:`, err.message);
    }
  }
}

// Global Arenas Map
const arenas = new Map();

module.exports = { Arena, arenas, setIo };
