/** lobbyId (captain's userId) → lobby state */
const bughouseLobbies = new Map();
/** Set of lobbyIds currently searching for a match */
const bughouseQueue = new Set();
/** Quick lookup: userId → lobbyId */
const activePlayersLobby = new Map();
/** gameId → game state */
const bughouseGames = new Map();
/** Quick lookup: userId → gameId */
const activePlayerGames = new Map();
/** gameId → rematch state */
const bughouseRematches = new Map();
/** lobbyId → lockout expiry timestamp (60s cooldown memo) */
const declinedLobbies = new Map();

module.exports = {
  bughouseLobbies,
  bughouseQueue,
  activePlayersLobby,
  bughouseGames,
  activePlayerGames,
  bughouseRematches,
  declinedLobbies,
};
