/*
 * Dama (Filipino checkers) rules. Shared by the server (authoritative) and the browser.
 *
 * - 8x8 board, 12 chips each on the dark squares of the three nearest rows. White moves first.
 * - Men step one square diagonally forward. Men capture in all four directions.
 * - Capturing is mandatory, and you must take the sequence that captures the most chips.
 * - A man that ends its move on the far row becomes a dama (king): it moves and captures
 *   any distance along a diagonal, in all four directions.
 * - Captured chips are removed after the whole sequence and cannot be jumped twice.
 * - Board cells: null | 'w' | 'W' | 'b' | 'B' (uppercase = dama).
 */
(function (root) {
  const N = 8;
  const DIRS = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
  const QUIET_LIMIT = 40; // plies with no capture and no man move -> draw
  const inB = (r, c) => r >= 0 && r < N && c >= 0 && c < N;
  const side = (p) => p.toLowerCase();
  const isKing = (p) => p === p.toUpperCase();

  function initialState() {
    const board = Array.from({ length: N }, () => Array(N).fill(null));
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++)
        if ((r + c) % 2 === 1) {
          if (r < 3) board[r][c] = 'b';
          else if (r > 4) board[r][c] = 'w';
        }
    return { board, turn: 'w', quiet: 0 };
  }

  // All capture sequences for one piece. `board` has the moving piece lifted off it.
  function captures(board, r, c, piece, done, path) {
    const me = side(piece), king = isKing(piece), out = [];
    let any = false;
    for (const [dr, dc] of DIRS) {
      let tr = r + dr, tc = c + dc;
      if (king) while (inB(tr, tc) && !board[tr][tc]) { tr += dr; tc += dc; }
      if (!inB(tr, tc)) continue;
      const t = board[tr][tc];
      if (!t || side(t) === me || done.some((d) => d[0] === tr && d[1] === tc)) continue;
      let lr = tr + dr, lc = tc + dc;
      while (inB(lr, lc) && !board[lr][lc]) {
        any = true;
        out.push(...captures(board, lr, lc, piece, [...done, [tr, tc]], [...path, [lr, lc]]));
        if (!king) break;
        lr += dr; lc += dc;
      }
    }
    return any ? out : path.length ? [{ path, captured: done }] : [];
  }

  // Legal moves: [{ from:[r,c], path:[[r,c],...landing squares], captured:[[r,c],...] }]
  function legalMoves(state) {
    const { board, turn } = state, caps = [], steps = [];
    const fw = turn === 'w' ? -1 : 1;
    for (let r = 0; r < N; r++)
      for (let c = 0; c < N; c++) {
        const p = board[r][c];
        if (!p || side(p) !== turn) continue;
        const lifted = board.map((row) => row.slice());
        lifted[r][c] = null;
        for (const s of captures(lifted, r, c, p, [], [])) caps.push({ from: [r, c], ...s });
        for (const [dr, dc] of DIRS) {
          if (!isKing(p) && dr !== fw) continue;
          let nr = r + dr, nc = c + dc;
          while (inB(nr, nc) && !board[nr][nc]) {
            steps.push({ from: [r, c], path: [[nr, nc]], captured: [] });
            if (!isKing(p)) break;
            nr += dr; nc += dc;
          }
        }
      }
    if (!caps.length) return steps;
    const max = Math.max(...caps.map((m) => m.captured.length));
    return caps.filter((m) => m.captured.length === max);
  }

  function applyMove(state, m) {
    const board = state.board.map((row) => row.slice());
    const [fr, fc] = m.from, [er, ec] = m.path[m.path.length - 1];
    let p = board[fr][fc];
    const king = isKing(p);
    board[fr][fc] = null;
    m.captured.forEach(([r, c]) => { board[r][c] = null; });
    if (!king && er === (state.turn === 'w' ? 0 : N - 1)) p = p.toUpperCase();
    board[er][ec] = p;
    return {
      board,
      turn: state.turn === 'w' ? 'b' : 'w',
      quiet: m.captured.length || !king ? 0 : state.quiet + 1,
    };
  }

  // null while the game goes on; otherwise { winner: 'w' | 'b' | null (draw), reason }
  function outcome(state) {
    if (!legalMoves(state).length)
      return { winner: state.turn === 'w' ? 'b' : 'w', reason: 'no_moves' };
    if (state.quiet >= QUIET_LIMIT) return { winner: null, reason: 'quiet' };
    return null;
  }

  const api = { N, initialState, legalMoves, applyMove, outcome };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Dama = api;
})(this);
