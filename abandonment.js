// Helper function to start abandonment countdown for a player
function startAbandonmentCountdown(game, color, io) {
  const player = color === 'white' ? game.whitePlayer : game.blackPlayer;
  const opponent = color === 'white' ? game.blackPlayer : game.whitePlayer;

  // Clear any existing timer for this player
  clearAbandonmentTimer(game, color);

  // Set countdown start time
  game.abandonmentTimers[color].startTime = new Date();
  game.opponentAwayCountdown = 30; // 30 seconds

  // Start countdown timer
  game.abandonmentTimers[color].timer = setInterval(() => {
    game.opponentAwayCountdown--;

    // Notify opponent of remaining time
    io.to(game.id).emit('opponent_away_countdown', {
      gameId: game.id,
      secondsRemaining: game.opponentAwayCountdown,
      absentPlayerColor: color
    });

    // If countdown reaches 0, abandon the game
    if (game.opponentAwayCountdown <= 0) {
      clearAbandonmentTimer(game, color);
      
      // Check if both are gone
      const bothGone = !game.whitePlayer.socketId && !game.blackPlayer.socketId;
      if (bothGone) {
        // Both gone? Abort. 
        game.status = 'completed';
        game.result = null;
        game.termination = 'aborted';
        io.to(game.id).emit('game_ended', {
          gameId: game.id,
          result: null,
          termination: 'aborted',
          status: 'completed'
        });
      } else {
        abandonGame(game, color, io);
      }
    }
  }, 1000);
}

// Helper function to clear abandonment timer for a player
function clearAbandonmentTimer(game, color) {
  if (game.abandonmentTimers[color].timer) {
    clearInterval(game.abandonmentTimers[color].timer);
    game.abandonmentTimers[color].timer = null;
    game.abandonmentTimers[color].startTime = null;
    game.opponentAwayCountdown = null;
  }
}

// Helper function to abandon a game
function abandonGame(game, abandonedBy, io) {
  if (game.status !== 'active') return;

  game.status = 'completed';
  game.result = abandonedBy === 'white' ? '0-1' : '1-0';
  game.termination = 'abandoned';

  // Notify both players if they're connected
  io.to(game.id).emit('game_ended', {
    gameId: game.id,
    result: game.result,
    termination: game.termination,
    status: 'completed'
  });
}

// Helper function to handle player reconnection
function handlePlayerReconnection(game, color, io) {
  // Clear the abandonment timer for this player
  clearAbandonmentTimer(game, color);

  // Notify the game room that the player has returned
  io.to(game.id).emit('opponent_returned', {
    gameId: game.id,
    playerColor: color
  });
}

module.exports = {
  startAbandonmentCountdown,
  clearAbandonmentTimer,
  abandonGame,
  handlePlayerReconnection
};