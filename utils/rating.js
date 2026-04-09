/**
 * Glicko-2 Rating System Utility
 * Authoritatively calculates rating changes on the server.
 */

const TAU = 0.5;
const DEFAULT_RD = 350;
const DEFAULT_VOL = 0.06;
const MIN_RD = 45;
const MAX_RD = 500;
const MIN_RATING = 400;
const MAX_RATING = 4000;
const PROVISIONAL_RD = 80; // Show "?" when RD > 80

/**
 * G-function for Glicko-2
 */
function gFunction(rd) {
  return 1 / Math.sqrt(1 + (3 * Math.pow(rd, 2) / Math.pow(Math.PI, 2)));
}

/**
 * Expected score calculation
 */
function calculateExpectedScore(rating, rd, opponentRating, opponentRd) {
  const g = gFunction(opponentRd);
  return 1 / (1 + Math.pow(10, (-g * (rating - opponentRating) / 400)));
}

/**
 * Volatility update logic
 */
function calculateNewVolatility(vol, rating, rd, opponentRating, opponentRd, score) {
  const E = calculateExpectedScore(rating, rd, opponentRating, opponentRd);
  const g = gFunction(opponentRd);
  const d2 = 1 / (Math.pow(g, 2) * E * (1 - E));
  
  const a = Math.log(vol * vol);
  const delta = g * (score - E); // This is simplified delta for single game
  
  const functionA = (x) => {
    const ex = Math.exp(x);
    const num = ex * (Math.pow(delta, 2) - d2 - Math.pow(gFunction(DEFAULT_RD), 2) * ex * E * (1 - E));
    const den = 2 * Math.pow(d2 + ex, 2);
    return num / den - (x - a) / Math.pow(TAU, 2);
  };

  let A = a;
  let B;
  
  if (Math.pow(delta, 2) > d2) {
    B = Math.log(Math.pow(delta, 2) - d2);
  } else {
    let k = 1;
    while (functionA(a - k * TAU) < 0) {
      k++;
    }
    B = a - k * TAU;
  }

  let fA = functionA(A);
  let fB = functionA(B);

  let iteration = 0;
  const maxIterations = 100;
  const epsilon = 0.000001;

  while (Math.abs(B - A) > epsilon && iteration < maxIterations) {
    const C = A + (A - B) * fA / (fB - fA);
    const fC = functionA(C);

    if (fC * fB < 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }

    B = C;
    fB = fC;
    iteration++;
  }

  return Math.exp(A / 2);
}

/**
 * Update player ratings after a single game
 * 
 * Note: Rating changes are designed to be roughly balanced (winner's gain ≈ loser's loss)
 * but won't be exactly equal due to different RD values affecting each player's update.
 * This is mathematically correct for Glicko-2.
 * 
 * @returns {Object} { p1: {rating, rd, vol, change}, p2: {rating, rd, vol, change} }
 */
function updateRatings(p1, p2, score) {
  // score is from p1 perspective (1=win, 0.5=draw, 0=loss)
  
  // Calculate P1 update
  const p1NewVol = calculateNewVolatility(p1.vol, p1.rating, p1.rd, p2.rating, p2.rd, score);
  const p1E = calculateExpectedScore(p1.rating, p1.rd, p2.rating, p2.rd);
  const p1G = gFunction(p2.rd);
  const p1D2 = 1 / (Math.pow(p1G, 2) * p1E * (1 - p1E));
  const p1NewRd = Math.sqrt(1 / (1 / Math.pow(p1.rd, 2) + 1 / p1D2));
  const p1Change = Math.pow(p1NewRd, 2) * p1G * (score - p1E);
  
  // Calculate P2 update
  const p2Score = 1 - score;
  const p2NewVol = calculateNewVolatility(p2.vol, p2.rating, p2.rd, p1.rating, p1.rd, p2Score);
  const p2E = calculateExpectedScore(p2.rating, p2.rd, p1.rating, p1.rd);
  const p2G = gFunction(p1.rd);
  const p2D2 = 1 / (Math.pow(p2G, 2) * p2E * (1 - p2E));
  const p2NewRd = Math.sqrt(1 / (1 / Math.pow(p2.rd, 2) + 1 / p2D2));
  const p2Change = Math.pow(p2NewRd, 2) * p2G * (p2Score - p2E);

  return {
    p1: {
      rating: Math.max(MIN_RATING, Math.min(MAX_RATING, Math.round(p1.rating + p1Change))),
      rd: Math.max(MIN_RD, Math.min(MAX_RD, Math.round(p1NewRd))),
      vol: p1NewVol,
      change: Math.round(p1Change)
    },
    p2: {
      rating: Math.max(MIN_RATING, Math.min(MAX_RATING, Math.round(p2.rating + p2Change))),
      rd: Math.max(MIN_RD, Math.min(MAX_RD, Math.round(p2NewRd))),
      vol: p2NewVol,
      change: Math.round(p2Change)
    }
  };
}

module.exports = {
  updateRatings
};
