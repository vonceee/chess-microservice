const { getFeaturedGamesData } = require('../tv');

function setupTvHandlers(socket, io) {
  socket.on('join_tv', () => {
    socket.join('tv_global');
    socket.emit('tv_state', getFeaturedGamesData());
  });

  socket.on('leave_tv', () => {
    socket.leave('tv_global');
  });
}

module.exports = { setupTvHandlers };
