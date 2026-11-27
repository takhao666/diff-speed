// Fast drop-in for makefun-diff 1.0.0: run(input) returns exactly the patch
// makefun-diff returns for { old, new }, but computed with an integer Myers
// search instead of the reference's per-cell path objects.
//
// Idea: lines repeat heavily, so every distinct line is interned once to a
// small integer id (one Map per case, shared by both texts). The Myers search
// then runs over Int32Array ids — integer compares, no string compares and no
// allocation inside the search — with the V table of every d kept in typed
// arrays so the edit script is recovered by exact backtracking.
//
// The search reproduces makefun-diff's rule exactly: common prefix, then
// common suffix of what is left; between them Myers's greedy search, which on
// each diagonal keeps the path furthest into the old text and, when a
// deletion and an insertion reach the same point, takes the deletion; never
// moves past either text's end; prunes no edge diagonal; and follows every
// run of equal lines as far as it goes. The first path to reach both ends is
// the script. Backtracking replays the same candidate comparison, so the
// recovered script is the same one the forward search found.

const FORMAT = 'makefun-diff/1';
const CONTEXT = 3;

// Run kinds, as small integers.
const KEEP = 0;
const INSERT = 1;
const DELETE = 2;

/** Split a text into lines (each keeping its "\n", the last one without when
 *  the text does not end in one) and intern each line to an integer id. */
function splitLines(text, map) {
  const parts = text.split('\n');
  const last = parts.length - 1;
  const n = last + (parts[last] !== '' ? 1 : 0);
  const lines = new Array(n);
  const ids = new Int32Array(n);
  for (let i = 0; i < last; i++) {
    const line = parts[i] + '\n';
    lines[i] = line;
    let id = map.get(line);
    if (id === undefined) {
      id = map.size;
      map.set(line, id);
    }
    ids[i] = id;
  }
  if (parts[last] !== '') {
    const line = parts[last];
    lines[last] = line;
    let id = map.get(line);
    if (id === undefined) {
      id = map.size;
      map.set(line, id);
    }
    ids[last] = id;
  }
  return { lines, ids };
}

/**
 * The edit script of a into b as runs [kind, count], kind KEEP/INSERT/DELETE.
 * a and b are Int32Arrays of interned line ids. The forward search keeps, for
 * every d, the furthest x reached on each diagonal (post-snake) in a per-d
 * Int32Array indexed by k+d, storing x+1 so that 0 means "no path reached
 * this diagonal" and a fresh (zeroed) row needs no fill pass. The two edge
 * diagonals are handled outside the interior loop, where both neighbours of
 * the previous d are in range. Backtracking replays the same deletion-on-tie
 * choice to recover the script the forward search found.
 */
function editRuns(a, b) {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];

  // d = 0: the opening snake.
  let x = 0;
  let y = 0;
  while (x < n && y < m && a[x] === b[y]) {
    x++;
    y++;
  }
  const v0 = new Int32Array(1);
  v0[0] = x + 1;
  const vs = [v0];
  if (x >= n && y >= m) return x > 0 ? [[KEEP, x]] : [];

  let foundD = -1;
  let foundK = 0;
  const maxD = n + m;
  outer: for (let d = 1; d <= maxD; d++) {
    const v = new Int32Array(2 * d + 1);
    const prev = vs[d - 1];
    const plen = prev.length;
    // k = -d: only an insertion can open this diagonal (from k+1 at d-1),
    // and only while the line it consumes is inside the new text.
    {
      const upRaw = prev[0];
      if (upRaw !== 0 && upRaw + d - 2 < m) {
        let xx = upRaw - 1; // x after the insertion
        let yy = xx + d; // y = x - k, k = -d
        const lim = m - d < n ? m - d : n;
        while (xx < lim && a[xx] === b[xx + d]) {
          xx++;
          yy++;
        }
        v[0] = xx + 1;
        if (xx >= n && yy >= m) {
          foundD = d;
          foundK = -d;
          vs.push(v);
          break outer;
        }
      }
    }
    // Interior diagonals: both neighbours of d-1 are in range, so no bounds
    // checks on the table reads; running indices step by 2 with k.
    let idx = 2; // position of k in V[d]: k + d, k = -d + 2
    let iD = 0; // position of k-1 in V[d-1]: (k-1) + (d-1)
    let iU = 2; // position of k+1 in V[d-1]: (k+1) + (d-1)
    for (let k = -d + 2; k <= d - 2; k += 2, idx += 2, iD += 2, iU += 2) {
      const downRaw = prev[iD];
      const upRaw = prev[iU];
      // A deletion is possible while the line it consumes is inside the old
      // text; an insertion while the line it consumes is inside the new text.
      // Stored raw values are x+1, so x after a deletion is downRaw and x
      // after an insertion is upRaw-1; deletion wins the tie, as
      // makefun-diff does.
      const canRemove = downRaw !== 0 && downRaw - 1 < n;
      const canAdd = upRaw !== 0 && upRaw - 2 - k < m;
      if (!canRemove && !canAdd) continue;
      let xx = canRemove && (!canAdd || downRaw >= upRaw - 1) ? downRaw : upRaw - 1;
      const lim = m + k < n ? m + k : n;
      while (xx < lim && a[xx] === b[xx - k]) xx++;
      v[idx] = xx + 1;
      if (xx >= n && xx - k >= m) {
        foundD = d;
        foundK = k;
        vs.push(v);
        break outer;
      }
    }
    // k = d: only a deletion can open this diagonal (from k-1 at d-1),
    // and only while the line it consumes is inside the old text.
    {
      const downRaw = prev[plen - 1];
      if (downRaw !== 0 && downRaw - 1 < n) {
        let xx = downRaw; // x after the deletion
        const lim = m + d < n ? m + d : n;
        while (xx < lim && a[xx] === b[xx - d]) xx++;
        v[2 * d] = xx + 1;
        if (xx >= n && xx - d >= m) {
          foundD = d;
          foundK = d;
          vs.push(v);
          break outer;
        }
      }
    }
    vs.push(v);
  }
  if (foundD < 0) throw new Error('makefun-diff: the search ended without reaching both ends');

  // Backtrack from (foundD, foundK): at each step the snake that ends the
  // step, then the one edit that opened it, then the previous step's snake.
  const rev = [];
  let k = foundK;
  let cx = vs[foundD][foundK + foundD] - 1;
  for (let d = foundD; d >= 1; d--) {
    const prev = vs[d - 1];
    const pbase = d - 1;
    let prevK;
    let kind;
    let xMid;
    if (k === -d) {
      prevK = k + 1;
      kind = INSERT;
      xMid = prev[prevK + pbase] - 1;
    } else if (k === d) {
      prevK = k - 1;
      kind = DELETE;
      xMid = prev[prevK + pbase];
    } else {
      const downRaw = prev[k - 1 + pbase];
      const upRaw = prev[k + 1 + pbase];
      const canRemove = downRaw !== 0 && downRaw - 1 < n;
      const canAdd = upRaw !== 0 && upRaw - 2 - k < m;
      if (canRemove && (!canAdd || downRaw >= upRaw - 1)) {
        prevK = k - 1;
        kind = DELETE;
        xMid = downRaw;
      } else {
        prevK = k + 1;
        kind = INSERT;
        xMid = upRaw - 1;
      }
    }
    const common = cx - xMid;
    if (common > 0) rev.push([KEEP, common]);
    rev.push([kind, 1]);
    cx = prev[prevK + pbase] - 1;
    k = prevK;
  }
  if (cx > 0) rev.push([KEEP, cx]);
  rev.reverse();
  // Merge runs of one kind that the step-by-step walk split apart.
  const runs = [];
  for (const [kind, count] of rev) {
    const last = runs[runs.length - 1];
    if (last !== undefined && last[0] === kind) last[1] += count;
    else runs.push([kind, count]);
  }
  return runs;
}

/** A line as the patch writes it: its op, the line, a newline, and "%" on a
 *  line of its own when the line had no newline. */
function written(op, line) {
  return line.endsWith('\n') ? `${op}${line}` : `${op}${line}\n%\n`;
}

/** makefun-diff 1.0.0's answer for one case's input { old, new }. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const map = new Map();
  // Identical texts are the first line alone: no tokenising or search needed.
  if (input.old === input.new) {
    const parts = input.old.split('\n');
    const n = parts.length - (parts[parts.length - 1] === '' ? 1 : 0);
    return `${FORMAT} old=${n} new=${n} hunks=0 deleted=0 inserted=0\n`;
  }
  const a = splitLines(input.old, map);
  const b = splitLines(input.new, map);
  const aIds = a.ids;
  const bIds = b.ids;
  const n = aIds.length;
  const m = bIds.length;

  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && aIds[prefix] === bIds[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && aIds[n - 1 - suffix] === bIds[m - 1 - suffix]) suffix++;

  const runs = [];
  if (prefix > 0) runs.push([KEEP, prefix]);
  for (const r of editRuns(aIds.subarray(prefix, n - suffix), bIds.subarray(prefix, m - suffix))) runs.push(r);
  if (suffix > 0) runs.push([KEEP, suffix]);
  // The prefix or suffix keep may sit against a keep the search found.
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last !== undefined && last[0] === r[0]) last[1] += r[1];
    else merged.push([r[0], r[1]]);
  }

  // The change runs: each a stretch of deletions and insertions between two
  // kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const [kind, count] of merged) {
    if (kind === KEEP) {
      o += count;
      p += count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (kind === DELETE) {
      c.dels += count;
      o += count;
      deleted += count;
    } else {
      c.ins += count;
      p += count;
      inserted += count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }

  const aLines = a.lines;
  const bLines = b.lines;
  const out = [`${FORMAT} old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', aLines[at]));
      for (let i = 0; i < c.dels; i++) out.push(written('-', aLines[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written('+', bLines[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', aLines[at]));
  }
  return out.join('');
}
