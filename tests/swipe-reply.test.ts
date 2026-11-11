import test from "node:test";
import assert from "node:assert/strict";
import {
  canSwipeReply,
  replySwipeAxis,
  replySwipeDistance,
  REPLY_SWIPE_THRESHOLD,
} from "../src/swipe-reply-gesture.js";

test("Reply swipe locks only deliberate left motion and never converts scrolling, right swipes or diagonal gestures into replies", () => {
  assert.equal(replySwipeAxis("pending", -7, 1), "pending");
  assert.equal(replySwipeAxis("pending", -22, 4), "reply");
  for (const [dx, dy] of [
    [1, 25],
    [-12, 20],
    [25, 1],
    [-20, 20],
  ])
    assert.equal(replySwipeAxis("pending", dx, dy), "cancelled");
  assert.equal(replySwipeAxis("cancelled", -100, 0), "cancelled");
  assert.equal(replySwipeAxis("reply", -70, 4), "reply");
  assert.equal(replySwipeAxis("reply", -70, 50), "cancelled");
  assert.equal(replySwipeAxis("reply", 1, 0), "cancelled");
});
test("Reply gesture requires a meaningful distance and bounds visual displacement", () => {
  assert.ok(replySwipeDistance(-59) < REPLY_SWIPE_THRESHOLD);
  assert.ok(replySwipeDistance(-60) >= REPLY_SWIPE_THRESHOLD);
  assert.equal(replySwipeDistance(-1000), 84);
  assert.equal(replySwipeDistance(50), 0);
});
test("Only provider-confirmed messages can be replied to, including completed archive videos", () => {
  assert.ok(canSwipeReply({ externalId: "1", status: "sent" }));
  assert.ok(
    canSwipeReply({
      externalId: "1",
      status: "sent",
      archiveJob: { state: "sent" },
    }),
  );
  for (const status of ["queued", "sending", "error", "unknown"])
    assert.equal(canSwipeReply({ externalId: "1", status }), false);
  assert.equal(canSwipeReply({ externalId: null, status: "sent" }), false);
  assert.equal(
    canSwipeReply({
      externalId: "1",
      status: "sent",
      archiveJob: { state: "preparing" },
    }),
    false,
  );
});
