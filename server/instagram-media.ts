import type { Attachment } from "../shared/types.js";
export type InstagramMedia = {
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
    const kind = item.video_data ? "video" : "image";
    const url = trustedInstagramMediaUrl(
      item.video_data?.url ?? item.image_data?.url,
    );
    return url ? [{ kind: kind as "image" | "video", url, index }] : [];
  });
}
export function instagramAttachments(
  items: InstagramMedia[] | undefined,
  id: string,
): Attachment[] {
  return instagramMedia(items).map((m) => ({
    kind: m.kind,
    url: `/api/instagram/media/${id}/${m.index}`,
    name: m.kind === "image" ? "Фото Instagram" : "Видео Instagram",
    mime: m.kind === "image" ? "image/jpeg" : "video/mp4",
    size: 0,
  }));
}
