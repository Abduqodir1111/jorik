import { useRef, useState } from "react";
import { Play, Pause } from "lucide-react";
import type { Attachment } from "../shared/types";
const stamp = (n: number) =>
  `${Math.floor((Number.isFinite(n) ? n : 0) / 60)}:${String(Math.floor((Number.isFinite(n) ? n : 0) % 60)).padStart(2, "0")}`;
export default function VoicePlayer({
  attachment: a,
}: {
  attachment: Attachment;
}) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false),
    [position, setPosition] = useState(0),
    [duration, setDuration] = useState(a.duration || 0),
    [error, setError] = useState("");
  const tg = a.url.startsWith("/api/telegram/media/");
  const [fallback, setFallback] = useState(
    () =>
      tg &&
      ["audio/ogg", "audio/opus"].includes(a.mime) &&
      !document.createElement("audio").canPlayType('audio/ogg; codecs="opus"'),
  );
  const source = fallback && tg ? a.url + "?compatible=1" : a.url;
  async function toggle() {
    const el = audio.current;
    if (!el) return;
    setError("");
    if (playing) el.pause();
    else
      try {
        if (el.error) el.load();
        await el.play();
      } catch {
        setError("Не удалось воспроизвести. Нажмите ещё раз.");
      }
  }
  return (
    <div className="voice-player">
      <audio
        ref={audio}
        src={source}
        preload="none"
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => setPlaying(false)}
        onTimeUpdate={() => setPosition(audio.current?.currentTime || 0)}
        onLoadedMetadata={() =>
          setDuration(audio.current?.duration || a.duration || 0)
        }
        onError={() => {
          if (tg && !fallback) {
            setFallback(true);
            setError("Подготавливаем совместимое аудио. Нажмите ▶ ещё раз.");
          } else
            setError(
              "Аудио недоступно. Попробуйте снова или откройте исходное приложение.",
            );
        }}
      />
      <button
        type="button"
        onClick={() => void toggle()}
        aria-label={playing ? "Приостановить аудио" : "Воспроизвести аудио"}
      >
        {playing ? <Pause size={20} /> : <Play size={20} />}
      </button>
      <div>
        <input
          type="range"
          min={0}
          max={Number.isFinite(duration) ? duration : 0}
          step="0.1"
          value={position}
          aria-label="Позиция аудио"
          onChange={(e) => {
            if (audio.current)
              audio.current.currentTime = Number(e.target.value);
            setPosition(Number(e.target.value));
          }}
        />
        <small>
          {stamp(position)} / {stamp(duration)}
        </small>
        {error && <span role="status">{error}</span>}
      </div>
    </div>
  );
}
