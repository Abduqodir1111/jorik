// Preserve React memo references for unchanged records while retaining server order.
export function reconcileList<T extends { id: string }>(
  previous: T[],
  next: T[],
): T[] {
  const byId = new Map(previous.map((item) => [item.id, item]));
  const result = next.map((item) => {
    const old = byId.get(item.id);
    return old && JSON.stringify(old) === JSON.stringify(item) ? old : item;
  });
  return result.length === previous.length &&
    result.every((item, i) => item === previous[i])
    ? previous
    : result;
}
