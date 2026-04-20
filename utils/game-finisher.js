const axios = require('axios');
const { updateRatings } = require('./rating');
const config = require('../config');
const { arenas } = require('../arena');

/**
 * Authoritatively calculates and reports game end to Laravel
 */
async function finalizeGame(game, io) {
  if (game.status !== 'completed' && game.status !== 'aborted') return;
  if (game.isFinalizing) return;
  game.isFinalizing = true;

  const games = require('../game').games;
  let ratingData = null;

  if (game.status === 'completed' && game.result && game.result !== 'aborted') {
    const p1 = {
      rating: game.whitePlayer.rating,
      rd: game.whitePlayer.rd,
      vol: game.whitePlayer.vol
    };
    const p2 = {
      rating: game.blackPlayer.rating,
      rd: game.blackPlayer.rd,
      vol: game.blackPlayer.vol
    };

    let score;
    // Apply first-move advantage (~3 Elo points equivalent)
    // White gets slight advantage: adjust scores slightly
    if (game.result === '1-0') score = 1;
    else if (game.result === '0-1') score = 0;
    else score = 0.5;


    try {
        const result = updateRatings(p1, p2, score);
        
        ratingData = {
          rating_changes: {
            white: result.p1.change,
            black: result.p2.change
          },
          new_ratings: {
            white: { rating: result.p1.rating, rd: result.p1.rd },
            black: { rating: result.p2.rating, rd: result.p2.rd }
          }
        };
    } catch (err) {
        console.error('[Microservice] Rating calculation error:', err);
    }
  }

  // Notify Laravel backend
  try {
    const payload = {
      status: game.status,
      result: game.result,
      termination: game.termination,
      moves: game.moves,
      arena_id: game.arenaId || null,
      ...(ratingData || {})
    };


    const response = await axios.post(`${config.API_BASE_URL}/api/internal/game/${game.id}/complete`, payload, {
      headers: { 
        'Content-Type': 'application/json',
        'X-Internal-Secret': config.INTERNAL_SECRET
      },
      timeout: 10000 // 10s safety timeout for production
    });

    if (response.data.success) {
      console.log(`[Microservice] Game ${game.id} successfully reported to Laravel.`);
    } else {
      console.warn(`[Microservice] Laravel rejected game report for ${game.id}:`, response.data);
    }
  } catch (error) {
    const errorMsg = error.response ? 
      `Server responded with ${error.response.status}: ${JSON.stringify(error.response.data)}` : 
      error.message;
    console.error(`[Microservice] Fatal error reporting game ${game.id} to Laravel: ${errorMsg}`);
  }

  // Broadcast to players with specific rating info
  io.to(game.id).emit('game_ended', {
    gameId: game.id,
    result: game.result,
    termination: game.termination,
    status: game.status,
    rating_change: ratingData ? ratingData.rating_changes : null
  });

  // Arena-specific processing
  if (game.arenaId) {
    const arena = arenas.get(game.arenaId);
    if (arena) {
      // Find winnerId if not a draw
      let winnerId = null;
      if (game.result === '1-0') winnerId = game.whitePlayer.userId;
      else if (game.result === '0-1') winnerId = game.blackPlayer.userId;
      
      arena.handleGameEnd(game.id, game.result, winnerId);
    }
  }
  
  // Cleanup game from memory after a short delay (e.g. 1 minute)
  // to allow players to see the result and chat if needed.
  setTimeout(() => {
    games.delete(game.id);
  }, 60000);
}

module.exports = { finalizeGame };
