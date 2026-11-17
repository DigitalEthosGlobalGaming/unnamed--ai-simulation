/** A small line diff (LCS) for golden prompt snapshots: `-` expected, `+` actual, 2 lines of context. */
export function lineDiff(expected: string, actual: string, context = 2): string {
  const a = expected.split('\n');
  const b = actual.split('\n');
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const ops: { op: ' ' | '-' | '+'; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push({ op: ' ', line: a[i++]! }), j++;
    else if (i < n && (j >= m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) ops.push({ op: '-', line: a[i++]! });
    else ops.push({ op: '+', line: b[j++]! });
  }
  const keep = ops.map((o, k) => o.op !== ' ' || ops.slice(Math.max(0, k - context), k + context + 1).some((x) => x.op !== ' '));
  const out: string[] = [];
  ops.forEach((o, k) => {
    if (keep[k]) out.push(`${o.op} ${o.line}`);
    else if (keep[k - 1] && keep.slice(k).some(Boolean)) out.push('  …');
  });
  return out.join('\n');
}
