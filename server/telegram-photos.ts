import { Api } from "teleproto";
import type { Attachment } from "../shared/types.js";
export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
export function photoInfo(
  m: Api.Message,
): Pick<Attachment, "mime" | "name" | "size"> | undefined {
  const media = m.media;
  if (
    media instanceof Api.MessageMediaPhoto &&
    !media.ttlSeconds &&
    media.photo instanceof Api.Photo
  ) {
    const sizes = media.photo.sizes.flatMap((s) =>
      "sizes" in s ? s.sizes : "size" in s ? [s.size] : [],
    );
    return {
      mime: "image/jpeg",
      name: "Фотография",
      size: Math.max(0, ...sizes),
    };
  }
  if (
    media instanceof Api.MessageMediaDocument &&
    !media.ttlSeconds &&
    media.document instanceof Api.Document &&
    ["image/jpeg", "image/png", "image/webp"].includes(media.document.mimeType)
  ) {
    return {
      mime: media.document.mimeType,
      name: "Изображение",
      size: Number(media.document.size),
    };
  }
}
export function imageMime(bytes: Buffer) {
  if (
    bytes.length >= 3 &&
    bytes[0] === 255 &&
    bytes[1] === 216 &&
    bytes[2] === 255
  )
    return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (
    bytes.length >= 12 &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  )
    return "image/webp";
  throw new Error("Telegram вернул неподдерживаемый формат изображения.");
}

export const MAX_VIDEO_BYTES = 150 * 1024 * 1024;
export function videoInfo(
  m: Api.Message,
): Pick<Attachment, "mime" | "name" | "size"> | undefined {
  const media = m.media;
  if (
    !(media instanceof Api.MessageMediaDocument) ||
    media.ttlSeconds ||
    !(media.document instanceof Api.Document) ||
    media.document.mimeType !== "video/mp4"
  )
    return;
  const attribute = media.document.attributes.find(
    (a) => a instanceof Api.DocumentAttributeVideo,
  );
  if (!(attribute instanceof Api.DocumentAttributeVideo)) return;
  return {
    mime: "video/mp4",
    name: attribute.roundMessage ? "Видеосообщение" : "Видео",
    size: Number(media.document.size),
  };
}
export function videoMime(bytes: Buffer) {
  if (bytes.length >= 12 && bytes.toString("ascii", 4, 8) === "ftyp")
    return "video/mp4";
  throw new Error("Telegram вернул неподдерживаемый формат видео.");
}

export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
export function documentInfo(
  m: Api.Message,
): Pick<Attachment, "mime" | "name" | "size"> | undefined {
  const media = m.media;
  if (
    !(media instanceof Api.MessageMediaDocument) ||
    media.ttlSeconds ||
    !(media.document instanceof Api.Document)
  )
    return;
  const doc = media.document;
  const attribute = doc.attributes.find(
    (a) => a instanceof Api.DocumentAttributeFilename,
  );
  const original =
    attribute instanceof Api.DocumentAttributeFilename
      ? attribute.fileName
      : "";
  const name =
    original
      .split(/[\\/]/)
      .pop()
      ?.replace(/[\x00-\x1f\x7f]/g, "")
      .slice(0, 200) || "Документ";
  const mime = doc.mimeType.toLowerCase();
  const kind =
    mime === "application/pdf" || /\.pdf$/i.test(name)
      ? "pdf"
      : mime === "application/epub+zip" || /\.epub$/i.test(name)
        ? "epub"
        : undefined;
  if (!kind) return;
  return {
    name: /\.(pdf|epub)$/i.test(name) ? name : `${name}.${kind}`,
    mime: kind === "pdf" ? "application/pdf" : "application/epub+zip",
    size: Number(doc.size),
  };
}
export function documentMime(bytes: Buffer) {
  if (bytes.subarray(0, 1024).includes(Buffer.from("%PDF-")))
    return "application/pdf";
  if (
    bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4])) &&
    bytes.subarray(0, 1024).includes(Buffer.from("application/epub+zip"))
  )
    return "application/epub+zip";
  throw new Error("Telegram вернул файл, не являющийся PDF или EPUB.");
}
