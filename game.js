// Game state management
const { Chess } = require('chess.js');
const { validateMove, getGameStatus, getLegalMoves } = require('./utils/chess');
const { checkAndFlagTimeout, getEffectiveTimes, sanitizeGame } = require('./utils/clock');
const { startAbandonmentCountdown, clearAbandonmentTimer, handlePlayerReconnection } = require('./abandonment');

// In-memory storage
const games = new Map(); // gameId -> game state
const activePlayers = new Map(); // userId -> socketId
const matchmakingQueue = []; // Queue for matchmaking

// Game state structure:
// {
//   id: string,
//   whitePlayer: {userId, socketId, name},
//   blackPlayer: {userId, socketId, name},
//   fen: string,
//   turn: 'white' | 'black',
//   status: 'active' | 'completed' | 'abandoned',
//   timeControl: string,
//   initialTimeMs: number,
//   incrementMs: number,
//   whiteTimeRemainingMs: number,
//   blackTimeRemainingMs: number,
//   moves: string[],
//   result: string | null,
//   termination: string | null,
//   createdAt: Date,
//   lastMoveTimestamp: Date | null,
//   abandonmentTimers: {
//     white: { timer: Timeout | null, startTime: Date | null },
//     black: { timer: Timeout | null, startTime: Date | null }
//   },
//   opponentAwayCountdown: number | null,
//   gameStartedAt: Date | null
// }

function createGame(gameData) {
  const { gameId, whitePlayer, blackPlayer, timeControl, initialTimeMs, incrementMs } = gameData;

  const game = {
    id: gameId,
    whitePlayer: {
      userId: whitePlayer.userId,
      socketId: '',
      name: whitePlayer.name,
      rating: whitePlayer.rating || 1500,
      rd: whitePlayer.rd || 350,
      vol: whitePlayer.vol || 0.06
    },
    blackPlayer: {
      userId: blackPlayer.userId,
      socketId: '',
      name: blackPlayer.name,
      rating: blackPlayer.rating || 1500,
      rd: blackPlayer.rd || 350,
      vol: blackPlayer.vol || 0.06
    },
    fen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
    turn: 'white',
    status: 'active',
    timeControl,
    initialTimeMs,
    incrementMs,
    whiteTimeRemainingMs: initialTimeMs,
    blackTimeRemainingMs: initialTimeMs,
    moves: [],
    result: null,
    termination: null,
    createdAt: new Date(),
    lastMoveTimestamp: null,
    arenaId: gameData.arenaId || null,
    abandonmentTimers: {
      white: { timer: null, startTime: null },
      black: { timer: null, startTime: null }
    },
    opponentAwayCountdown: null,
    gameStartedAt: new Date(),
    lastMoveTimestamp: new Date(),
    turnStartedAt: new Date(),
    rematchOffer: null,
    rematchAccepted: false
  };

  games.set(gameId, game);

  return game;
}


function getGame(gameId) {
  return games.get(gameId);
}

function getAllGames() {
  return games;
}

function getActiveGamesCount() {
  return Array.from(games.values()).filter(game => game.status === 'active').length;
}

function getActivePlayersCount() {
  return activePlayers.size;
}

function addActivePlayer(userId, socketId) {
  activePlayers.set(userId, socketId);
}

function removeActivePlayer(userId) {
  activePlayers.delete(userId);
}

function getActivePlayerSocket(userId) {
  return activePlayers.get(userId);
}







module.exports = {
  createGame,
  getGame,
  getAllGames,
  getActiveGamesCount,
  getActivePlayersCount,
  addActivePlayer,
  removeActivePlayer,
  getActivePlayerSocket,
  games,
  activePlayers,
  matchmakingQueue,
  // Import and re-export from utils and abandonment
  validateMove,
  getGameStatus,
  getLegalMoves,
  checkAndFlagTimeout,
  getEffectiveTimes,
  sanitizeGame,
  startAbandonmentCountdown,
  clearAbandonmentTimer,
  handlePlayerReconnection,
};