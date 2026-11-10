import VideoProgress from "./VideoProgress";
import type { ArchiveJob } from "../shared/archive";
import { useState } from "react";
import type { Attachment } from "../shared/types";
export default function Video({
  attachment,
  job,
}: {
  attachment: Attachment;
  job?: ArchiveJob;
}) {
  const [failed, setFailed] = useState(false),
    [attempt, setAttempt] = useState(0);
  if (job && job.state !== "sent") return <VideoProgress job={job} />;
  return (
    <div className="video-attachment">
      {failed ? (
        <div className="photo-error">
          <p>
            Видео недоступно. Попробуйте загрузить снова или откройте его в
            исходном приложении.
          </p>
          <button
            className="secondary"
            onClick={() => {
              setAttempt((n) => n + 1);
              setFailed(false);
            }}
          >
            Повторить
          </button>
        </div>
      ) : (
        <video
          key={attempt}
          controls
          playsInline
          preload="none"
          aria-label={attachment.name}
          src={attachment.url + (attempt ? `?retry=${attempt}` : "")}
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}
