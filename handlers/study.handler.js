const activeStudies = new Map(); // studyId -> { ownerId, currentChapterId, fen, moves, shapes }

function setupStudyHandlers(socket, io) {
  socket.on('join_study', (data) => {
    const { studyId, ownerId, initialState, collaboratorIds } = data;
    
    socket.join(String(studyId));
    
    const state = activeStudies.get(String(studyId));

    // Initialize study state if not present OR if ownerId was corrupted as "undefined"
    if (!state || state.ownerId === 'undefined' || state.ownerId === 'null') {
      activeStudies.set(String(studyId), {
        ownerId: String(ownerId),
        collaboratorIds: (collaboratorIds || []).map(id => String(id)),
        currentChapterId: initialState?.chapterId || null,
        fen: initialState?.fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        moves: initialState?.moves || [],
        shapes: []
      });
    } else if (collaboratorIds) {
      // Update collaborators list if owner joins (or anyone joins with new list)
      state.collaboratorIds = (collaboratorIds || []).map(id => String(id));
    }

    const currentState = activeStudies.get(String(studyId));
    socket.emit('study_synced', currentState);
    console.log(`User ${socket.userId} joined study ${studyId}`);
    broadcastViewers(io, String(studyId));
  });

  socket.on('study_move', (data) => {
    const { studyId, move, fen, chapterId, moves } = data;
    const study = activeStudies.get(String(studyId));

    if (!study) return;
    
    const isOwner = String(socket.userId) === String(study.ownerId);
    const isCollaborator = study.collaboratorIds && study.collaboratorIds.includes(String(socket.userId));
    
    if (!isOwner && !isCollaborator) return;

    // Trust the full tree sent by the owner/collaborator
    if (moves) {
      study.moves = moves;
    }

    study.fen = fen;
    study.currentChapterId = chapterId;
    study.shapes = [];

    io.to(String(studyId)).emit('study_move_made', { ...data, userId: socket.userId });
  });

  socket.on('study_delete_node', (data) => {
    const { studyId, chapterId, nodeId } = data;
    const study = activeStudies.get(String(studyId));
    
    if (!study) return;
    const isOwner = String(socket.userId) === String(study.ownerId);
    const isCollaborator = study.collaboratorIds && study.collaboratorIds.includes(String(socket.userId));
    if (!isOwner && !isCollaborator) return;

    if (findAndDelete(study.moves, nodeId)) {
      io.to(String(studyId)).emit('study_node_deleted', { chapterId, nodeId });
    }
  });

  socket.on('study_update_comment', (data) => {
    const { studyId, chapterId, nodeId, comment } = data;
    const study = activeStudies.get(String(studyId));
    
    if (!study) return;
    const isOwner = String(socket.userId) === String(study.ownerId);
    const isCollaborator = study.collaboratorIds && study.collaboratorIds.includes(String(socket.userId));
    if (!isOwner && !isCollaborator) return;

    if (findAndUpdateComment(study.moves, nodeId, comment)) {
      io.to(String(studyId)).emit('study_comment_updated', { chapterId, nodeId, comment });
    }
  });

  socket.on('study_draw_shapes', (data) => {
    const { studyId, shapes } = data;
    const study = activeStudies.get(String(studyId));
    
    if (!study) return;
    const isOwner = String(socket.userId) === String(study.ownerId);
    const isCollaborator = study.collaboratorIds && study.collaboratorIds.includes(String(socket.userId));
    if (!isOwner && !isCollaborator) return;

    study.shapes = shapes;
    io.to(String(studyId)).emit('study_shapes_drawn', { shapes, userId: socket.userId });
  });

  socket.on('study_change_chapter', (data) => {
    const { studyId, chapterId, fen, moves } = data;
    const study = activeStudies.get(String(studyId));
    
    if (!study) return;
    const isOwner = String(socket.userId) === String(study.ownerId);
    const isCollaborator = study.collaboratorIds && study.collaboratorIds.includes(String(socket.userId));
    if (!isOwner && !isCollaborator) return;

    study.currentChapterId = chapterId;
    study.fen = fen;
    study.moves = moves;
    study.shapes = [];

    io.to(String(studyId)).emit('study_chapter_changed', { chapterId, fen, moves });
  });

  socket.on('leave_study', (studyId) => {
    socket.leave(String(studyId));
    broadcastViewers(io, String(studyId));
  });

  socket.on('disconnecting', async () => {
    for (const room of socket.rooms) {
      if (activeStudies.has(room)) {
        const sockets = await io.in(room).fetchSockets();
        if (sockets) {
          const uniqueViewers = new Map();
          for (const s of sockets) {
            if (s.id === socket.id) continue;
            const uId = s.data?.userId || s.userId;
            const uName = s.data?.userName || s.userName;
            if (uName && uId) {
              uniqueViewers.set(uId, uName);
            }
          }
          const viewers = Array.from(uniqueViewers.values());
          socket.to(room).emit('viewer_list_update', { 
            studyId: room, 
            viewers, 
            count: sockets.length - 1 
          });
        }
      }
    }
  });
}

async function broadcastViewers(io, studyId) {
  const roomId = String(studyId);
  try {
    const sockets = await io.in(roomId).fetchSockets();
    
    if (!sockets) {
      io.to(roomId).emit('viewer_list_update', { studyId, viewers: [], count: 0 });
      return;
    }

    const uniqueViewers = new Map(); // userId -> userName
    for (const s of sockets) {
      const uId = s.data?.userId || s.userId;
      const uName = s.data?.userName || s.userName;
      if (uName && uId) {
        uniqueViewers.set(uId, uName);
      }
    }

    const viewers = Array.from(uniqueViewers.values());
    io.to(roomId).emit('viewer_list_update', { 
      studyId, 
      viewers, 
      count: sockets.length 
    });
  } catch (err) {
    console.error('[Study] broadcastViewers error:', err);
  }
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
