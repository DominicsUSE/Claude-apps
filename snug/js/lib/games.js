// Activities in a voice place, shared by the server (server/activities.js)
// and the browser (js/activities.js, js/views/activities.js): the limits of
// the whiteboard, the reactions anyone in voice can send, and the rules of the
// two games, tic-tac-toe and Connect Four. The server is the referee: it keeps
// the board, the seats and whose turn it is, and uses these functions to say
// when someone has won. The browser uses the same ones only to draw.

// ---------- Whiteboard ----------
// Colours are token names, never free colours, so a drawing reads in both
// themes and nobody draws in violet (the brand) or error red.
export const BOARD_COLOURS = ['ink', 'mint', 'amber', 'cyan', 'rose'];
export const BOARD_WIDTHS = [1, 2, 3, 4];
export const BOARD_LIMITS = { points: 256, strokes: 2000 };

// ---------- Voice reactions ----------
export const VOICE_REACTIONS = ['👍', '❤️', '😂', '😮', '👏', '🎉', '🔥', '😢'];

// ---------- Games ----------
export const GAMES = {
  ttt: { name: 'Tic-tac-toe', cols: 3, rows: 3, line: 3 },
  c4: { name: 'Connect Four', cols: 7, rows: 6, line: 4 },
};
export const GAME_KINDS = Object.keys(GAMES);
export const ACTIVITY_KINDS = ['board', ...GAME_KINDS];

export const emptyBoard = (kind) => Array(GAMES[kind].cols * GAMES[kind].rows).fill(null);

// Connect Four: where a piece dropped in this column lands (row 0 is the
// top), or -1 when the column is full or doesn't exist.
export function c4Drop(board, col) {
  const { cols, rows } = GAMES.c4;
  if (!Number.isInteger(col) || col < 0 || col >= cols) return -1;
  for (let r = rows - 1; r >= 0; r--) if (board[r * cols + col] == null) return r * cols + col;
  return -1;
}

// Who has won, and with which cells; a draw when the board is full; null
// while the game goes on. Cells hold 0 or 1 (the seat) or null.
export function gameResult(kind, board) {
  const g = GAMES[kind];
  if (!g || !Array.isArray(board) || board.length !== g.cols * g.rows) return null;
  const at = (r, c) => (r >= 0 && r < g.rows && c >= 0 && c < g.cols ? board[r * g.cols + c] : undefined);
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const who = at(r, c);
      if (who !== 0 && who !== 1) continue;
      // Right, down, down-right, down-left: every line is found from its first cell.
      for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
        const line = [];
        for (let k = 0; k < g.line && at(r + dr * k, c + dc * k) === who; k++) line.push((r + dr * k) * g.cols + c + dc * k);
        if (line.length === g.line) return { winner: who, line };
      }
    }
  }
  return board.every((v) => v === 0 || v === 1) ? { draw: true } : null;
}

// Where a move goes: the cell index for tic-tac-toe (it must be empty), the
// landing cell for Connect Four; -1 when the move isn't possible.
export function moveCell(kind, board, move) {
  if (kind === 'c4') return c4Drop(board, move);
  if (kind === 'ttt') return Number.isInteger(move) && move >= 0 && move < 9 && board[move] == null ? move : -1;
  return -1;
}

// "a3", "column 5": how a move is said out loud.
export function moveName(kind, cell) {
  const g = GAMES[kind];
  const r = Math.floor(cell / g.cols), c = cell % g.cols;
  if (kind === 'c4') return `column ${c + 1}`;
  return `${['top', 'middle', 'bottom'][r]} ${['left', 'centre', 'right'][c]}`.replace('middle centre', 'centre');
}
