// Meta can wrap the same IGMessageID differently in history and webhook payloads.
export function instagramMessageKey(id: string) {
  const base64 = id.replace(
    /Z([ABCD])/g,
    (_match, code: string) => ({ A: "Z", B: "+", C: "/", D: "=" })[code]!,
  );
  const decoded = Buffer.from(base64, "base64").toString("utf8");
  return (
    decoded.match(/^(?:new_)?ig_dm_item:1:(IGMessageID:\d+:\d+:\d+)$/)?.[1] ??
    id
  );
}

// Webhook envelopes use new_ig_dm_item, which Graph GET does not accept.
// Keep opaque IDs untouched; convert only this exact known envelope.
export function instagramGraphMessageId(id: string) {
  const base64 = id.replace(
    /Z([ABCD])/g,
    (_match, code: string) => ({ A: "Z", B: "+", C: "/", D: "=" })[code]!,
  );
  const decoded = Buffer.from(base64, "base64").toString("utf8");
  if (!/^new_ig_dm_item:1:IGMessageID:\d+:\d+:\d+$/.test(decoded)) return id;
  return Buffer.from(decoded.slice(4))
    .toString("base64")
    .replace(
      /[Z+/=]/g,
      (character) => ({ Z: "ZA", "+": "ZB", "/": "ZC", "=": "ZD" })[character]!,
    );
}

// Keep the local outbox row when Meta echoes the same message in another envelope.
export function reconcileInstagramMessage(
  db: import("./db.js").DB,
  id: string,
  conversationId: string,
  externalId: string,
) {
  const key = instagramMessageKey(externalId);
  db.prepare(
    `UPDATE messages SET read_at=COALESCE(read_at,(SELECT MAX(read_at) FROM messages WHERE conversation_id=? AND (external_id=? OR instagram_key=?))) WHERE id=?`,
  ).run(conversationId, externalId, key, id);
  db.prepare(
    `UPDATE messages SET reply_to_id=? WHERE conversation_id=? AND reply_to_id IN (SELECT id FROM messages WHERE conversation_id=? AND (external_id=? OR instagram_key=?) AND id!=? AND id NOT IN (SELECT message_id FROM outbox))`,
  ).run(id, conversationId, conversationId, externalId, key, id);
  db.prepare(
    `DELETE FROM messages WHERE conversation_id=? AND (external_id=? OR instagram_key=?) AND id!=? AND id NOT IN (SELECT message_id FROM outbox)`,
  ).run(conversationId, externalId, key, id);
  db.prepare("UPDATE OR IGNORE messages SET instagram_key=? WHERE id=?").run(
    key,
    id,
  );
}
