const activeStudies = new Map(); // studyId -> { ownerId, currentChapterId, fen, moves, shapes }

function setupStudyHandlers(socket, io) {
  socket.on('join_study', (data) => {
    const { studyId, ownerId, initialState } = data;
    
    socket.join(studyId);
    
    // Initialize study state if not present
    if (!activeStudies.has(studyId)) {
      activeStudies.set(studyId, {
        ownerId: String(ownerId),
        currentChapterId: initialState?.chapterId || null,
        fen: initialState?.fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        moves: initialState?.moves || [],
        shapes: []
      });
    }

    const state = activeStudies.get(studyId);
    socket.emit('study_synced', state);
    console.log(`User ${socket.userId} joined study ${studyId}`);
  });

  socket.on('study_move', (data) => {
    const { studyId, move, fen, chapterId } = data;
    const study = activeStudies.get(studyId);

    if (!study) return;

    // Check if user is owner
    if (socket.userId !== study.ownerId) {
      console.warn(`Unauthorized move attempt by ${socket.userId} in study ${studyId}`);
      return;
    }

    // Update state
    study.fen = fen;
    study.moves.push(move);
    study.currentChapterId = chapterId;
    study.shapes = []; // Clear shapes on new move (standard practice)

    // Broadcast to all participants in the study
    io.to(studyId).emit('study_move_made', {
      move,
      fen,
      chapterId,
      userId: socket.userId
    });
  });

  socket.on('study_draw_shapes', (data) => {
    const { studyId, shapes } = data;
    const study = activeStudies.get(studyId);

    if (!study) return;

    if (socket.userId !== study.ownerId) return;

    study.shapes = shapes;

    io.to(studyId).emit('study_shapes_drawn', {
      shapes,
      userId: socket.userId
    });
  });

  socket.on('study_change_chapter', (data) => {
    const { studyId, chapterId, fen, moves } = data;
    const study = activeStudies.get(studyId);

    if (!study) return;
    if (socket.userId !== study.ownerId) return;

    study.currentChapterId = chapterId;
    study.fen = fen;
    study.moves = moves;
    study.shapes = [];

    io.to(studyId).emit('study_chapter_changed', {
      chapterId,
      fen,
      moves
    });
  });

  socket.on('leave_study', (studyId) => {
    socket.leave(studyId);
    console.log(`User ${socket.userId} left study ${studyId}`);
  });
}

module.exports = { setupStudyHandlers };
