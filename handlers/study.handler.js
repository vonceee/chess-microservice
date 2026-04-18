const activeStudies = new Map(); // studyId -> { ownerId, currentChapterId, fen, moves, shapes }

function setupStudyHandlers(socket, io) {
  socket.on('join_study', (data) => {
    const { studyId, ownerId, initialState } = data;
    
    socket.join(studyId);
    
    const state = activeStudies.get(studyId);

    // Initialize study state if not present OR if ownerId was corrupted as "undefined"
    if (!state || state.ownerId === 'undefined' || state.ownerId === 'null') {
      activeStudies.set(studyId, {
        ownerId: String(ownerId),
        currentChapterId: initialState?.chapterId || null,
        fen: initialState?.fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        moves: initialState?.moves || [],
        shapes: []
      });
    }

    const currentState = activeStudies.get(studyId);
    socket.emit('study_synced', currentState);
    console.log(`User ${socket.userId} joined study ${studyId}`);
  });

  socket.on('study_move', (data) => {
    const { studyId, move, fen, chapterId, moves } = data;
    const study = activeStudies.get(studyId);

    if (!study) return;
    if (socket.userId !== study.ownerId) return;

    // Trust the full tree sent by the owner
    if (moves) {
      study.moves = moves;
    }

    study.fen = fen;
    study.currentChapterId = chapterId;
    study.shapes = [];

    io.to(studyId).emit('study_move_made', { ...data, userId: socket.userId });
  });

  socket.on('study_delete_node', (data) => {
    const { studyId, chapterId, nodeId } = data;
    const study = activeStudies.get(studyId);
    if (!study || socket.userId !== study.ownerId) return;

    if (findAndDelete(study.moves, nodeId)) {
      io.to(studyId).emit('study_node_deleted', { chapterId, nodeId });
    }
  });

  socket.on('study_update_comment', (data) => {
    const { studyId, chapterId, nodeId, comment } = data;
    const study = activeStudies.get(studyId);
    if (!study || socket.userId !== study.ownerId) return;

    if (findAndUpdateComment(study.moves, nodeId, comment)) {
      io.to(studyId).emit('study_comment_updated', { chapterId, nodeId, comment });
    }
  });

  socket.on('study_draw_shapes', (data) => {
    const { studyId, shapes } = data;
    const study = activeStudies.get(studyId);
    if (!study || socket.userId !== study.ownerId) return;

    study.shapes = shapes;
    io.to(studyId).emit('study_shapes_drawn', { shapes, userId: socket.userId });
  });

  socket.on('study_change_chapter', (data) => {
    const { studyId, chapterId, fen, moves } = data;
    const study = activeStudies.get(studyId);
    if (!study || socket.userId !== study.ownerId) return;

    study.currentChapterId = chapterId;
    study.fen = fen;
    study.moves = moves;
    study.shapes = [];

    io.to(studyId).emit('study_chapter_changed', { chapterId, fen, moves });
  });

  socket.on('leave_study', (studyId) => {
    socket.leave(studyId);
  });
}

function findAndInsertByPath(nodes, path, newNode) {
  if (path.length === 0) return false;
  const currentId = path[0];

  const targetNode = nodes.find(n => n.id === currentId);
  if (!targetNode) return false;

  if (path.length === 1) {
    if (!targetNode.children) targetNode.children = [];
    const existing = targetNode.children.find(c => c.san === newNode.san && c.fen === newNode.fen);
    if (!existing) targetNode.children.push(newNode);
    return true;
  }

  return findAndInsertByPath(targetNode.children || [], path.slice(1), newNode);
}

function findAndDelete(nodes, nodeId) {
  const index = nodes.findIndex(n => n.id === nodeId);
  if (index !== -1) {
    nodes.splice(index, 1);
    return true;
  }
  for (const node of nodes) {
    if (node.children && findAndDelete(node.children, nodeId)) return true;
  }
  return false;
}

function findAndUpdateComment(nodes, nodeId, comment) {
  for (const node of nodes) {
    if (node.id === nodeId) {
      node.comment = comment;
      return true;
    }
    if (node.children && findAndUpdateComment(node.children, nodeId, comment)) return true;
  }
  return false;
}

module.exports = { setupStudyHandlers };
