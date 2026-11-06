// src/constants.ts
var WHITE = "w";
var BLACK = "b";
var PAWN = "p";
var KNIGHT = "n";
var BISHOP = "b";
var ROOK = "r";
var QUEEN = "q";
var KING = "k";
var DEFAULT_POSITION = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
var BITS = {
  NORMAL: 1,
  CAPTURE: 2,
  BIG_PAWN: 4,
  EP_CAPTURE: 8,
  PROMOTION: 16,
  KSIDE_CASTLE: 32,
  QSIDE_CASTLE: 64
};
var FLAGS = {
  NORMAL: "n",
  CAPTURE: "c",
  BIG_PAWN: "b",
  EP_CAPTURE: "e",
  PROMOTION: "p",
  EP_PROMOTION: "cp",
  KSIDE_CASTLE: "k",
  QSIDE_CASTLE: "q"
};
var CASTLE_FLAGS = {
  NONE: 0,
  WHITE_OO: 1,
  WHITE_OOO: 2,
  BLACK_OO: 4,
  BLACK_OOO: 8
};
var SQUARES = {
  a8: 0,
  b8: 1,
  c8: 2,
  d8: 3,
  e8: 4,
  f8: 5,
  g8: 6,
  h8: 7,
  a7: 16,
  b7: 17,
  c7: 18,
  d7: 19,
  e7: 20,
  f7: 21,
  g7: 22,
  h7: 23,
  a6: 32,
  b6: 33,
  c6: 34,
  d6: 35,
  e6: 36,
  f6: 37,
  g6: 38,
  h6: 39,
  a5: 48,
  b5: 49,
  c5: 50,
  d5: 51,
  e5: 52,
  f5: 53,
  g5: 54,
  h5: 55,
  a4: 64,
  b4: 65,
  c4: 66,
  d4: 67,
  e4: 68,
  f4: 69,
  g4: 70,
  h4: 71,
  a3: 80,
  b3: 81,
  c3: 82,
  d3: 83,
  e3: 84,
  f3: 85,
  g3: 86,
  h3: 87,
  a2: 96,
  b2: 97,
  c2: 98,
  d2: 99,
  e2: 100,
  f2: 101,
  g2: 102,
  h2: 103,
  a1: 112,
  b1: 113,
  c1: 114,
  d1: 115,
  e1: 116,
  f1: 117,
  g1: 118,
  h1: 119
};
var PIECE_OFFSETS = {
  [KNIGHT]: [-33, -31, -18, -14, 14, 18, 31, 33],
  [BISHOP]: [-17, -15, 15, 17],
  [ROOK]: [-16, -1, 1, 16],
  [QUEEN]: [-17, -16, -15, -1, 1, 15, 16, 17],
  [KING]: [-17, -16, -15, -1, 1, 15, 16, 17]
};
var ROOKS = {
  [WHITE]: {
    k: { from: SQUARES.e1, to: SQUARES.g1, rookFrom: SQUARES.h1, rookTo: SQUARES.f1, empty: [SQUARES.f1, SQUARES.g1], test: [SQUARES.e1, SQUARES.f1, SQUARES.g1] },
    q: { from: SQUARES.e1, to: SQUARES.c1, rookFrom: SQUARES.a1, rookTo: SQUARES.d1, empty: [SQUARES.b1, SQUARES.c1, SQUARES.d1], test: [SQUARES.e1, SQUARES.d1, SQUARES.c1] }
  },
  [BLACK]: {
    k: { from: SQUARES.e8, to: SQUARES.g8, rookFrom: SQUARES.h8, rookTo: SQUARES.f8, empty: [SQUARES.f8, SQUARES.g8], test: [SQUARES.e8, SQUARES.f8, SQUARES.g8] },
    q: { from: SQUARES.e8, to: SQUARES.c8, rookFrom: SQUARES.a8, rookTo: SQUARES.d8, empty: [SQUARES.b8, SQUARES.c8, SQUARES.d8], test: [SQUARES.e8, SQUARES.d8, SQUARES.c8] }
  }
};

// src/utils.ts
var ALGEBRAIC_MAP = new Array(128);
var SQUARE_NAMES = Object.keys(SQUARES);
for (const name of SQUARE_NAMES) {
  const index = SQUARES[name];
  ALGEBRAIC_MAP[index] = name;
}
function isSquareOnBoard(sq) {
  return (sq & 136) === 0;
}
function squareToAlgebraic(sq) {
  return ALGEBRAIC_MAP[sq];
}
function algebraicToSquare(name) {
  if (name in SQUARES) {
    return SQUARES[name];
  }
  return -1;
}
function rank(sq) {
  return sq >> 4;
}
function chessRank(sq) {
  return 8 - (sq >> 4);
}
function file(sq) {
  return sq & 15;
}
function swapColor(color) {
  return color === WHITE ? BLACK : WHITE;
}
function fenCharToPiece(char) {
  const lower = char.toLowerCase();
  if (!["p", "n", "b", "r", "q", "k"].includes(lower)) return null;
  return {
    type: lower,
    color: char === char.toUpperCase() ? WHITE : BLACK
  };
}
function pieceToFenChar(piece) {
  return piece.color === WHITE ? piece.type.toUpperCase() : piece.type.toLowerCase();
}

// src/fen.ts
function validateFen(fen) {
  if (typeof fen !== "string") {
    return { ok: false, error: "FEN must be a string" };
  }
  const tokens = fen.trim().split(/\s+/);
  if (tokens.length !== 4 && tokens.length !== 6) {
    return { ok: false, error: "Invalid FEN: must contain 4 or 6 space-delimited fields" };
  }
  const [pieces, turn, castling, epSquare] = tokens;
  const ranks = pieces.split("/");
  if (ranks.length !== 8) {
    return { ok: false, error: "Invalid piece placement: must contain 8 ranks separated by /" };
  }
  let whiteKings = 0;
  let blackKings = 0;
  for (let r = 0; r < 8; r++) {
    const row = ranks[r];
    let squareCount = 0;
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      if (c >= "1" && c <= "8") {
        squareCount += parseInt(c, 10);
      } else if ("pnbrqkPNBRQK".includes(c)) {
        squareCount += 1;
        if (c === "K") whiteKings++;
        if (c === "k") blackKings++;
        if ((c === "p" || c === "P") && (r === 0 || r === 7)) {
          return { ok: false, error: "Invalid FEN: pawns cannot be placed on the first or eighth rank" };
        }
      } else {
        return { ok: false, error: `Invalid character "${c}" in piece placement` };
      }
    }
    if (squareCount !== 8) {
      return { ok: false, error: `Rank ${8 - r} does not describe exactly 8 squares (got ${squareCount})` };
    }
  }
  if (whiteKings !== 1) {
    return { ok: false, error: `Invalid number of white kings: expected 1, found ${whiteKings}` };
  }
  if (blackKings !== 1) {
    return { ok: false, error: `Invalid number of black kings: expected 1, found ${blackKings}` };
  }
  if (turn !== "w" && turn !== "b") {
    return { ok: false, error: `Invalid side to move: "${turn}" (must be "w" or "b")` };
  }
  if (!/^(-|[KQkq]{1,4})$/.test(castling)) {
    return { ok: false, error: `Invalid castling availability: "${castling}"` };
  }
  if (epSquare !== "-") {
    const sq = algebraicToSquare(epSquare);
    if (sq === -1) {
      return { ok: false, error: `Invalid en-passant square: "${epSquare}"` };
    }
    const r = rank(sq);
    if (turn === "w" && r !== 2 || turn === "b" && r !== 5) {
      return { ok: false, error: `Illegal en-passant square "${epSquare}" for active turn "${turn}"` };
    }
  }
  if (tokens.length === 6) {
    const half = parseInt(tokens[4], 10);
    if (isNaN(half) || half < 0) {
      return { ok: false, error: `Invalid half-move clock: "${tokens[4]}"` };
    }
    const full = parseInt(tokens[5], 10);
    if (isNaN(full) || full <= 0) {
      return { ok: false, error: `Invalid full-move counter: "${tokens[5]}"` };
    }
  }
  return { ok: true };
}
function parseFen(fen) {
  const validation = validateFen(fen);
  if (!validation.ok) {
    throw new Error(validation.error || "Invalid FEN");
  }
  const tokens = fen.trim().split(/\s+/);
  const [pieces, turnStr, castlingStr, epStr] = tokens;
  const board = new Array(128).fill(null);
  const ranks = pieces.split("/");
  for (let r = 0; r < 8; r++) {
    const row = ranks[r];
    let fileIndex = 0;
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      if (c >= "1" && c <= "8") {
        fileIndex += parseInt(c, 10);
      } else {
        const sq = (r << 4) + fileIndex;
        board[sq] = fenCharToPiece(c);
        fileIndex += 1;
      }
    }
  }
  const turn = turnStr === "w" ? WHITE : BLACK;
  let castling = CASTLE_FLAGS.NONE;
  if (castlingStr.includes("K")) castling |= CASTLE_FLAGS.WHITE_OO;
  if (castlingStr.includes("Q")) castling |= CASTLE_FLAGS.WHITE_OOO;
  if (castlingStr.includes("k")) castling |= CASTLE_FLAGS.BLACK_OO;
  if (castlingStr.includes("q")) castling |= CASTLE_FLAGS.BLACK_OOO;
  const epSquare = epStr === "-" ? -1 : algebraicToSquare(epStr);
  const halfMoves = tokens.length === 6 ? parseInt(tokens[4], 10) : 0;
  const fullMoves = tokens.length === 6 ? parseInt(tokens[5], 10) : 1;
  return {
    board,
    turn,
    castling,
    epSquare,
    halfMoves,
    fullMoves
  };
}
function buildFen(board, turn, castling, epSquare, halfMoves, fullMoves) {
  const ranks = [];
  for (let r = 0; r < 8; r++) {
    let emptyCount = 0;
    let rankStr = "";
    for (let f = 0; f < 8; f++) {
      const sq = (r << 4) + f;
      const piece = board[sq];
      if (piece === null) {
        emptyCount++;
      } else {
        if (emptyCount > 0) {
          rankStr += emptyCount;
          emptyCount = 0;
        }
        rankStr += pieceToFenChar(piece);
      }
    }
    if (emptyCount > 0) {
      rankStr += emptyCount;
    }
    ranks.push(rankStr);
  }
  const piecePlacement = ranks.join("/");
  const turnStr = turn;
  let castlingStr = "";
  if (castling & CASTLE_FLAGS.WHITE_OO) castlingStr += "K";
  if (castling & CASTLE_FLAGS.WHITE_OOO) castlingStr += "Q";
  if (castling & CASTLE_FLAGS.BLACK_OO) castlingStr += "k";
  if (castling & CASTLE_FLAGS.BLACK_OOO) castlingStr += "q";
  if (!castlingStr) castlingStr = "-";
  const epStr = epSquare === -1 || !isSquareOnBoard(epSquare) ? "-" : squareToAlgebraic(epSquare);
  return `${piecePlacement} ${turnStr} ${castlingStr} ${epStr} ${halfMoves} ${fullMoves}`;
}

// src/move-generator.ts
function isSquareAttacked(board, sq, attackingColor) {
  const pawnAttackOffsets = attackingColor === WHITE ? [15, 17] : [-17, -15];
  for (const offset of pawnAttackOffsets) {
    const fromSq = sq + offset;
    if (isSquareOnBoard(fromSq)) {
      const p = board[fromSq];
      if (p && p.color === attackingColor && p.type === PAWN) {
        return true;
      }
    }
  }
  for (const offset of PIECE_OFFSETS[KNIGHT]) {
    const fromSq = sq + offset;
    if (isSquareOnBoard(fromSq)) {
      const p = board[fromSq];
      if (p && p.color === attackingColor && p.type === KNIGHT) {
        return true;
      }
    }
  }
  for (const offset of PIECE_OFFSETS[BISHOP]) {
    let fromSq = sq + offset;
    while (isSquareOnBoard(fromSq)) {
      const p = board[fromSq];
      if (p) {
        if (p.color === attackingColor && (p.type === BISHOP || p.type === QUEEN)) {
          return true;
        }
        break;
      }
      fromSq += offset;
    }
  }
  for (const offset of PIECE_OFFSETS[ROOK]) {
    let fromSq = sq + offset;
    while (isSquareOnBoard(fromSq)) {
      const p = board[fromSq];
      if (p) {
        if (p.color === attackingColor && (p.type === ROOK || p.type === QUEEN)) {
          return true;
        }
        break;
      }
      fromSq += offset;
    }
  }
  for (const offset of PIECE_OFFSETS[KING]) {
    const fromSq = sq + offset;
    if (isSquareOnBoard(fromSq)) {
      const p = board[fromSq];
      if (p && p.color === attackingColor && p.type === KING) {
        return true;
      }
    }
  }
  return false;
}
function findKingSquare(board, color) {
  for (let sq = 0; sq < 128; sq++) {
    if (!isSquareOnBoard(sq)) continue;
    const p = board[sq];
    if (p && p.type === KING && p.color === color) {
      return sq;
    }
  }
  return -1;
}
function isColorInCheck(board, color) {
  const kingSq = findKingSquare(board, color);
  if (kingSq === -1) return false;
  return isSquareAttacked(board, kingSq, swapColor(color));
}
function generatePseudolegalMoves(board, turn, castling, epSquare, fromFilterSquare) {
  const moves = [];
  const opponent = swapColor(turn);
  const startSq = fromFilterSquare !== void 0 ? fromFilterSquare : 0;
  const endSq = fromFilterSquare !== void 0 ? fromFilterSquare : 127;
  for (let sq = startSq; sq <= endSq; sq++) {
    if (!isSquareOnBoard(sq)) continue;
    const piece = board[sq];
    if (!piece || piece.color !== turn) continue;
    const pieceType = piece.type;
    if (pieceType === PAWN) {
      const forwardOffset = turn === WHITE ? -16 : 16;
      const startRank = turn === WHITE ? 6 : 1;
      const promoRank = turn === WHITE ? 0 : 7;
      const currentRank = rank(sq);
      const nextSq = sq + forwardOffset;
      if (isSquareOnBoard(nextSq) && board[nextSq] === null) {
        if (rank(nextSq) === promoRank) {
          for (const promo of [QUEEN, ROOK, BISHOP, KNIGHT]) {
            moves.push({
              color: turn,
              from: sq,
              to: nextSq,
              flags: BITS.PROMOTION,
              piece: PAWN,
              promotion: promo
            });
          }
        } else {
          moves.push({
            color: turn,
            from: sq,
            to: nextSq,
            flags: BITS.NORMAL,
            piece: PAWN
          });
          const doubleSq = nextSq + forwardOffset;
          if (currentRank === startRank && board[doubleSq] === null) {
            moves.push({
              color: turn,
              from: sq,
              to: doubleSq,
              flags: BITS.BIG_PAWN,
              piece: PAWN
            });
          }
        }
      }
      const captureOffsets = turn === WHITE ? [-17, -15] : [15, 17];
      for (const capOffset of captureOffsets) {
        const targetSq = sq + capOffset;
        if (!isSquareOnBoard(targetSq)) continue;
        const targetPiece = board[targetSq];
        if (targetPiece && targetPiece.color === opponent) {
          if (rank(targetSq) === promoRank) {
            for (const promo of [QUEEN, ROOK, BISHOP, KNIGHT]) {
              moves.push({
                color: turn,
                from: sq,
                to: targetSq,
                flags: BITS.PROMOTION | BITS.CAPTURE,
                piece: PAWN,
                captured: targetPiece.type,
                promotion: promo
              });
            }
          } else {
            moves.push({
              color: turn,
              from: sq,
              to: targetSq,
              flags: BITS.CAPTURE,
              piece: PAWN,
              captured: targetPiece.type
            });
          }
        } else if (targetSq === epSquare) {
          moves.push({
            color: turn,
            from: sq,
            to: targetSq,
            flags: BITS.EP_CAPTURE | BITS.CAPTURE,
            piece: PAWN,
            captured: PAWN
          });
        }
      }
    } else if (pieceType === KNIGHT) {
      for (const offset of PIECE_OFFSETS[KNIGHT]) {
        const targetSq = sq + offset;
        if (!isSquareOnBoard(targetSq)) continue;
        const targetPiece = board[targetSq];
        if (targetPiece === null) {
          moves.push({
            color: turn,
            from: sq,
            to: targetSq,
            flags: BITS.NORMAL,
            piece: KNIGHT
          });
        } else if (targetPiece.color === opponent) {
          moves.push({
            color: turn,
            from: sq,
            to: targetSq,
            flags: BITS.CAPTURE,
            piece: KNIGHT,
            captured: targetPiece.type
          });
        }
      }
    } else if (pieceType === BISHOP || pieceType === ROOK || pieceType === QUEEN) {
      const offsets = pieceType === BISHOP ? PIECE_OFFSETS[BISHOP] : pieceType === ROOK ? PIECE_OFFSETS[ROOK] : PIECE_OFFSETS[QUEEN];
      for (const offset of offsets) {
        let targetSq = sq + offset;
        while (isSquareOnBoard(targetSq)) {
          const targetPiece = board[targetSq];
          if (targetPiece === null) {
            moves.push({
              color: turn,
              from: sq,
              to: targetSq,
              flags: BITS.NORMAL,
              piece: pieceType
            });
          } else {
            if (targetPiece.color === opponent) {
              moves.push({
                color: turn,
                from: sq,
                to: targetSq,
                flags: BITS.CAPTURE,
                piece: pieceType,
                captured: targetPiece.type
              });
            }
            break;
          }
          targetSq += offset;
        }
      }
    } else if (pieceType === KING) {
      for (const offset of PIECE_OFFSETS[KING]) {
        const targetSq = sq + offset;
        if (!isSquareOnBoard(targetSq)) continue;
        const targetPiece = board[targetSq];
        if (targetPiece === null) {
          moves.push({
            color: turn,
            from: sq,
            to: targetSq,
            flags: BITS.NORMAL,
            piece: KING
          });
        } else if (targetPiece.color === opponent) {
          moves.push({
            color: turn,
            from: sq,
            to: targetSq,
            flags: BITS.CAPTURE,
            piece: KING,
            captured: targetPiece.type
          });
        }
      }
      if (fromFilterSquare === void 0 || fromFilterSquare === sq) {
        if (!isSquareAttacked(board, sq, opponent)) {
          const castlingDef = ROOKS[turn];
          const ksideFlag = turn === WHITE ? CASTLE_FLAGS.WHITE_OO : CASTLE_FLAGS.BLACK_OO;
          if (castling & ksideFlag) {
            const kside = castlingDef.k;
            const rookPiece = board[kside.rookFrom];
            if (rookPiece && rookPiece.type === ROOK && rookPiece.color === turn) {
              const empty = kside.empty.every((s) => board[s] === null);
              if (empty) {
                const safe = kside.test.every((s) => !isSquareAttacked(board, s, opponent));
                if (safe) {
                  moves.push({
                    color: turn,
                    from: sq,
                    to: kside.to,
                    flags: BITS.KSIDE_CASTLE,
                    piece: KING
                  });
                }
              }
            }
          }
          const qsideFlag = turn === WHITE ? CASTLE_FLAGS.WHITE_OOO : CASTLE_FLAGS.BLACK_OOO;
          if (castling & qsideFlag) {
            const qside = castlingDef.q;
            const rookPiece = board[qside.rookFrom];
            if (rookPiece && rookPiece.type === ROOK && rookPiece.color === turn) {
              const empty = qside.empty.every((s) => board[s] === null);
              if (empty) {
                const safe = qside.test.every((s) => !isSquareAttacked(board, s, opponent));
                if (safe) {
                  moves.push({
                    color: turn,
                    from: sq,
                    to: qside.to,
                    flags: BITS.QSIDE_CASTLE,
                    piece: KING
                  });
                }
              }
            }
          }
        }
      }
    }
  }
  return moves;
}
function applyMoveInternal(board, move) {
  const movingPiece = board[move.from];
  let capturedPiece = null;
  let epSquareCaptured = -1;
  if (move.flags & BITS.EP_CAPTURE) {
    const epCapOffset = move.color === WHITE ? 16 : -16;
    epSquareCaptured = move.to + epCapOffset;
    capturedPiece = board[epSquareCaptured];
    board[epSquareCaptured] = null;
  } else if (move.flags & BITS.CAPTURE) {
    capturedPiece = board[move.to];
  }
  board[move.from] = null;
  if (move.flags & BITS.PROMOTION) {
    board[move.to] = {
      type: move.promotion || QUEEN,
      color: move.color
    };
  } else {
    board[move.to] = movingPiece;
  }
  if (move.flags & BITS.KSIDE_CASTLE) {
    const rookFrom = move.color === WHITE ? SQUARES.h1 : SQUARES.h8;
    const rookTo = move.color === WHITE ? SQUARES.f1 : SQUARES.f8;
    board[rookTo] = board[rookFrom];
    board[rookFrom] = null;
  } else if (move.flags & BITS.QSIDE_CASTLE) {
    const rookFrom = move.color === WHITE ? SQUARES.a1 : SQUARES.a8;
    const rookTo = move.color === WHITE ? SQUARES.d1 : SQUARES.d8;
    board[rookTo] = board[rookFrom];
    board[rookFrom] = null;
  }
  return { capturedPiece, epSquareCaptured };
}
function unapplyMoveInternal(board, move, undo) {
  if (move.flags & BITS.KSIDE_CASTLE) {
    const rookFrom = move.color === WHITE ? SQUARES.h1 : SQUARES.h8;
    const rookTo = move.color === WHITE ? SQUARES.f1 : SQUARES.f8;
    board[rookFrom] = board[rookTo];
    board[rookTo] = null;
  } else if (move.flags & BITS.QSIDE_CASTLE) {
    const rookFrom = move.color === WHITE ? SQUARES.a1 : SQUARES.a8;
    const rookTo = move.color === WHITE ? SQUARES.d1 : SQUARES.d8;
    board[rookFrom] = board[rookTo];
    board[rookTo] = null;
  }
  board[move.from] = {
    type: move.piece,
    color: move.color
  };
  if (move.flags & BITS.EP_CAPTURE) {
    board[move.to] = null;
    board[undo.epSquareCaptured] = undo.capturedPiece;
  } else {
    board[move.to] = undo.capturedPiece;
  }
}
function generateLegalMoves(board, turn, castling, epSquare, fromFilterSquare) {
  const pseudoMoves = generatePseudolegalMoves(board, turn, castling, epSquare, fromFilterSquare);
  const legalMoves = [];
  for (const move of pseudoMoves) {
    const undo = applyMoveInternal(board, move);
    const inCheck = isColorInCheck(board, turn);
    unapplyMoveInternal(board, move, undo);
    if (!inCheck) {
      legalMoves.push(move);
    }
  }
  return legalMoves;
}

// src/san.ts
var FILES = "abcdefgh";
function moveToSan(board, turn, castling, epSquare, move, legalMoves) {
  if (move.flags & BITS.KSIDE_CASTLE) {
    return appendCheckOrCheckmate(board, turn, castling, epSquare, move, "O-O");
  }
  if (move.flags & BITS.QSIDE_CASTLE) {
    return appendCheckOrCheckmate(board, turn, castling, epSquare, move, "O-O-O");
  }
  let san = "";
  const pieceType = move.piece;
  const toAlgebraic = squareToAlgebraic(move.to);
  if (pieceType === PAWN) {
    if (move.flags & BITS.CAPTURE) {
      const fromFile = FILES[file(move.from)];
      san += `${fromFile}x${toAlgebraic}`;
    } else {
      san += toAlgebraic;
    }
    if (move.flags & BITS.PROMOTION && move.promotion) {
      san += `=${move.promotion.toUpperCase()}`;
    }
    return appendCheckOrCheckmate(board, turn, castling, epSquare, move, san);
  }
  san += pieceType.toUpperCase();
  if (pieceType !== KING) {
    const allLegals = legalMoves || generateLegalMoves(board, turn, castling, epSquare);
    const ambiguousMoves = allLegals.filter(
      (m) => m.from !== move.from && m.to === move.to && m.piece === pieceType && m.color === turn
    );
    if (ambiguousMoves.length > 0) {
      const moveFromFile = file(move.from);
      const moveFromRank = chessRank(move.from);
      const sameFile = ambiguousMoves.some((m) => file(m.from) === moveFromFile);
      const sameRank = ambiguousMoves.some((m) => chessRank(m.from) === moveFromRank);
      if (!sameFile) {
        san += FILES[moveFromFile];
      } else if (!sameRank) {
        san += moveFromRank.toString();
      } else {
        san += `${FILES[moveFromFile]}${moveFromRank}`;
      }
    }
  }
  if (move.flags & BITS.CAPTURE) {
    san += "x";
  }
  san += toAlgebraic;
  return appendCheckOrCheckmate(board, turn, castling, epSquare, move, san);
}
function appendCheckOrCheckmate(board, turn, castling, epSquare, move, san) {
  const undo = applyMoveInternal(board, move);
  const opponent = swapColor(turn);
  const inCheck = isColorInCheck(board, opponent);
  let isMate = false;
  if (inCheck) {
    const nextLegals = generateLegalMoves(board, opponent, castling, -1);
    if (nextLegals.length === 0) {
      isMate = true;
    }
  }
  unapplyMoveInternal(board, move, undo);
  if (isMate) {
    return san + "#";
  }
  if (inCheck) {
    return san + "+";
  }
  return san;
}
function parseSan(board, turn, castling, epSquare, sanString) {
  const clean = sanString.trim().replace(/[+#!?]/g, "");
  const legalMoves = generateLegalMoves(board, turn, castling, epSquare);
  for (const move of legalMoves) {
    const generatedSan = moveToSan(board, turn, castling, epSquare, move, legalMoves);
    const generatedClean = generatedSan.replace(/[+#!?]/g, "");
    if (clean === generatedClean || clean === generatedSan) {
      return move;
    }
  }
  const uciMatch = clean.match(/^([a-h][1-8])[-x]?([a-h][1-8])(=?[qrbnQRBN])?$/);
  if (uciMatch) {
    const from = algebraicToSquare(uciMatch[1]);
    const to = algebraicToSquare(uciMatch[2]);
    const promo = uciMatch[3] ? uciMatch[3].replace("=", "").toLowerCase() : void 0;
    for (const move of legalMoves) {
      if (move.from === from && move.to === to) {
        if (promo) {
          if (move.promotion === promo) return move;
        } else if (!move.promotion || move.promotion === QUEEN) {
          return move;
        }
      }
    }
  }
  return null;
}

// src/position.ts
function formatMoveFlags(flags) {
  if (flags & BITS.KSIDE_CASTLE) return FLAGS.KSIDE_CASTLE;
  if (flags & BITS.QSIDE_CASTLE) return FLAGS.QSIDE_CASTLE;
  if (flags & BITS.EP_CAPTURE) return FLAGS.EP_CAPTURE;
  if (flags & BITS.BIG_PAWN) return FLAGS.BIG_PAWN;
  if (flags & BITS.PROMOTION) {
    return flags & BITS.CAPTURE ? FLAGS.EP_PROMOTION : FLAGS.PROMOTION;
  }
  if (flags & BITS.CAPTURE) return FLAGS.CAPTURE;
  return FLAGS.NORMAL;
}
var PositionState = class {
  board = new Array(128).fill(null);
  turn = WHITE;
  castling = CASTLE_FLAGS.NONE;
  epSquare = -1;
  halfMoves = 0;
  fullMoves = 1;
  history = [];
  positionCounts = /* @__PURE__ */ new Map();
  constructor(fen = DEFAULT_POSITION) {
    this.load(fen);
  }
  /**
   * Resets position to initial standard starting chess layout.
   */
  reset() {
    this.load(DEFAULT_POSITION);
  }
  /**
   * Clears the board completely.
   */
  clear() {
    this.board.fill(null);
    this.turn = WHITE;
    this.castling = CASTLE_FLAGS.NONE;
    this.epSquare = -1;
    this.halfMoves = 0;
    this.fullMoves = 1;
    this.history = [];
    this.positionCounts.clear();
  }
  /**
   * Loads a position from a FEN string.
   */
  load(fen) {
    const parsed = parseFen(fen);
    this.board = parsed.board;
    this.turn = parsed.turn;
    this.castling = parsed.castling;
    this.epSquare = parsed.epSquare;
    this.halfMoves = parsed.halfMoves;
    this.fullMoves = parsed.fullMoves;
    this.history = [];
    this.positionCounts.clear();
    this.recordPositionKey();
  }
  /**
   * Returns current FEN string.
   */
  fen() {
    return buildFen(
      this.board,
      this.turn,
      this.castling,
      this.epSquare,
      this.halfMoves,
      this.fullMoves
    );
  }
  /**
   * Generates position repetition key (pieces + turn + castling + epSquare).
   */
  getPositionKey() {
    const fen = this.fen();
    const parts = fen.split(" ");
    return `${parts[0]} ${parts[1]} ${parts[2]} ${parts[3]}`;
  }
  recordPositionKey() {
    const key = this.getPositionKey();
    const count = (this.positionCounts.get(key) || 0) + 1;
    this.positionCounts.set(key, count);
  }
  decrementPositionKey() {
    const key = this.getPositionKey();
    const count = (this.positionCounts.get(key) || 0) - 1;
    if (count <= 0) {
      this.positionCounts.delete(key);
    } else {
      this.positionCounts.set(key, count);
    }
  }
  /**
   * Generates all legal moves for current position.
   */
  moves(options) {
    let fromFilterSquare;
    if (options?.square) {
      fromFilterSquare = algebraicToSquare(options.square);
      if (fromFilterSquare === -1) return [];
    }
    let legals = generateLegalMoves(this.board, this.turn, this.castling, this.epSquare, fromFilterSquare);
    if (options?.piece) {
      legals = legals.filter((m) => m.piece === options.piece);
    }
    if (options?.verbose) {
      return legals.map((m) => this.toVerboseMove(m, legals));
    }
    return legals.map((m) => moveToSan(this.board, this.turn, this.castling, this.epSquare, m, legals));
  }
  /**
   * Converts internal move to VerboseMove structure.
   */
  toVerboseMove(m, legalMoves) {
    const from = squareToAlgebraic(m.from);
    const to = squareToAlgebraic(m.to);
    const san = moveToSan(this.board, this.turn, this.castling, this.epSquare, m, legalMoves);
    const lan = `${from}${to}${m.promotion ? m.promotion.toLowerCase() : ""}`;
    const flags = formatMoveFlags(m.flags);
    const beforeFen = this.fen();
    const undo = applyMoveInternal(this.board, m);
    const afterFen = buildFen(
      this.board,
      swapColor(this.turn),
      this.castling,
      -1,
      this.halfMoves + 1,
      this.fullMoves + (this.turn === BLACK ? 1 : 0)
    );
    unapplyMoveInternal(this.board, m, undo);
    return {
      color: m.color,
      from,
      to,
      piece: m.piece,
      captured: m.captured,
      promotion: m.promotion,
      flags,
      san,
      lan,
      before: beforeFen,
      after: afterFen
    };
  }
  /**
   * Executes a move on the position. Accepts SAN string or MoveInput object.
   */
  makeMove(moveInput) {
    let move = null;
    const legals = generateLegalMoves(this.board, this.turn, this.castling, this.epSquare);
    if (typeof moveInput === "string") {
      move = parseSan(this.board, this.turn, this.castling, this.epSquare, moveInput);
    } else if (moveInput && typeof moveInput === "object") {
      const from = algebraicToSquare(moveInput.from);
      const to = algebraicToSquare(moveInput.to);
      const promo = moveInput.promotion ? moveInput.promotion.toLowerCase() : void 0;
      for (const m of legals) {
        if (m.from === from && m.to === to) {
          if (m.promotion) {
            if (promo) {
              if (m.promotion === promo) {
                move = m;
                break;
              }
            } else {
              if (m.promotion === QUEEN) {
                move = m;
                break;
              }
            }
          } else {
            move = m;
            break;
          }
        }
      }
    }
    if (!move) {
      return null;
    }
    const beforeFen = this.fen();
    const san = moveToSan(this.board, this.turn, this.castling, this.epSquare, move, legals);
    const prevCastling = this.castling;
    const prevEpSquare = this.epSquare;
    const prevHalfMoves = this.halfMoves;
    const undo = applyMoveInternal(this.board, move);
    if (move.piece === PAWN || move.flags & BITS.CAPTURE) {
      this.halfMoves = 0;
    } else {
      this.halfMoves++;
    }
    if (this.turn === BLACK) {
      this.fullMoves++;
    }
    if (move.flags & BITS.BIG_PAWN) {
      this.epSquare = move.color === WHITE ? move.from - 16 : move.from + 16;
    } else {
      this.epSquare = -1;
    }
    if (move.piece === KING) {
      if (move.color === WHITE) {
        this.castling &= -4;
      } else {
        this.castling &= -13;
      }
    }
    if (move.from === SQUARES.h1 || move.to === SQUARES.h1) {
      this.castling &= -2;
    }
    if (move.from === SQUARES.a1 || move.to === SQUARES.a1) {
      this.castling &= -3;
    }
    if (move.from === SQUARES.h8 || move.to === SQUARES.h8) {
      this.castling &= -5;
    }
    if (move.from === SQUARES.a8 || move.to === SQUARES.a8) {
      this.castling &= -9;
    }
    this.turn = swapColor(this.turn);
    const afterFen = this.fen();
    const historyItem = {
      move,
      san,
      beforeFen,
      afterFen,
      castling: prevCastling,
      epSquare: prevEpSquare,
      halfMoves: prevHalfMoves,
      undo
    };
    this.history.push(historyItem);
    this.recordPositionKey();
    return {
      color: move.color,
      from: squareToAlgebraic(move.from),
      to: squareToAlgebraic(move.to),
      piece: move.piece,
      captured: move.captured,
      promotion: move.promotion,
      flags: formatMoveFlags(move.flags),
      san,
      lan: `${squareToAlgebraic(move.from)}${squareToAlgebraic(move.to)}${move.promotion || ""}`,
      before: beforeFen,
      after: afterFen
    };
  }
  /**
   * Undoes the last move made.
   */
  undoMove() {
    const item = this.history.pop();
    if (!item) return null;
    this.decrementPositionKey();
    unapplyMoveInternal(this.board, item.move, item.undo);
    this.turn = swapColor(this.turn);
    if (this.turn === BLACK) {
      this.fullMoves--;
    }
    this.castling = item.castling;
    this.epSquare = item.epSquare;
    this.halfMoves = item.halfMoves;
    return {
      color: item.move.color,
      from: squareToAlgebraic(item.move.from),
      to: squareToAlgebraic(item.move.to),
      piece: item.move.piece,
      captured: item.move.captured,
      promotion: item.move.promotion,
      flags: item.san.includes("O-O-O") ? "q" : item.san.includes("O-O") ? "k" : item.move.flags & BITS.CAPTURE ? "c" : "n",
      san: item.san,
      lan: `${squareToAlgebraic(item.move.from)}${squareToAlgebraic(item.move.to)}${item.move.promotion || ""}`,
      before: item.beforeFen,
      after: item.afterFen
    };
  }
  /**
   * Checks if a King is currently in check.
   * If color is provided, checks for that specific color (Bughouse extension).
   * If omitted, checks for the side whose turn it is.
   */
  isCheck(color) {
    const targetColor = color || this.turn;
    return isColorInCheck(this.board, targetColor);
  }
  /**
   * Returns true if active side is in checkmate.
   */
  isCheckmate() {
    return this.isCheck() && generateLegalMoves(this.board, this.turn, this.castling, this.epSquare).length === 0;
  }
  /**
   * Returns true if active side is in stalemate.
   */
  isStalemate() {
    return !this.isCheck() && generateLegalMoves(this.board, this.turn, this.castling, this.epSquare).length === 0;
  }
  /**
   * Returns true if the position has occurred 3 or more times.
   */
  isThreefoldRepetition() {
    const key = this.getPositionKey();
    return (this.positionCounts.get(key) || 0) >= 3;
  }
  /**
   * Returns true if neither side has sufficient material to checkmate.
   */
  isInsufficientMaterial() {
    const pieces = [];
    for (let sq = 0; sq < 128; sq++) {
      if (!isSquareOnBoard(sq)) continue;
      const p = this.board[sq];
      if (p) {
        pieces.push({ piece: p, sq });
      }
    }
    if (pieces.length === 2) return true;
    if (pieces.length === 3) {
      const nonKings = pieces.filter((item) => item.piece.type !== KING);
      if (nonKings.length === 1) {
        const type = nonKings[0].piece.type;
        if (type === BISHOP || type === KNIGHT) {
          return true;
        }
      }
    }
    if (pieces.length === 4) {
      const bishops = pieces.filter((item) => item.piece.type === BISHOP);
      if (bishops.length === 2) {
        const b1 = bishops[0];
        const b2 = bishops[1];
        if (b1.piece.color !== b2.piece.color) {
          const sqColor1 = (rank(b1.sq) + file(b1.sq)) % 2;
          const sqColor2 = (rank(b2.sq) + file(b2.sq)) % 2;
          if (sqColor1 === sqColor2) {
            return true;
          }
        }
      }
    }
    return false;
  }
  /**
   * Returns true if the game is drawn by 50-move rule, stalemate, repetition, or insufficient material.
   */
  isDraw() {
    return this.halfMoves >= 100 || this.isStalemate() || this.isThreefoldRepetition() || this.isInsufficientMaterial();
  }
  /**
   * Returns true if game is over (checkmate or draw).
   */
  isGameOver() {
    return this.isCheckmate() || this.isDraw();
  }
  /**
   * Square queries and mutations
   */
  get(square) {
    const sq = algebraicToSquare(square);
    if (sq === -1) return null;
    return this.board[sq] ? { ...this.board[sq] } : null;
  }
  put(piece, square) {
    const sq = algebraicToSquare(square);
    if (sq === -1) return false;
    if (!piece || !["p", "n", "b", "r", "q", "k"].includes(piece.type)) return false;
    if (!["w", "b"].includes(piece.color)) return false;
    if (piece.type === PAWN && (rank(sq) === 0 || rank(sq) === 7)) {
      return false;
    }
    this.board[sq] = { type: piece.type, color: piece.color };
    this.positionCounts.clear();
    this.recordPositionKey();
    return true;
  }
  remove(square) {
    const sq = algebraicToSquare(square);
    if (sq === -1) return null;
    const p = this.board[sq];
    this.board[sq] = null;
    this.positionCounts.clear();
    this.recordPositionKey();
    return p ? { ...p } : null;
  }
  boardRepresentation() {
    const grid = [];
    for (let r = 0; r < 8; r++) {
      const row = [];
      for (let f = 0; f < 8; f++) {
        const sq = (r << 4) + f;
        const p = this.board[sq];
        row.push(p ? { ...p } : null);
      }
      grid.push(row);
    }
    return grid;
  }
};

// src/tags.ts
var CANONICAL_PGN_TAGS = [
  // 1. Seven Tag Roster (STR)
  "Event",
  "Site",
  "Date",
  "Round",
  "White",
  "Black",
  "Result",
  // 2. Player Attributes
  "WhiteElo",
  "BlackElo",
  "WhiteTitle",
  "BlackTitle",
  "WhiteTeam",
  "BlackTeam",
  "WhiteFideId",
  "BlackFideId",
  // 3. Game Conditions & Metadata
  "TimeControl",
  "Termination",
  "ECO",
  "Board",
  "Annotator",
  "GameId",
  // 4. Setup & Variant
  "SetUp",
  "FEN",
  "Variant"
];
var CANONICAL_TAG_MAP = /* @__PURE__ */ new Map();
for (const tag of CANONICAL_PGN_TAGS) {
  CANONICAL_TAG_MAP.set(tag.toLowerCase(), tag);
}
CANONICAL_TAG_MAP.set("ecocode", "ECO");
CANONICAL_TAG_MAP.set("tournament", "Event");
CANONICAL_TAG_MAP.set("time_control", "TimeControl");
function normalizeTagKey(key) {
  const trimmed = key.trim();
  const canonical = CANONICAL_TAG_MAP.get(trimmed.toLowerCase());
  return canonical || trimmed;
}
function cleanTagValue(value) {
  if (value === null || value === void 0) return null;
  const str = String(value).trim();
  if (str === "" || str === "?" || str.toLowerCase() === "unknown") {
    return null;
  }
  return str.slice(0, 140);
}
function getTagRank(key) {
  const canonical = normalizeTagKey(key);
  const index = CANONICAL_PGN_TAGS.indexOf(canonical);
  return index !== -1 ? index : 9999;
}
function comparePgnTags(aKey, bKey) {
  const rankA = getTagRank(aKey);
  const rankB = getTagRank(bKey);
  if (rankA !== rankB) return rankA - rankB;
  return aKey.localeCompare(bKey);
}
function sanitizePgnHeaders(headers) {
  const cleaned = {};
  const entries = [];
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    const key = normalizeTagKey(rawKey);
    const value = cleanTagValue(rawValue);
    if (value !== null) {
      entries.push([key, value]);
    }
  }
  entries.sort(([keyA], [keyB]) => comparePgnTags(keyA, keyB));
  for (const [key, value] of entries) {
    cleaned[key] = value;
  }
  return cleaned;
}

// src/pgn.ts
function parsePgnString(pgn) {
  const headers = {};
  const comments = /* @__PURE__ */ new Map();
  let result;
  const headerRegex = /^\s*\[([A-Za-z0-9_]+)\s+"([^"]*)"\]\s*$/;
  const lines = pgn.split(/\r?\n/);
  const movetextLines = [];
  let readingHeaders = true;
  for (const line of lines) {
    const trimmed = line.trim();
    if (readingHeaders) {
      if (trimmed.startsWith("[")) {
        const match = trimmed.match(headerRegex);
        if (match) {
          const key = normalizeTagKey(match[1]);
          headers[key] = match[2];
        }
        continue;
      } else if (trimmed === "") {
        readingHeaders = false;
        continue;
      } else {
        readingHeaders = false;
      }
    }
    movetextLines.push(line);
  }
  const movetext = movetextLines.join(" ").trim();
  if (!movetext) {
    return { headers, history: [], comments, result };
  }
  const history = [];
  let i = 0;
  let currentPly = -1;
  while (i < movetext.length) {
    while (i < movetext.length && /\s/.test(movetext[i])) {
      i++;
    }
    if (i >= movetext.length) break;
    const char = movetext[i];
    if (char === "{") {
      const start = i + 1;
      let depth = 1;
      i++;
      while (i < movetext.length && depth > 0) {
        if (movetext[i] === "{") depth++;
        else if (movetext[i] === "}") depth--;
        i++;
      }
      const commentText = movetext.substring(start, i - 1).trim();
      const existing = comments.get(currentPly) || "";
      comments.set(currentPly, existing ? `${existing} ${commentText}` : commentText);
      continue;
    }
    if (char === "(") {
      let depth = 1;
      i++;
      while (i < movetext.length && depth > 0) {
        if (movetext[i] === "(") depth++;
        else if (movetext[i] === ")") depth--;
        i++;
      }
      continue;
    }
    if (char === "$") {
      i++;
      while (i < movetext.length && /\d/.test(movetext[i])) {
        i++;
      }
      continue;
    }
    let token = "";
    while (i < movetext.length && !/[\s{}()]/.test(movetext[i])) {
      token += movetext[i];
      i++;
    }
    if (["1-0", "0-1", "1/2-1/2", "*"].includes(token)) {
      result = token;
      continue;
    }
    const moveNumMatch = token.match(/^(\d+)\.+([a-zA-Z0-9+=#-]+)?$/);
    if (moveNumMatch) {
      if (moveNumMatch[2]) {
        history.push(moveNumMatch[2]);
        currentPly++;
      }
      continue;
    }
    if (token) {
      history.push(token);
      currentPly++;
    }
  }
  return { headers, history, comments, result };
}
function buildPgnString(state, headers, comments, options) {
  const parts = [];
  const sortedKeys = Object.keys(headers).sort(comparePgnTags);
  for (const key of sortedKeys) {
    if (headers[key] !== void 0) {
      parts.push(`[${key} "${headers[key]}"]`);
    }
  }
  if (parts.length > 0) {
    parts.push("");
  }
  const moveTokens = [];
  const initialComment = comments.get(-1);
  if (initialComment) {
    moveTokens.push(`{${initialComment}}`);
  }
  let moveNumber = 1;
  for (let ply = 0; ply < state.history.length; ply++) {
    const item = state.history[ply];
    if (ply % 2 === 0) {
      moveTokens.push(`${moveNumber}.`);
    }
    moveTokens.push(item.san);
    const comment = comments.get(ply);
    if (comment) {
      moveTokens.push(`{${comment}}`);
    }
    if (ply % 2 === 1) {
      moveNumber++;
    }
  }
  const result = headers["Result"] || "*";
  moveTokens.push(result);
  const newline = options?.newline || "\n";
  const maxWidth = options?.maxWidth || 0;
  if (maxWidth > 0) {
    let currentLine = "";
    const wrappedLines = [];
    for (const token of moveTokens) {
      if (currentLine.length + token.length + 1 > maxWidth) {
        wrappedLines.push(currentLine.trim());
        currentLine = token + " ";
      } else {
        currentLine += token + " ";
      }
    }
    if (currentLine.trim()) {
      wrappedLines.push(currentLine.trim());
    }
    parts.push(wrappedLines.join(newline));
  } else {
    parts.push(moveTokens.join(" "));
  }
  return parts.join(newline);
}

// src/perft.ts
function perft(board, turn, castling, epSquare, depth) {
  if (depth === 0) return 1;
  const moves = generateLegalMoves(board, turn, castling, epSquare);
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (const move of moves) {
    const undo = applyMoveInternal(board, move);
    let nextEpSquare = -1;
    if (move.flags & BITS.BIG_PAWN) {
      nextEpSquare = move.color === WHITE ? move.from - 16 : move.from + 16;
    }
    let nextCastling = castling;
    if (move.piece === "k") {
      if (move.color === WHITE) {
        nextCastling &= -4;
      } else {
        nextCastling &= -13;
      }
    }
    if (move.from === SQUARES.h1 || move.to === SQUARES.h1) nextCastling &= -2;
    if (move.from === SQUARES.a1 || move.to === SQUARES.a1) nextCastling &= -3;
    if (move.from === SQUARES.h8 || move.to === SQUARES.h8) nextCastling &= -5;
    if (move.from === SQUARES.a8 || move.to === SQUARES.a8) nextCastling &= -9;
    nodes += perft(board, swapColor(turn), nextCastling, nextEpSquare, depth - 1);
    unapplyMoveInternal(board, move, undo);
  }
  return nodes;
}
function perftDivide(board, turn, castling, epSquare, depth) {
  const result = {};
  const moves = generateLegalMoves(board, turn, castling, epSquare);
  for (const move of moves) {
    const uci = `${squareToAlgebraic(move.from)}${squareToAlgebraic(move.to)}${move.promotion || ""}`;
    const undo = applyMoveInternal(board, move);
    let nextEpSquare = -1;
    if (move.flags & BITS.BIG_PAWN) {
      nextEpSquare = move.color === WHITE ? move.from - 16 : move.from + 16;
    }
    let nextCastling = castling;
    if (move.piece === "k") {
      if (move.color === WHITE) {
        nextCastling &= -4;
      } else {
        nextCastling &= -13;
      }
    }
    if (move.from === SQUARES.h1 || move.to === SQUARES.h1) nextCastling &= -2;
    if (move.from === SQUARES.a1 || move.to === SQUARES.a1) nextCastling &= -3;
    if (move.from === SQUARES.h8 || move.to === SQUARES.h8) nextCastling &= -5;
    if (move.from === SQUARES.a8 || move.to === SQUARES.a8) nextCastling &= -9;
    const count = depth > 1 ? perft(board, swapColor(turn), nextCastling, nextEpSquare, depth - 1) : 1;
    result[uci] = count;
    unapplyMoveInternal(board, move, undo);
  }
  return result;
}

// src/index.ts
var Chess = class {
  state;
  headers = {};
  comments = /* @__PURE__ */ new Map();
  constructor(fen = DEFAULT_POSITION) {
    this.state = new PositionState(fen);
  }
  /**
   * Resets the game to the default starting position.
   */
  reset() {
    this.state.reset();
    this.headers = {};
    this.comments.clear();
  }
  /**
   * Clears the board completely.
   */
  clear() {
    this.state.clear();
    this.headers = {};
    this.comments.clear();
  }
  /**
   * Loads a FEN string. Throws error if invalid.
   */
  load(fen) {
    this.state.load(fen);
    this.headers = {};
    this.comments.clear();
  }
  /**
   * Returns current FEN.
   */
  fen() {
    return this.state.fen();
  }
  /**
   * Returns the current turn ('w' or 'b').
   */
  turn() {
    return this.state.turn;
  }
  /**
   * Returns the current fullmove number.
   */
  moveNumber() {
    return this.state.fullMoves;
  }
  /**
   * Executes a move.
   * Can be SAN string (e.g. 'e4', 'Nf3', 'O-O') or MoveInput ({ from: 'e2', to: 'e4', promotion?: 'q' }).
   * Returns Move on success or throws error.
   */
  move(moveInput, _options) {
    const result = this.state.makeMove(moveInput);
    if (!result) {
      throw new Error(`Invalid move: ${typeof moveInput === "string" ? moveInput : JSON.stringify(moveInput)}`);
    }
    return result;
  }
  /**
   * Undoes the last move. Returns Move or null if no moves to undo.
   */
  undo() {
    return this.state.undoMove();
  }
  moves(options) {
    return this.state.moves(options);
  }
  history(options) {
    if (options?.verbose) {
      return this.state.history.map((h) => ({
        color: h.move.color,
        from: squareToAlgebraic(h.move.from),
        to: squareToAlgebraic(h.move.to),
        piece: h.move.piece,
        captured: h.move.captured,
        promotion: h.move.promotion,
        flags: formatMoveFlags(h.move.flags),
        san: h.san,
        lan: `${squareToAlgebraic(h.move.from)}${squareToAlgebraic(h.move.to)}${h.move.promotion || ""}`,
        before: h.beforeFen,
        after: h.afterFen
      }));
    }
    return this.state.history.map((h) => h.san);
  }
  /**
   * Returns an 8x8 matrix representing board state.
   */
  board() {
    const grid = [];
    const files = "abcdefgh";
    for (let r = 0; r < 8; r++) {
      const row = [];
      for (let f = 0; f < 8; f++) {
        const sq = (r << 4) + f;
        const squareName = files[f] + (8 - r);
        const p = this.state.board[sq];
        if (p) {
          row.push({
            square: squareName,
            type: p.type,
            color: p.color
          });
        } else {
          row.push(null);
        }
      }
      grid.push(row);
    }
    return grid;
  }
  /**
   * Returns the piece at a given square or null.
   */
  get(square) {
    return this.state.get(square);
  }
  /**
   * Places a piece on a square.
   */
  put(piece, square) {
    return this.state.put(piece, square);
  }
  /**
   * Removes a piece from a square.
   */
  remove(square) {
    return this.state.remove(square);
  }
  /**
   * Returns true if king is in check.
   * If color parameter is supplied, tests safety for that color (Bughouse extension).
   */
  isCheck(color) {
    return this.state.isCheck(color);
  }
  /**
   * Modern chess.js alias for isCheck.
   */
  inCheck(color) {
    return this.isCheck(color);
  }
  /**
   * Returns true if active player is checkmated.
   */
  isCheckmate() {
    return this.state.isCheckmate();
  }
  /**
   * Returns true if active player is stalemated.
   */
  isStalemate() {
    return this.state.isStalemate();
  }
  /**
   * Returns true if position has repeated 3 times.
   */
  isThreefoldRepetition() {
    return this.state.isThreefoldRepetition();
  }
  /**
   * Returns true if material on board cannot produce checkmate.
   */
  isInsufficientMaterial() {
    return this.state.isInsufficientMaterial();
  }
  /**
   * Returns true if game is drawn (stalemate, repetition, 50-move, or insufficient material).
   */
  isDraw() {
    return this.state.isDraw();
  }
  /**
   * Returns true if game is in a terminal state (checkmate or draw).
   */
  isGameOver() {
    return this.state.isGameOver();
  }
  header(...args) {
    if (args.length === 0) {
      return { ...this.headers };
    }
    if (args.length === 1) {
      return this.headers[args[0]];
    }
    for (let i = 0; i < args.length; i += 2) {
      if (args[i + 1] !== void 0) {
        this.headers[args[i]] = args[i + 1];
      }
    }
    return { ...this.headers };
  }
  /**
   * Exports PGN string.
   */
  pgn(options) {
    return buildPgnString(this.state, this.headers, this.comments, options);
  }
  /**
   * Imports PGN string.
   */
  loadPgn(pgn, _options) {
    const parsed = parsePgnString(pgn);
    this.reset();
    this.headers = parsed.headers;
    this.comments = parsed.comments;
    for (const san of parsed.history) {
      const res = this.state.makeMove(san);
      if (!res) {
        throw new Error(`Failed to parse PGN move: ${san}`);
      }
    }
  }
  /**
   * Comments manipulation
   */
  getComment() {
    return this.comments.get(this.state.history.length - 1);
  }
  setComment(comment) {
    this.comments.set(this.state.history.length - 1, comment);
  }
  deleteComment() {
    const key = this.state.history.length - 1;
    const comment = this.comments.get(key);
    this.comments.delete(key);
    return comment;
  }
  getComments() {
    const result = [];
    for (const [ply, comment] of this.comments.entries()) {
      if (ply >= 0 && ply < this.state.history.length) {
        result.push({ fen: this.state.history[ply].afterFen, comment });
      }
    }
    return result;
  }
  deleteComments() {
    const comments = this.getComments();
    this.comments.clear();
    return comments;
  }
  /**
   * Runs Perft at specified depth on current position.
   */
  perft(depth) {
    return perft(
      this.state.board,
      this.state.turn,
      this.state.castling,
      this.state.epSquare,
      depth
    );
  }
  /**
   * Runs Perft divide at specified depth.
   */
  perftDivide(depth) {
    return perftDivide(
      this.state.board,
      this.state.turn,
      this.state.castling,
      this.state.epSquare,
      depth
    );
  }
  // --- Backwards-compatible aliases for chess.js v0.12 API ---
  /** @deprecated Use `isCheck()` instead. */
  in_check() {
    return this.isCheck();
  }
  /** @deprecated Use `isCheckmate()` instead. */
  in_checkmate() {
    return this.isCheckmate();
  }
  /** @deprecated Use `isStalemate()` instead. */
  in_stalemate() {
    return this.isStalemate();
  }
  /** @deprecated Use `isDraw()` instead. */
  in_draw() {
    return this.isDraw();
  }
  /** @deprecated Use `isThreefoldRepetition()` instead. */
  in_threefold_repetition() {
    return this.isThreefoldRepetition();
  }
  /** @deprecated Use `isInsufficientMaterial()` instead. */
  insufficient_material() {
    return this.isInsufficientMaterial();
  }
  /** @deprecated Use `isGameOver()` instead. */
  game_over() {
    return this.isGameOver();
  }
  /** @deprecated Use `validateFen(fen)` instead. */
  static validate_fen(fen) {
    return validateFen(fen);
  }
};
var index_default = Chess;

export { BLACK, CANONICAL_PGN_TAGS, Chess, DEFAULT_POSITION, SQUARES, WHITE, cleanTagValue, comparePgnTags, index_default as default, getTagRank, normalizeTagKey, sanitizePgnHeaders, validateFen };
//# sourceMappingURL=index.mjs.map
//# sourceMappingURL=index.mjs.map