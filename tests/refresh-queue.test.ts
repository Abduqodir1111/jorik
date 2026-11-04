import { test } from "node:test";
import assert from "node:assert/strict";
import { coalesceAsync } from "../src/refresh-queue.js";

test("Live updates collapse a burst but fetch again for events received in flight", async () => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0,
    active = 0,
    peak = 0;
  const update = coalesceAsync(async () => {
    peak = Math.max(peak, ++active);
    if (++calls === 1) {
      started();
      await blocked;
    }
    active--;
  });
  const first = update();
  await entered;
  const burst = Array.from({ length: 100 }, () => update());
  release();
  await Promise.all([first, ...burst]);
  assert.equal(calls, 2);
  assert.equal(peak, 1);
  await update();
  assert.equal(calls, 3);
});

test("A failed refresh does not prevent later reconnects from updating", async () => {
  let attempts = 0;
  const update = coalesceAsync(async () => {
    if (++attempts === 1) throw Error("offline");
  });
  await assert.rejects(update(), /offline/);
  await update();
  assert.equal(attempts, 2);
});
