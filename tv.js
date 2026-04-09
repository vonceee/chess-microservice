const { games, sanitizeGame } = require('./game');

// TV Director State
let featuredGames = {
  bullet: null, // gameId
  blitz: null,
  rapid: null
};

// Start the TV selection loop
function initTvDirector(io) {
  // First run
  updateFeaturedGames(io);

  // Check every 10 seconds
  setInterval(() => {
    updateFeaturedGames(io);
  }, 10000);
}

function classifyTimeControl(initialTimeMs, incrementMs) {
  // Common estimate: 40 moves per game
  const estimatedTotalMs = (initialTimeMs || 0) + 40 * (incrementMs || 0);

  if (estimatedTotalMs <= 180000) {
    return 'bullet';
  } else if (estimatedTotalMs <= 480000) {
    return 'blitz';
  } else {
    return 'rapid';
  }
}

function updateFeaturedGames(io) {
  const candidates = {
    bullet: [],
    blitz: [],
    rapid: []
  };

  // 1. Gather all active games
  for (const [gameId, game] of games.entries()) {
    if (game.status === 'active') {
      const category = classifyTimeControl(game.initialTimeMs, game.incrementMs);
      const averageRating = ((game.whitePlayer.rating || 1500) + (game.blackPlayer.rating || 1500)) / 2;
      
      console.log(`[TV] Game ${gameId} is active. Classified as ${category}. Score: ${averageRating}. Time: ${game.initialTimeMs}+${game.incrementMs}`);
      candidates[category].push({
        id: gameId,
        score: averageRating,
        game: game
      });
    }
  }

  // 2. Select the top game for each category
  const newFeatured = {
    bullet: null,
    blitz: null,
    rapid: null
  };

  for (const category of ['bullet', 'blitz', 'rapid']) {
    if (candidates[category].length > 0) {
      // Sort descending by score
      candidates[category].sort((a, b) => b.score - a.score);
      newFeatured[category] = candidates[category][0].id;
    }
  }

  // 3. Emit switches if changed
  for (const category of ['bullet', 'blitz', 'rapid']) {
    const newId = newFeatured[category];
    const oldId = featuredGames[category];

    // If game changed to a new active game
    if (newId !== oldId) {
      featuredGames[category] = newId;

      if (newId && io) {
        const game = games.get(newId);
        if (game) {
          io.to('tv_global').emit('tv_switch_game', {
            category,
            gameId: newId,
            fen: game.fen,
            whitePlayer: game.whitePlayer,
            blackPlayer: game.blackPlayer,
            whiteTimeRemainingMs: game.whiteTimeRemainingMs,
            blackTimeRemainingMs: game.blackTimeRemainingMs,
            turn: game.turn,
            timeControl: game.timeControl
          });
        }
      }
    }
  }
}

function getFeaturedGamesData() {
  const data = {};
  for (const category of ['bullet', 'blitz', 'rapid']) {
    const id = featuredGames[category];
    if (id) {
      const game = games.get(id);
      if (game && game.status === 'active') {
        data[category] = {
          gameId: id,
          fen: game.fen,
          whitePlayer: game.whitePlayer,
          blackPlayer: game.blackPlayer,
          whiteTimeRemainingMs: game.whiteTimeRemainingMs,
          blackTimeRemainingMs: game.blackTimeRemainingMs,
          turn: game.turn,
          timeControl: game.timeControl
        };
      } else {
        // Clear if not active anymore
        featuredGames[category] = null;
        data[category] = null;
      }
    } else {
      data[category] = null;
    }
  }
  return data;
}

function getFeaturedGameIds() {
  return [featuredGames.bullet, featuredGames.blitz, featuredGames.rapid].filter(Boolean);
}

module.exports = {
  initTvDirector,
  getFeaturedGamesData,
  getFeaturedGameIds,
  featuredGames
};
