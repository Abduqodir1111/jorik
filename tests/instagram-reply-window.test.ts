import { test } from "node:test";
import assert from "node:assert/strict";
import { instagramReplyWindow } from "../shared/instagram-reply-window";
const now = Date.parse("2026-11-10T08:00:00Z");
const conversation = { id: "selected", lastIncomingAt: "2026-11-10T07:00:00Z" };
test("Instagram opens from conversation metadata before history loads and when its page has only outgoing messages", () => {
  const expected = { closed: false, remainingMinutes: 1380 };
  assert.deepEqual(instagramReplyWindow(conversation, [], now), expected);
  assert.deepEqual(
    instagramReplyWindow(
      conversation,
      [
        {
          conversationId: "selected",
          direction: "out",
          createdAt: "2026-11-10T07:30:00Z",
        },
      ],
      now,
    ),
    expected,
  );
});
test("Instagram reply window uses selected-chat history only as a legacy fallback", () => {
  const other = {
    conversationId: "other-chat",
    direction: "in" as const,
    createdAt: conversation.lastIncomingAt,
  };
  assert.deepEqual(instagramReplyWindow({ id: "selected" }, [other], now), {
    closed: true,
    remainingMinutes: 0,
  });
  assert.deepEqual(
    instagramReplyWindow(
      { id: "selected" },
      [{ ...other, conversationId: "selected" }],
      now,
    ),
    { closed: false, remainingMinutes: 1380 },
  );
  assert.deepEqual(
    instagramReplyWindow(
      { ...conversation, lastIncomingAt: "2026-11-09T07:00:00Z" },
      [{ ...other, conversationId: "selected" }],
      now,
    ),
    { closed: true, remainingMinutes: 0 },
  );
});
test("Instagram unknown, expired and invalid timestamps fail closed without NaN; the 24 hour boundary is exact", () => {
  for (const value of [
    undefined,
    "",
    "invalid",
    "2026-11-09T08:00:00Z",
    "2026-11-09T07:59:59Z",
  ])
    assert.deepEqual(
      instagramReplyWindow({ id: "selected", lastIncomingAt: value }, [], now),
      { closed: true, remainingMinutes: 0 },
    );
  assert.deepEqual(
    instagramReplyWindow(
      { id: "selected", lastIncomingAt: "2026-11-09T08:00:01Z" },
      [],
      now,
    ),
    { closed: false, remainingMinutes: 1 },
  );
});
