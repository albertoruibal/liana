// Lane assignment for the commit graph.
//
// Rules:
// - Commits arrive in --date-order (parents never earlier in the list than children).
// - A commit claims the lane previously reserved for it, else the lowest free lane.
// - A lane reservation means "this lane is spoken for until commit X is laid out".
// - When a commit joins a parent in a *different* lane, the edge curves across and
//   the child's lane stays occupied until it reaches the parent's row. Without this
//   a freed lane is immediately reused by the next sibling tip, collapsing several
//   parallel branches into one tangled column. Keeping it busy gives each branch a
//   lane of its own.
// - First parent: continues straight down in the child's own lane when the parent
//   has no reservation yet (the classic mainline look).
// - Second+ parents: reserved lane if one exists, otherwise a new lane; drawn curved.

import type { GitCommit, GraphEdge, GraphLayout, GraphNode } from './types';

export function layoutGraph(commits: GitCommit[]): GraphLayout {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  const rowIndex = new Map<string, number>();
  commits.forEach((c, i) => rowIndex.set(c.hash, i));

  // lane -> hash of the commit this lane is reserved for (null = free).
  const laneTarget: (string | null)[] = [];
  // lane -> first row at which the lane may be reused. A lane carrying a curve to
  // another lane is busy until the curve lands on the parent's row.
  const laneFreeAt: number[] = [];

  const lowestFreeLane = (row: number): number => {
    for (let i = 0; i < laneTarget.length; i++) {
      if (laneTarget[i] === null && (laneFreeAt[i] ?? -1) <= row) return i;
    }
    laneTarget.push(null);
    laneFreeAt.push(-1);
    return laneTarget.length - 1;
  };

  commits.forEach((commit, row) => {
    let lane = laneTarget.indexOf(commit.hash);
    if (lane === -1) lane = lowestFreeLane(row);
    laneTarget[lane] = null; // consumed: the commit itself now occupies this lane

    nodes.push({ commit, row, column: lane });

    commit.parents.forEach((parentHash, idx) => {
      const parentRow = rowIndex.get(parentHash);
      if (parentRow === undefined) return; // parent outside the log window

      const parentLane = laneTarget.indexOf(parentHash);
      if (parentLane !== -1) {
        // Another edge already reserved a lane for this parent — join it. The
        // child's lane remains occupied by the curve until the parent's row.
        edges.push({
          fromRow: row,
          fromColumn: lane,
          toRow: parentRow,
          toColumn: parentLane,
          merge: idx > 0,
        });
        laneFreeAt[lane] = Math.max(laneFreeAt[lane] ?? -1, parentRow);
        return;
      }

      if (idx === 0) {
        // First parent with no reservation: keep the lane straight.
        laneTarget[lane] = parentHash;
        edges.push({ fromRow: row, fromColumn: lane, toRow: parentRow, toColumn: lane, merge: false });
      } else {
        // Branch-off point: give the parent its own new lane.
        const target = lowestFreeLane(row);
        laneTarget[target] = parentHash;
        edges.push({ fromRow: row, fromColumn: lane, toRow: parentRow, toColumn: target, merge: true });
      }
    });
  });

  return { nodes, edges, columns: Math.max(1, laneTarget.length) };
}