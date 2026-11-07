import type { Attachment } from "../shared/types.js";
export type InstagramMedia = {
  location_data?: { latitude?: number; longitude?: number; name?: string };
  mime_type?: string;
  file_url?: string;
  audio_data?: { url?: string };
  image_data?: { url?: string };
  video_data?: { url?: string };
};
export function trustedInstagramMediaUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      (u.port && u.port !== "443")
    )
      return null;
    if (
      ![
        "fbsbx.com",
        "fbcdn.net",
        "cdninstagram.com",
        "facebook.com",
        "instagram.com",
      ].some((d) => u.hostname === d || u.hostname.endsWith("." + d))
    )
      return null;
    return u.href;
  } catch {
    return null;
  }
}
export function instagramMedia(items: InstagramMedia[] = []) {
  return items.flatMap((item, index) => {
    const audioUrl =
      item.audio_data?.url ||
      (item.mime_type?.startsWith("audio/") ? item.file_url : undefined);
    const kind = audioUrl ? "voice" : item.video_data ? "video" : "image";
    const url = trustedInstagramMediaUrl(
      audioUrl ?? item.video_data?.url ?? item.image_data?.url,
    );
    return url
      ? [{ kind: kind as "image" | "video" | "voice", url, index }]
      : [];
  });
}
export function instagramAttachments(
  items: InstagramMedia[] | undefined,
  id: string,
): Attachment[] {
  const media: Attachment[] = instagramMedia(items).map((m) => ({
    kind: m.kind,
    url: `/api/instagram/media/${id}/${m.index}`,
    name:
      m.kind === "voice"
        ? "Голосовое сообщение"
        : m.kind === "image"
          ? "Фото Instagram"
          : "Видео Instagram",
    mime:
      m.kind === "voice"
        ? "audio/mp4"
        : m.kind === "image"
          ? "image/jpeg"
          : "video/mp4",
    size: 0,
  }));
  for (const item of items || []) {
    const loc = item.location_data;
    if (
      loc &&
      Number.isFinite(loc.latitude) &&
      Number.isFinite(loc.longitude) &&
      Math.abs(loc.latitude!) <= 90 &&
      Math.abs(loc.longitude!) <= 180
    )
      media.push({
        kind: "location",
        latitude: loc.latitude,
        longitude: loc.longitude,
        url: "",
        name: loc.name || "Геолокация",
        mime: "application/geo+json",
        size: 0,
      });
  }
  return media;
}
