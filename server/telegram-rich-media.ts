import { Api } from "teleproto";
import type { Attachment, Message } from "../shared/types.js";
export const RICH_MEDIA_LIMIT = 20 * 1024 * 1024;
export function richMedia(m: Api.Message): Attachment | undefined {
  const media = m.media;
  if (
    (media instanceof Api.MessageMediaGeo ||
      media instanceof Api.MessageMediaVenue) &&
    media.geo instanceof Api.GeoPoint
  ) {
    const latitude = media.geo.lat,
      longitude = media.geo.long;
    if (
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    )
      return;
    return {
      kind: "location",
      latitude,
      longitude,
      url: "",
      mime: "application/geo+json",
      size: 0,
      name: media instanceof Api.MessageMediaVenue ? media.title : "Геолокация",
    };
  }
  if (
    !(media instanceof Api.MessageMediaDocument) ||
    media.ttlSeconds ||
    !(media.document instanceof Api.Document)
  )
    return;
  const d = media.document;
  const audio = d.attributes.find(
    (a) => a instanceof Api.DocumentAttributeAudio,
  );
  if (
    audio instanceof Api.DocumentAttributeAudio &&
    ["audio/ogg", "audio/opus", "audio/mp4", "audio/mpeg"].includes(d.mimeType)
  )
    return {
      kind: "voice",
      mime: d.mimeType,
      name: audio.voice ? "Голосовое сообщение" : "Аудио",
      duration: audio.duration,
      size: Number(d.size),
      url: "",
    };
  if (
    d.attributes.some((a) => a instanceof Api.DocumentAttributeSticker) &&
    ["image/webp", "application/x-tgsticker", "video/webm"].includes(d.mimeType)
  )
    return {
      kind: "sticker",
      mime: d.mimeType,
      name: "Стикер",
      size: Number(d.size),
      url: "",
    };
}
export function telegramReactions(
  reactions?: Api.MessageReactions,
): NonNullable<Message["reactions"]> {
  return (reactions?.results || []).flatMap((r) =>
    r.reaction instanceof Api.ReactionEmoji && r.count > 0
      ? [
          {
            emoji: r.reaction.emoticon,
            count: r.count,
            chosen: r.chosenOrder !== undefined,
          },
        ]
      : [],
  );
}
