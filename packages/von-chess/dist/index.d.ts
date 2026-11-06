/**
 * @fileoverview Core chess constants, 0x88 board coordinate definitions,
 * ray vectors, and bitflags for @von/chess.
 *
 * WHY: 0x88 mailbox representation provides O(1) off-board detection via `(sq & 0x88) === 0`,
 * while keeping memory footprint minimal and avoiding BigInt operations.
 *
 * // CRITICAL: Modification of square indices or ray offsets will corrupt legal move generation.
 */
declare const WHITE: "w";
declare const BLACK: "b";
declare const PAWN: "p";
declare const KNIGHT: "n";
declare const BISHOP: "b";
declare const ROOK: "r";
declare const QUEEN: "q";
declare const KING: "k";
declare const DEFAULT_POSITION = "rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1";
/**
 * 0x88 Square indices:
 * Row 8: a8=0 ... h8=7
 * Row 7: a7=16 ... h7=23
 * Row 1: a1=112 ... h1=119
 */
declare const SQUARES: {
    readonly a8: 0;
    readonly b8: 1;
    readonly c8: 2;
    readonly d8: 3;
    readonly e8: 4;
    readonly f8: 5;
    readonly g8: 6;
    readonly h8: 7;
    readonly a7: 16;
    readonly b7: 17;
    readonly c7: 18;
    readonly d7: 19;
    readonly e7: 20;
    readonly f7: 21;
    readonly g7: 22;
    readonly h7: 23;
    readonly a6: 32;
    readonly b6: 33;
    readonly c6: 34;
    readonly d6: 35;
    readonly e6: 36;
    readonly f6: 37;
    readonly g6: 38;
    readonly h6: 39;
    readonly a5: 48;
    readonly b5: 49;
    readonly c5: 50;
    readonly d5: 51;
    readonly e5: 52;
    readonly f5: 53;
    readonly g5: 54;
    readonly h5: 55;
    readonly a4: 64;
    readonly b4: 65;
    readonly c4: 66;
    readonly d4: 67;
    readonly e4: 68;
    readonly f4: 69;
    readonly g4: 70;
    readonly h4: 71;
    readonly a3: 80;
    readonly b3: 81;
    readonly c3: 82;
    readonly d3: 83;
    readonly e3: 84;
    readonly f3: 85;
    readonly g3: 86;
    readonly h3: 87;
    readonly a2: 96;
    readonly b2: 97;
    readonly c2: 98;
    readonly d2: 99;
    readonly e2: 100;
    readonly f2: 101;
    readonly g2: 102;
    readonly h2: 103;
    readonly a1: 112;
    readonly b1: 113;
    readonly c1: 114;
    readonly d1: 115;
    readonly e1: 116;
    readonly f1: 117;
    readonly g1: 118;
    readonly h1: 119;
};

/**
 * @fileoverview Type definitions for @von/chess.
 * Provides 100% type-compatibility with modern chess.js (v1.x).
 */

type Color = typeof WHITE | typeof BLACK;
type PieceSymbol = typeof PAWN | typeof KNIGHT | typeof BISHOP | typeof ROOK | typeof QUEEN | typeof KING;
type Square = keyof typeof SQUARES;
interface Piece {
    type: PieceSymbol;
    color: Color;
}
interface VerboseMove {
    color: Color;
    from: Square;
    to: Square;
    piece: PieceSymbol;
    captured?: PieceSymbol;
    promotion?: PieceSymbol;
    flags: string;
    san: string;
    lan: string;
    before: string;
    after: string;
}
/**
 * Standard chess.js type alias: Move represents VerboseMove.
 */
type Move = VerboseMove;
interface MoveInput {
    from: Square | string;
    to: Square | string;
    promotion?: PieceSymbol | string;
}
interface MovesOptions {
    square?: Square | string;
    piece?: PieceSymbol;
    verbose?: boolean;
}
interface HistoryOptions {
    verbose?: boolean;
}
interface PgnOptions {
    maxWidth?: number;
    newline?: string;
}
type PgnHeader = Record<string, string>;
interface ValidationResult {
    ok: boolean;
    error?: string;
}

/**
 * @fileoverview FEN (Forsyth-Edwards Notation) parser, validator, and serializer.
 *
 * WHY: Adheres strictly to FIDE FEN specifications while accepting 4-field shorthand FENs
 * commonly found in chess problem databases and perft suites (defaulting clocks to 0 and 1).
 */

/**
 * Validates a FEN string.
 */
declare function validateFen(fen: string): ValidationResult;

/**
 * @fileoverview Canonical PGN tag schema, normalization, and ordering utilities matching Lichess (lila).
 *
 * WHY: Provides standard Seven Tag Roster (STR) + canonical extensions,
 * filters unknown/placeholder values ('?', 'unknown', ''), and ensures deterministic
 * tag sorting on import, storage, and export.
 */
declare const CANONICAL_PGN_TAGS: readonly string[];
/**
 * Returns canonical casing for a PGN tag key, or original if not recognized.
 */
declare function normalizeTagKey(key: string): string;
/**
 * Filters and sanitizes a tag value like Lichess:
 * - Discards placeholder / unknown values: '', '?', 'unknown'
 * - Trims whitespace
 * - Truncates to max 140 characters
 */
declare function cleanTagValue(value: unknown): string | null;
/**
 * Returns the sorting rank for a tag key.
 * Canonical tags receive rank 0..N, custom tags receive 9999.
 */
declare function getTagRank(key: string): number;
/**
 * Comparator to sort PGN tag keys in canonical Lichess order.
 */
declare function comparePgnTags(aKey: string, bKey: string): number;
/**
 * Cleans, normalizes, and canonically sorts a dictionary of PGN headers.
 */
declare function sanitizePgnHeaders(headers: Record<string, string | undefined>): Record<string, string>;

/**
 * @fileoverview Main entry point for @von/chess.
 * Provides the `Chess` engine class with 100% drop-in compatibility for chess.js (v1.x),
 * legacy aliases (v0.12), and tailored extensions for VON.CHESS.
 *
 * WHY: Replaces 3rd-party chess.js with zero refactoring needed across callers,
 * while improving PGN resilience and providing color-agnostic king safety for Bughouse.
 */

declare class Chess {
    private state;
    private headers;
    private comments;
    constructor(fen?: string);
    /**
     * Resets the game to the default starting position.
     */
    reset(): void;
    /**
     * Clears the board completely.
     */
    clear(): void;
    /**
     * Loads a FEN string. Throws error if invalid.
     */
    load(fen: string): void;
    /**
     * Returns current FEN.
     */
    fen(): string;
    /**
     * Returns the current turn ('w' or 'b').
     */
    turn(): Color;
    /**
     * Returns the current fullmove number.
     */
    moveNumber(): number;
    /**
     * Executes a move.
     * Can be SAN string (e.g. 'e4', 'Nf3', 'O-O') or MoveInput ({ from: 'e2', to: 'e4', promotion?: 'q' }).
     * Returns Move on success or throws error.
     */
    move(moveInput: string | MoveInput, _options?: {
        strict?: boolean;
    }): Move;
    /**
     * Undoes the last move. Returns Move or null if no moves to undo.
     */
    undo(): Move | null;
    /**
     * Returns an array of legal moves with full overloads matching chess.js.
     */
    moves(options: {
        verbose: true;
    } & MovesOptions): Move[];
    moves(options?: {
        verbose?: false;
    } & MovesOptions): string[];
    moves(options?: MovesOptions): (string | Move)[];
    /**
     * Returns move history with overloads matching chess.js.
     */
    history(options: {
        verbose: true;
    }): Move[];
    history(options?: {
        verbose?: false;
    }): string[];
    history(options?: HistoryOptions): (string | Move)[];
    /**
     * Returns an 8x8 matrix representing board state.
     */
    board(): ({
        square: Square;
        type: PieceSymbol;
        color: Color;
    } | null)[][];
    /**
     * Returns the piece at a given square or null.
     */
    get(square: Square | string): Piece | null;
    /**
     * Places a piece on a square.
     */
    put(piece: Piece, square: Square | string): boolean;
    /**
     * Removes a piece from a square.
     */
    remove(square: Square | string): Piece | null;
    /**
     * Returns true if king is in check.
     * If color parameter is supplied, tests safety for that color (Bughouse extension).
     */
    isCheck(color?: Color): boolean;
    /**
     * Modern chess.js alias for isCheck.
     */
    inCheck(color?: Color): boolean;
    /**
     * Returns true if active player is checkmated.
     */
    isCheckmate(): boolean;
    /**
     * Returns true if active player is stalemated.
     */
    isStalemate(): boolean;
    /**
     * Returns true if position has repeated 3 times.
     */
    isThreefoldRepetition(): boolean;
    /**
     * Returns true if material on board cannot produce checkmate.
     */
    isInsufficientMaterial(): boolean;
    /**
     * Returns true if game is drawn (stalemate, repetition, 50-move, or insufficient material).
     */
    isDraw(): boolean;
    /**
     * Returns true if game is in a terminal state (checkmate or draw).
     */
    isGameOver(): boolean;
    /**
     * Manages PGN headers with exact chess.js overloads.
     */
    header(): PgnHeader;
    header(key: string): string | undefined;
    header(...args: string[]): PgnHeader | string | undefined;
    /**
     * Exports PGN string.
     */
    pgn(options?: PgnOptions): string;
    /**
     * Imports PGN string.
     */
    loadPgn(pgn: string, _options?: {
        strict?: boolean;
        newline?: string;
    }): void;
    /**
     * Comments manipulation
     */
    getComment(): string | undefined;
    setComment(comment: string): void;
    deleteComment(): string | undefined;
    getComments(): {
        fen: string;
        comment: string;
    }[];
    deleteComments(): {
        fen: string;
        comment: string;
    }[];
    /**
     * Runs Perft at specified depth on current position.
     */
    perft(depth: number): number;
    /**
     * Runs Perft divide at specified depth.
     */
    perftDivide(depth: number): Record<string, number>;
    /** @deprecated Use `isCheck()` instead. */
    in_check(): boolean;
    /** @deprecated Use `isCheckmate()` instead. */
    in_checkmate(): boolean;
    /** @deprecated Use `isStalemate()` instead. */
    in_stalemate(): boolean;
    /** @deprecated Use `isDraw()` instead. */
    in_draw(): boolean;
    /** @deprecated Use `isThreefoldRepetition()` instead. */
    in_threefold_repetition(): boolean;
    /** @deprecated Use `isInsufficientMaterial()` instead. */
    insufficient_material(): boolean;
    /** @deprecated Use `isGameOver()` instead. */
    game_over(): boolean;
    /** @deprecated Use `validateFen(fen)` instead. */
    static validate_fen(fen: string): ValidationResult;
}

export { BLACK, CANONICAL_PGN_TAGS, Chess, type Color, DEFAULT_POSITION, type HistoryOptions, type Move, type MoveInput, type MovesOptions, type PgnHeader, type PgnOptions, type Piece, type PieceSymbol, SQUARES, type Square, type ValidationResult, type VerboseMove, WHITE, cleanTagValue, comparePgnTags, Chess as default, getTagRank, normalizeTagKey, sanitizePgnHeaders, validateFen };
