export const REPLY_SWIPE_THRESHOLD = 60;
export type SwipeAxis = "pending" | "reply" | "cancelled";
export function replySwipeAxis(
  axis: SwipeAxis,
  dx: number,
  dy: number,
): SwipeAxis {
  if (axis === "cancelled") return axis;
  if (axis === "reply") return dx > 0 || Math.abs(dy) > 48 ? "cancelled" : axis;
  if (Math.hypot(dx, dy) < 12) return "pending";
  return dx < 0 && -dx > Math.abs(dy) * 1.35 ? "reply" : "cancelled";
}
export function replySwipeDistance(dx: number) {
  return Math.min(84, Math.max(0, -dx));
}
export function canSwipeReply(message: {
  externalId: string | null;
  status: string;
  archiveJob?: { state: string };
}) {
  return (
    !!message.externalId &&
    message.status === "sent" &&
    (!message.archiveJob || message.archiveJob.state === "sent")
  );
}
