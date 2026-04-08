const config = require('./config');

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

    this.startTime = Date.now();
    this.endTime = this.startTime + (this.options.durationMinutes * 60 * 1000);
    this.pairingTimer = setInterval(() => this.pairPlayers(), this.options.pairingInterval);
    
    // Arena end timer
    this.durationTimer = setTimeout(() => this.end(), this.endTime - this.startTime);
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

  leave(userId) {
    this.waitingRoom.delete(userId);
    const p = this.participants.get(userId);
    if (p) p.isWaiting = false;
  }

  pairPlayers() {
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

        // Safety check: Avoid immediate rematch
        if (waitingPlayers[i].lastOpponentId === waitingPlayers[j].userId ||
            waitingPlayers[j].lastOpponentId === waitingPlayers[i].userId) {
          continue;
        }

        bestMatchIdx = j;
        break;
      }

      // If no valid match found (due to rematch safety), and we have other candidates, 
      // we might just skip this player this cycle or pick the next one if it's the only option.
      // For V1, if no match found that isn't a rematch, we skip to next cycle.
      if (bestMatchIdx !== -1) {
        pairs.push([waitingPlayers[i], waitingPlayers[bestMatchIdx]]);
        paired.add(waitingPlayers[i].userId);
        paired.add(waitingPlayers[bestMatchIdx].userId);
      }
    }

    // Create games for pairs
    pairs.forEach(([p1, p2]) => {
      this.waitingRoom.delete(p1.userId);
      this.waitingRoom.delete(p2.userId);

      const gameId = Math.random().toString(36).substring(2, 11);
      
      // Update last opponent
      p1.lastOpponentId = p2.userId;
      p2.lastOpponentId = p1.userId;

      // Randomize colors
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

      // Notify players
      if (io) {
        const whiteSocketId = require('./game').getActivePlayerSocket(whitePlayer.userId);
        const blackSocketId = require('./game').getActivePlayerSocket(blackPlayer.userId);

        if (whiteSocketId) io.to(whiteSocketId).emit('arena_game_matched', { gameId, arenaId: this.id });
        if (blackSocketId) io.to(blackSocketId).emit('arena_game_matched', { gameId, arenaId: this.id });
      }
    });
  }

  handleGameEnd(gameId, result, winnerId) {
    const activeGame = this.activeGames.get(gameId);
    if (!activeGame) return;

    const { whiteId, blackId } = activeGame;
    this.activeGames.delete(gameId);

    // Update scores and streaks for both players
    this.updatePlayerScore(whiteId, result === '1-0' ? 'win' : (result === '1/2-1/2' ? 'draw' : 'loss'), blackId);
    this.updatePlayerScore(blackId, result === '0-1' ? 'win' : (result === '1/2-1/2' ? 'draw' : 'loss'), whiteId);

    // Add back to waiting room if they are still connected
    const whiteConnected = !!require('./game').getActivePlayerSocket(whiteId);
    const blackConnected = !!require('./game').getActivePlayerSocket(blackId);

    if (whiteConnected) this.waitingRoom.add(whiteId);
    if (blackConnected) this.waitingRoom.add(blackId);

    // Broadcast update
    this.broadcastLeaderboard();
  }

  updatePlayerScore(userId, resultType, opponentId) {
    const p = this.participants.get(userId);
    if (!p) return;

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
      leaderboard
    });
  }

  end() {
    clearInterval(this.pairingTimer);
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

    try {
      const response = await fetch(`${config.API_BASE_URL}/api/internal/arena/${this.id}/finalize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Internal-Secret': config.INTERNAL_SECRET
        },
        body: JSON.stringify({ standings: leaderboard })
      });

      if (!response.ok) {
        console.error(`[Arena] Failed to sync final standings for ${this.id}`);
      }
    } catch (err) {
      console.error(`[Arena] Error syncing standings for ${this.id}:`, err);
    }
  }
}

// Global Arenas Map
const arenas = new Map();

module.exports = { Arena, arenas, setIo };
