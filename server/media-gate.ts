// One decoder/encoder at a time, shared by archive video and Safari audio.
let tail: Promise<unknown> = Promise.resolve();
export function mediaGate<T>(work: () => Promise<T>): Promise<T> {
  const next = tail.then(work, work);
  tail = next.catch(() => {});
  return next;
}
