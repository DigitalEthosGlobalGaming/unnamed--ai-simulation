import { manhattan, neighbors4, posKey, type Pos } from '@uas/core';

export interface PathGoal {
  target: Pos;
  /** Stop anywhere within this Manhattan distance of `target`. */
  radius: number;
}

/**
 * 4-connected A*. Ties break on (f, h, insertion order), so the same inputs
 * always give the same path. Returns the steps after `from`, or null.
 */
export function findPath(from: Pos, goal: PathGoal, walkable: (p: Pos) => boolean, maxNodes = 10_000): Pos[] | null {
  const h = (p: Pos) => Math.max(0, manhattan(p, goal.target) - goal.radius);
  const isGoal = (p: Pos) => manhattan(p, goal.target) <= goal.radius;
  if (isGoal(from)) return [];

  type Node = { pos: Pos; g: number; f: number; h: number; order: number };
  const heap: Node[] = [];
  const less = (a: Node, b: Node) => a.f - b.f || a.h - b.h || a.order - b.order;
  const push = (n: Node) => {
    heap.push(n);
    for (let i = heap.length - 1; i > 0; ) {
      const parent = (i - 1) >> 1;
      if (less(heap[parent]!, heap[i]!) <= 0) break;
      [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
      i = parent;
    }
  };
  const pop = (): Node => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && less(heap[l]!, heap[m]!) < 0) m = l;
        if (r < heap.length && less(heap[r]!, heap[m]!) < 0) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i]!, heap[m]!];
        i = m;
      }
    }
    return top;
  };

  const bestG = new Map<string, number>([[posKey(from), 0]]);
  const cameFrom = new Map<string, Pos>();
  let order = 0;
  push({ pos: from, g: 0, h: h(from), f: h(from), order: order++ });

  while (heap.length > 0 && order < maxNodes) {
    const cur = pop();
    if (cur.g > (bestG.get(posKey(cur.pos)) ?? Infinity)) continue;
    if (isGoal(cur.pos)) {
      const path: Pos[] = [];
      for (let p: Pos | undefined = cur.pos; p && posKey(p) !== posKey(from); p = cameFrom.get(posKey(p))) path.push(p);
      return path.reverse();
    }
    for (const n of neighbors4(cur.pos)) {
      if (!walkable(n)) continue;
      const g = cur.g + 1;
      const key = posKey(n);
      if (g >= (bestG.get(key) ?? Infinity)) continue;
      bestG.set(key, g);
      cameFrom.set(key, cur.pos);
      push({ pos: n, g, h: h(n), f: g + h(n), order: order++ });
    }
  }
  return null;
}
