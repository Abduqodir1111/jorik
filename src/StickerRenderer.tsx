import { useEffect, useRef, useState } from "react";
import type { Attachment } from "../shared/types";
export default function StickerRenderer({
  attachment: a,
}: {
  attachment: Attachment;
}) {
  const host = useRef<HTMLDivElement>(null),
    [failed, setFailed] = useState(false);
  useEffect(() => {
    if (a.mime !== "application/x-tgsticker") return;
    const controller = new AbortController();
    let animation: { destroy(): void } | undefined;
    void (async () => {
      const r = await fetch(a.url, { signal: controller.signal });
      if (!r.ok) throw new Error();
      const data = await r.json();
      if (controller.signal.aborted) return;
      const { default: lottie } =
        await import("lottie-web/build/player/lottie_light");
      if (controller.signal.aborted || !host.current) return;
      animation = lottie.loadAnimation({
        container: host.current,
        renderer: "svg",
        loop: true,
        autoplay: !matchMedia("(prefers-reduced-motion: reduce)").matches,
        animationData: data,
      });
    })().catch(() => {
      if (!controller.signal.aborted) setFailed(true);
    });
    return () => {
      controller.abort();
      animation?.destroy();
    };
  }, [a.url, a.mime]);
  if (failed) return <div>Стикер недоступен</div>;
  if (a.mime === "application/x-tgsticker")
    return (
      <div
        className="sticker"
        ref={host}
        role="img"
        aria-label="Анимированный стикер"
      />
    );
  return a.mime === "video/webm" ? (
    <video
      className="sticker"
      src={a.url}
      autoPlay
      loop
      muted
      playsInline
      onError={() => setFailed(true)}
    />
  ) : (
    <img
      className="sticker"
      src={a.url}
      alt="Стикер"
      loading="lazy"
      onError={() => setFailed(true)}
    />
  );
}
