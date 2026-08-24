/**
 * game.handler.js
 *
 * Server-authoritative 1v1 chess game handler.
 * Mirrors Lila's round architecture:
 *   - Server validates every move with chess.js
 *   - Server computes & sends legal destinations after each move
 *   - Client never decides legality — it just passes UCI to the server
 *
 * Socket events (client → server):
 *   game_join        { gameId }
 *   game_move        { gameId, uci }
 *   game_resign      { gameId }
 *   game_draw_offer  { gameId }
 *   game_draw_accept { gameId }
 *   game_abort       { gameId }
 *
 * Socket events (server → client):
 *   game_full       { gameId, white, black, fen, steps, possibleMoves, clock, status, winner }
 *   game_move       { ply, fen, san, uci, check, dests, clock, status?, winner? }
 *   game_end        { winner, status, clock }
 *   game_clock_tick { clock }
 *   game_draw_offer { by: 'white'|'black' }
 *   game_crowd      { white: bool, black: bool }
 */

'use strict';

const { Chess } = require('chess.js');
const { activePlayers } = require('../active-players');

// ─── Active game store ────────────────────────────────────────────────────────
const activeGames = new Map();

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Encode legal dests as Record<from, to[]> — mirrors Lila's EncodedDests. */
function encodeDests(chess) {
  const dests = {};
  try {
    chess.moves({ verbose: true }).forEach(m => {
      if (!dests[m.from]) dests[m.from] = [];
      dests[m.from].push(m.to);
    });
  } catch (_) {}
  return dests;
}

function getPlayerColor(game, userId) {
  if (String(game.white) === String(userId)) return 'white';
  if (String(game.black) === String(userId)) return 'black';
  return null;
}

function buildFullState(game, forUserId) {
  const myColor = getPlayerColor(game, forUserId);
  const isMyTurn = myColor && game.chess.turn() === myColor[0];
  return {
    gameId: game.id,
    white: game.white,
    black: game.black,
    fen: game.chess.fen(),
    steps: game.steps,
    possibleMoves: (isMyTurn && game.status === 'started') ? encodeDests(game.chess) : null,
    clock: { white: game.clockW, black: game.clockB },
    status: game.status,
    winner: game.winner,
  };
}

function checkGameOver(game) {
  const c = game.chess;
  if (c.in_checkmate()) {
    const loser = c.turn(); // in checkmate = their turn but they lose
    return { winner: loser === 'w' ? 'black' : 'white', status: 'mate' };
  }
  if (c.in_stalemate())           return { winner: null, status: 'stalemate' };
  if (c.in_threefold_repetition()) return { winner: null, status: 'threefold' };
  if (c.insufficient_material()) return { winner: null, status: 'insufficient' };
  if (c.in_draw())                return { winner: null, status: 'draw' };
  return null;
}

function stopClock(game) {
  if (game.clockInterval) {
    clearInterval(game.clockInterval);
    game.clockInterval = null;
  }
}

function endGame(io, game, winner, status) {
  if (game.status === 'ended') return;
  game.status = 'ended';
  game.winner = winner;
  stopClock(game);
  io.to(`game_${game.id}`).emit('game_end', {
    winner, status,
    clock: { white: game.clockW, black: game.clockB },
  });
  // Clean up after 30 minutes
  setTimeout(() => activeGames.delete(game.id), 30 * 60 * 1000);
}

function startClock(io, game) {
  if (game.clockInterval) return;
  game.clockInterval = setInterval(() => {
    if (game.status !== 'started') { stopClock(game); return; }
    const turn = game.chess.turn();
    if (turn === 'w') { game.clockW = Math.max(0, game.clockW - 1); }
    else              { game.clockB = Math.max(0, game.clockB - 1); }
    io.to(`game_${game.id}`).emit('game_clock_tick', {
      clock: { white: game.clockW, black: game.clockB },
    });
    if (game.clockW <= 0) endGame(io, game, 'black', 'timeout');
    else if (game.clockB <= 0) endGame(io, game, 'white', 'timeout');
  }, 1000);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Create and store a new game.
 * Call this from matchmaking/lobby when two players are paired.
 */
function createGame(gameId, whiteId, blackId, timeSecs = 300) {
  const chess = new Chess();
  const game = {
    id: gameId,
    white: String(whiteId),
    black: String(blackId),
    chess,
    steps: [{ ply: 0, fen: chess.fen(), san: null, uci: null, check: false }],
    status: 'started',
    winner: null,
    clockW: timeSecs,
    clockB: timeSecs,
    clockInterval: null,
    drawOfferedBy: null,
    lastMoveAt: Date.now(),
  };
  activeGames.set(gameId, game);
  return game;
}

// ─── Socket handler ───────────────────────────────────────────────────────────

function setupGameHandlers(socket, io) {
  const myUid = String(socket.userId);

  // game_join — join room & receive full state (desync-safe)
  socket.on('game_join', ({ gameId } = {}) => {
    if (!gameId) return;
    const game = activeGames.get(gameId);
    if (!game) return;
    socket.join(`game_${gameId}`);
    if (game.status === 'started' && !game.clockInterval) startClock(io, game);
    io.to(`game_${gameId}`).emit('game_crowd', {
      white: !!activePlayers.get(game.white),
      black: !!activePlayers.get(game.black),
    });
    socket.emit('game_full', buildFullState(game, myUid));
  });

  // game_move — validate UCI, apply, broadcast ApiMove
  socket.on('game_move', ({ gameId, uci } = {}) => {
    if (!gameId || !uci) return;
    const game = activeGames.get(gameId);
    if (!game || game.status !== 'started') return;

    const myColor = getPlayerColor(game, myUid);
    if (!myColor) return;
    if (game.chess.turn() !== myColor[0]) {
      console.warn(`[Game] Out-of-turn move from ${myUid}`);
      return;
    }

    const from = uci.slice(0, 2);
    const to   = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;

    let move;
    try { move = game.chess.move({ from, to, promotion }); } catch (_) {}

    if (!move) {
      // Illegal — re-send full state so client can resync
      socket.emit('game_full', buildFullState(game, myUid));
      return;
    }

    game.lastMoveAt = Date.now();
    game.drawOfferedBy = null;

    const ply = game.chess.history().length;
    const step = { ply, fen: game.chess.fen(), san: move.san, uci, check: game.chess.in_check() };
    game.steps.push(step);

    const endResult = checkGameOver(game);
    if (endResult) game.status = 'ended';

    io.to(`game_${game.id}`).emit('game_move', {
      ply,
      fen: step.fen,
      san: move.san,
      uci,
      check: step.check,
      dests: !endResult ? encodeDests(game.chess) : {},
      clock: { white: game.clockW, black: game.clockB },
      ...(endResult ?? {}),
    });

    if (endResult) endGame(io, game, endResult.winner, endResult.status);
  });

  // game_resign
  socket.on('game_resign', ({ gameId } = {}) => {
    const game = activeGames.get(gameId);
    if (!game || game.status !== 'started') return;
    const myColor = getPlayerColor(game, myUid);
    if (!myColor) return;
    endGame(io, game, myColor === 'white' ? 'black' : 'white', 'resign');
  });

  // game_abort (only within first 2 plies)
  socket.on('game_abort', ({ gameId } = {}) => {
    const game = activeGames.get(gameId);
    if (!game || game.status !== 'started') return;
    if (!getPlayerColor(game, myUid)) return;
    if (game.chess.history().length >= 2) return;
    endGame(io, game, null, 'aborted');
  });

  // game_draw_offer
  socket.on('game_draw_offer', ({ gameId } = {}) => {
    const game = activeGames.get(gameId);
    if (!game || game.status !== 'started') return;
    const myColor = getPlayerColor(game, myUid);
    if (!myColor) return;
    game.drawOfferedBy = myColor;
    io.to(`game_${game.id}`).emit('game_draw_offer', { by: myColor });
  });

  // game_draw_accept
  socket.on('game_draw_accept', ({ gameId } = {}) => {
    const game = activeGames.get(gameId);
    if (!game || game.status !== 'started') return;
    const myColor = getPlayerColor(game, myUid);
    if (!myColor || !game.drawOfferedBy || game.drawOfferedBy === myColor) return;
    endGame(io, game, null, 'draw');
  });
}

module.exports = { setupGameHandlers, createGame, activeGames };
