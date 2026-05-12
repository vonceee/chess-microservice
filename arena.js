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
    
    // Re-hydrate from previous state if available
    if (options.standings && Array.isArray(options.standings)) {
      console.log(`[Arena] Re-hydrating ${id} with ${options.standings.length} participants`);
      options.standings.forEach(p => {
        this.participants.set(p.userId, {
          userId: p.userId,
          name: p.name || 'Unknown',
          rating: p.rating || 1500,
          score: p.score || 0,
          streak: p.streak || 0,
          lastOpponentId: null,
          isWaiting: false
        });
      });
    }

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
    // Only add to participants if they are actually joining (wait=true)
    // or if they are already in the participants list.
    if (wait && !this.participants.has(user.userId)) {
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
    
    // If they are already a participant, we can update their name/rating if provided
    // This handles the case where a user joins as a spectator first, then as a player.
    if (this.participants.has(user.userId)) {
        const p = this.participants.get(user.userId);
        if (user.name && user.name !== 'Guest' && user.name !== 'Anonymous') {
            p.name = user.name;
        }
        if (user.rating) p.rating = user.rating;
    }

    if (wait) {
      this.waitingRoom.add(user.userId);
      if (this.participants.has(user.userId)) {
        this.participants.get(user.userId).isWaiting = true;
      }
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

        console.log(`[Arena] Syncing match to Laravel: ${p1.name} vs ${p2.name} in arena ${this.id}`);
        // Use a more robust way to call Laravel that doesn't depend on Node 18 fetch
        gameId = await this.syncMatchToLaravel(payload);
        
        if (!gameId) {
            console.error('[Arena] Laravel returned empty gameId, falling back to local ID');
            gameId = Math.random().toString(36).substring(2, 11);
        } else {
            console.log(`[Arena] Registered game ${gameId} in Laravel DB`);
        }
      } catch (err) {
        console.error('[Arena] Failed to sync match to Laravel:', err.message);
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

      try {
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
      } catch (gameErr) {
        console.error(`[Arena] Crisis: Failed to initialize game ${gameId} in memory:`, gameErr);
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

    // Sync intermediate standings to Laravel for persistence
    this.syncStandingsToLaravel(false);
  }

  getTopGames(limit = 4) {
    if (this.activeGames.size === 0) return [];

    const leaderboard = Array.from(this.participants.values())
      .sort((a, b) => b.score - a.score || b.rating - a.rating);

    const topGames = [];
    const seenGames = new Set();

    // 1. Prioritize games with top leaderboard players
    for (const p of leaderboard) {
      if (topGames.length >= limit) break;

      for (const [gameId, players] of this.activeGames.entries()) {
        if (seenGames.has(gameId)) continue;

        if (players.whiteId === p.userId || players.blackId === p.userId) {
          const white = this.participants.get(players.whiteId);
          const black = this.participants.get(players.blackId);
          
          if (white && black) {
            topGames.push({
              gameId,
              white: { 
                name: white.name, 
                rating: white.rating,
                rank: leaderboard.findIndex(lp => lp.userId === players.whiteId) + 1
              },
              black: { 
                name: black.name, 
                rating: black.rating,
                rank: leaderboard.findIndex(lp => lp.userId === players.blackId) + 1
              }
            });
            seenGames.add(gameId);
            if (topGames.length >= limit) break;
          }
        }
      }
    }
    
    // 2. Fill remaining slots with any other active games
    if (topGames.length < limit) {
        for (const [gameId, players] of this.activeGames.entries()) {
            if (seenGames.has(gameId)) continue;
            const white = this.participants.get(players.whiteId);
            const black = this.participants.get(players.blackId);
            if (white && black) {
                topGames.push({
                  gameId,
                  white: { 
                    name: white.name, 
                    rating: white.rating,
                    rank: leaderboard.findIndex(lp => lp.userId === players.whiteId) + 1
                  },
                  black: { 
                    name: black.name, 
                    rating: black.rating,
                    rank: leaderboard.findIndex(lp => lp.userId === players.blackId) + 1
                  }
                });
                seenGames.add(gameId);
                if (topGames.length >= limit) break;
            }
        }
    }

    return topGames;
  }

  getTopGameId() {
    const topGames = this.getTopGames(1);
    return topGames.length > 0 ? topGames[0].gameId : null;
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
      topGameId: this.getTopGameId(),
      topGames: this.getTopGames(4)
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

  async syncStandingsToLaravel(isFinal = true) {
    const leaderboard = Array.from(this.participants.values())
      .map(p => ({
        userId: p.userId,
        name: p.name,
        score: p.score,
        streak: p.streak,
        rating: p.rating
      }))
      .sort((a, b) => b.score - a.score);

    const payload = JSON.stringify({ standings: leaderboard });
    const endpoint = isFinal 
        ? `/api/internal/arena/${this.id}/finalize`
        : `/api/internal/arena/${this.id}/sync-standings`;

    try {
      await this.syncToLaravel(endpoint, payload);
      console.log(`[Arena] Successfully ${isFinal ? 'finalized' : 'synced'} ${this.id}`);
    } catch (err) {
      console.error(`[Arena] Error syncing standings for ${this.id}:`, err.message);
    }
  }
}

// Global Arenas Map
const arenas = new Map();

module.exports = { Arena, arenas, setIo };
