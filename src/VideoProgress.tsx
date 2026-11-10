import { AlertCircle, Check, LoaderCircle, Upload, Video } from "lucide-react";
import type { ArchiveJob } from "../shared/archive";
import "./video-progress.css";
export default function VideoProgress({ job }: { job: ArchiveJob }) {
  const phase = job.phase || "waiting",
    failed = ["error", "unknown"].includes(job.state);
  const labels = {
    waiting: "Ожидает подготовки",
    preparing: "Подготовка видео",
    queued: "В очереди отправки",
    uploading: "Загрузка видео",
    confirming: "Ожидаем подтверждения",
    complete: "Отправлено",
    error: "Не удалось отправить",
    unknown: "Результат отправки неизвестен",
  };
  const percent =
    !failed && ["preparing", "uploading"].includes(phase) && job.percent != null
      ? Math.max(0, Math.min(100, job.percent))
      : null;
  const divisor =
    (job.totalBytes ?? 0) < 1024
      ? 1
      : (job.totalBytes ?? 0) < 1024 * 1024
        ? 1024
        : 1024 * 1024;
  const unit = divisor === 1 ? "Б" : divisor === 1024 ? "КБ" : "МБ";
  const size = (n: number) =>
    (n / divisor).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
  return (
    <div
      className={"video-send-progress" + (failed ? " has-error" : "")}
      role="status"
      aria-live="polite"
    >
      <div className="video-send-heading">
        <span className="video-send-icon">
          {failed ? (
            <AlertCircle size={24} />
          ) : phase === "uploading" ? (
            <Upload size={24} />
          ) : (
            <Video size={24} />
          )}
        </span>
        <div>
          <strong>{job.name || "Видеообзор"}</strong>
          <span>
            {job.local && job.state === "preparing"
              ? "Добавляем в очередь"
              : labels[
                  failed
                    ? job.state === "unknown"
                      ? "unknown"
                      : "error"
                    : phase
                ]}
            {percent !== null && ` · ${percent}%`}
          </span>
        </div>
        {!failed && <LoaderCircle className="video-send-spinner" size={18} />}
      </div>
      {!failed && (
        <div
          className={
            "video-send-track" + (percent === null ? " is-indeterminate" : "")
          }
          role="progressbar"
          aria-label={labels[phase]}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent ?? undefined}
        >
          <span
            style={percent === null ? undefined : { width: percent + "%" }}
          />
        </div>
      )}
      {phase === "uploading" && !!job.totalBytes && (
        <small>
          {size(job.bytesSent ?? 0)} / {size(job.totalBytes)} {unit}
        </small>
      )}
      {!failed && job.error && <small>{job.error}</small>}
      {!failed && (
        <div className="video-send-steps">
          <span>{!job.local && <Check size={12} />} В очереди</span>
          <span>
            {["uploading", "confirming", "complete"].includes(phase) ? (
              <Check size={12} />
            ) : null}{" "}
            Подготовка
          </span>
          <span>Отправка</span>
        </div>
      )}
      {failed && (
        <small>
          {job.error || "Попробуйте позже."}
          {job.state === "unknown"
            ? " Проверьте чат в исходном приложении перед повторной отправкой."
            : ""}
        </small>
      )}
    </div>
  );
}
