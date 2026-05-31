const activeStudies = new Map(); // studyId -> { ownerId, currentChapterId, fen, moves, shapes }

function setupStudyHandlers(socket, io) {
  socket.on('join_study', (data) => {
    const { studyId, ownerId, initialState, collaboratorIds } = data;
    
    socket.join(String(studyId));
    
    let state = activeStudies.get(String(studyId));
    const isOwner = String(socket.userId) === String(ownerId);

    // Initialize study state if not present OR if owner joins (they have the freshest DB state)
    if (!state || state.ownerId === 'undefined' || state.ownerId === 'null' || isOwner) {
      const newState = {
        ownerId: String(ownerId),
        collaboratorIds: (collaboratorIds || []).map(id => String(id)),
        currentChapterId: initialState?.chapterId || state?.currentChapterId || null,
        fen: initialState?.fen || state?.fen || 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
        moves: initialState?.moves || state?.moves || [],
        shapes: state?.shapes || [],
        isClassActive: state?.isClassActive || false,
        lockHolderId: state?.lockHolderId || null,
      };
      
      activeStudies.set(String(studyId), newState);
      state = newState;
      
      if (isOwner) {
        console.log(`[Study] Owner ${socket.userId} updated state for study ${studyId}`);
      } else {
        console.log(`[Study] Initialized state for study ${studyId}`);
      }
    } else if (collaboratorIds) {
      // Update collaborators list if anyone joins with new list
      state.collaboratorIds = (collaboratorIds || []).map(id => String(id));
    }

    socket.emit('study_synced', state);
    
    console.log(`[Study] User ${socket.userId} (${socket.userName}) joined study ${studyId}`);
    broadcastViewers(io, String(studyId));
  });

  socket.on('study_move', (data) => {
    const { studyId, move, fen, chapterId, moves } = data;
    const study = activeStudies.get(String(studyId));

    if (!study) {
      console.warn(`[Study] study_move received for inactive study ${studyId}`);
      return;
    }
    
    const isOwner = String(socket.userId) === String(study.ownerId);
    const isCollaborator = study.collaboratorIds && study.collaboratorIds.includes(String(socket.userId));
    
    if (!isOwner && !isCollaborator) {
      console.warn(`[Study] Unauthorized move attempt by ${socket.userId} in study ${studyId}`);
      return;
    }

    // Classroom Guard: If a class is active, only the lock holder can move
    if (study.isClassActive && String(socket.userId) !== String(study.lockHolderId)) {
      console.warn(`[Study] Blocked move attempt by ${socket.userId} during active class in room ${studyId}`);
      return;
    }

    // Trust the full tree sent by the owner/collaborator
    if (moves) {
      study.moves = moves;
    }

    study.fen = fen;
    study.currentChapterId = chapterId;
    study.shapes = [];

    io.to(String(studyId)).emit('study_move_made', { ...data, userId: socket.userId });
    console.log(`[Study] Move made in study ${studyId}, chapter ${chapterId} by ${socket.userId}`);
  });

  socket.on('start_class', (data) => {
    const { studyId } = data;
    const study = activeStudies.get(String(studyId));
    if (!study) return;

    const isOwner = String(socket.userId) === String(study.ownerId);
    if (!isOwner) return;

    study.isClassActive = true;
    study.lockHolderId = String(socket.userId); // Owner has the lock by default

    io.to(String(studyId)).emit('class_session_started', {
      isClassActive: true,
      lockHolderId: study.lockHolderId
    });
    console.log(`[Study] Class session started for study ${studyId} by host ${socket.userId}`);
  });

  socket.on('end_class', (data) => {
    const { studyId } = data;
    const study = activeStudies.get(String(studyId));
    if (!study) return;

    const isOwner = String(socket.userId) === String(study.ownerId);
    if (!isOwner) return;

    study.isClassActive = false;
    study.lockHolderId = null;

    io.to(String(studyId)).emit('class_session_ended', {
      isClassActive: false,
      lockHolderId: null
    });
    console.log(`[Study] Class session ended for study ${studyId}`);
  });

  socket.on('grant_board_control', (data) => {
    const { studyId, targetUserId } = data;
    const study = activeStudies.get(String(studyId));
    if (!study) return;

    const isOwner = String(socket.userId) === String(study.ownerId);
    if (!isOwner) return;

    study.lockHolderId = String(targetUserId);

    io.to(String(studyId)).emit('board_control_updated', {
      lockHolderId: study.lockHolderId
    });
    console.log(`[Study] Board control granted in study ${studyId} to ${targetUserId}`);
  });

  socket.on('revoke_board_control', (data) => {
    const { studyId } = data;
    const study = activeStudies.get(String(studyId));
    if (!study) return;

    const isOwner = String(socket.userId) === String(study.ownerId);
    if (!isOwner) return;

    study.lockHolderId = String(study.ownerId); // Revert lock to host

    io.to(String(studyId)).emit('board_control_updated', {
      lockHolderId: study.lockHolderId
    });
    console.log(`[Study] Board control revoked in study ${studyId}, returned to host ${study.ownerId}`);
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

  socket.on('study_send_chat', (data) => {
    const { studyId, text } = data;
    const study = activeStudies.get(String(studyId));
    if (!study) return;

    const message = {
      text,
      senderName: socket.userName || 'Anonymous',
      senderId: socket.userId,
      timestamp: new Date().toISOString()
    };

    io.to(String(studyId)).emit('study_chat_message', message);
  });

  socket.on('study_clear_chat', (data) => {
    const { studyId } = data;
    const study = activeStudies.get(String(studyId));
    if (!study) return;

    io.to(String(studyId)).emit('study_chat_cleared');
  });

  socket.on('update_members', (data) => {
    const { studyId, collaborators } = data;
    const study = activeStudies.get(String(studyId));
    if (study) {
      study.collaboratorIds = (collaborators || []).map(c => String(c.uid || c.id || c.userId));
    }
    socket.to(String(studyId)).emit('members_updated', { collaborators });
  });

  socket.on('leave_study', (studyId) => {
    socket.leave(String(studyId));
    broadcastViewers(io, String(studyId));
  });

  socket.on('disconnecting', async () => {
    for (const room of socket.rooms) {
      if (activeStudies.has(room)) {
        const sockets = await io.in(room).fetchSockets();
        
        // If this was the last person in the room, cleanup the memory
        // (sockets.length <= 1 because the current socket is still in the room while 'disconnecting')
        if (!sockets || sockets.length <= 1) {
          console.log(`[Study] Room ${room} is empty, clearing from memory`);
          activeStudies.delete(room);
        } else {
          const uniqueViewers = new Map();
          for (const s of sockets) {
            if (s.id === socket.id) continue;
            const uId = s.data?.userId || s.userId;
            const uName = s.data?.userName || s.userName;
            if (uName && uId) {
              uniqueViewers.set(uId, uName);
            }
          }
          const viewers = Array.from(uniqueViewers.entries()).map(([userId, userName]) => ({
            userId,
            userName
          }));
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

    const viewers = Array.from(uniqueViewers.entries()).map(([userId, userName]) => ({
      userId,
      userName
    }));
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
