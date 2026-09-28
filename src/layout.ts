// Lane assignment for the commit graph, in the GitKraken / git log --graph style.
//
// Rules:
// - Commits arrive in --date-order (parents never earlier in the list than children).
// - A commit claims the lane previously reserved for it, else the lowest free lane.
// - A lane reservation means "this lane is spoken for until commit X is laid out";
//   edges span that whole range, so parallel branches keep their own column.
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

  const lowestFreeLane = (): number => {
    for (let i = 0; i < laneTarget.length; i++) {
      if (laneTarget[i] === null) return i;
    }
    laneTarget.push(null);
    return laneTarget.length - 1;
  };

  commits.forEach((commit, row) => {
    let lane = laneTarget.indexOf(commit.hash);
    if (lane === -1) lane = lowestFreeLane();
    laneTarget[lane] = null; // consumed: the commit itself now occupies this lane

    nodes.push({ commit, row, column: lane });

    commit.parents.forEach((parentHash, idx) => {
      const parentRow = rowIndex.get(parentHash);
      if (parentRow === undefined) return; // parent outside the log window

      const parentLane = laneTarget.indexOf(parentHash);
      if (parentLane !== -1) {
        // Another edge already reserved a lane for this parent — join it.
        edges.push({
          fromRow: row,
          fromColumn: lane,
          toRow: parentRow,
          toColumn: parentLane,
          merge: idx > 0,
        });
        return;
      }

      if (idx === 0) {
        // First parent with no reservation: keep the lane straight.
        laneTarget[lane] = parentHash;
        edges.push({ fromRow: row, fromColumn: lane, toRow: parentRow, toColumn: lane, merge: false });
      } else {
        // Branch-off point: give the parent its own new lane.
        const target = lowestFreeLane();
        laneTarget[target] = parentHash;
        edges.push({ fromRow: row, fromColumn: lane, toRow: parentRow, toColumn: target, merge: true });
      }
    });
  });

  return { nodes, edges, columns: Math.max(1, laneTarget.length) };
}