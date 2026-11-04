// Collapse overlapping updates into one in-flight request and one trailing pass.
// The trailing pass is essential: an event may arrive after the server has
// already taken the snapshot being fetched by the current request.
export function coalesceAsync(update: () => Promise<void>) {
  let running: Promise<void> | undefined;
  let pending = false;
  return function request(): Promise<void> {
    pending = true;
    if (!running) {
      running = Promise.resolve().then(async () => {
        try {
          while (pending) {
            pending = false;
            await update();
          }
        } finally {
          running = undefined;
        }
      });
    }
    return running;
  };
}
