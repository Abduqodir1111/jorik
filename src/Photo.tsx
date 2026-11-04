import { useRef, useState } from "react";
import { X, Download, Image as ImageIcon } from "lucide-react";
import type { Attachment } from "../shared/types";
export default function Photo({ attachment }: { attachment: Attachment }) {
  const [error, setError] = useState(false),
    [viewing, setViewing] = useState(false),
    [loaded, setLoaded] = useState(false),
    [attempt, setAttempt] = useState(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const url =
    attachment.url +
    (attempt
      ? (attachment.url.includes("?") ? "&" : "?") + "retry=" + attempt
      : "");
  return (
    <div className="photo-attachment">
      {!error ? (
        <button
          className="photo-preview"
          aria-label={"Открыть фото: " + attachment.name}
          onClick={() => {
            setViewing(true);
            dialog.current?.showModal();
          }}
          disabled={!loaded}
        >
          {!loaded && (
            <span className="photo-loading">
              <ImageIcon size={20} />
              Загрузка фотографии…
            </span>
          )}
          <img
            className="attachment-image"
            src={url}
            alt={attachment.name}
            loading="lazy"
            onLoad={() => setLoaded(true)}
            onError={() => setError(true)}
          />
          {loaded && (
            <span className="photo-enlarge">Нажмите, чтобы увеличить</span>
          )}
        </button>
      ) : (
        <div className="photo-error">
          <ImageIcon size={20} />
          <p>
            Фото не загрузилось. Попробуйте снова или откройте его в исходном
            приложении. Исчезнувшие вложения и фотографии больше 25 МБ могут
            быть недоступны.
          </p>
          <button
            className="secondary"
            onClick={() => {
              setError(false);
              setLoaded(false);
              setAttempt((x) => x + 1);
            }}
          >
            Повторить
          </button>
        </div>
      )}
      <dialog
        ref={dialog}
        className="photo-viewer"
        aria-label="Просмотр фотографии"
        onClose={() => setViewing(false)}
        onClick={(e) => {
          if (e.target === e.currentTarget) dialog.current?.close();
        }}
      >
        <div className="photo-viewer-bar">
          <span>{attachment.name}</span>
          <a
            href={url}
            download={attachment.name}
            aria-label="Скачать фотографию"
          >
            <Download size={21} />
          </a>
          <button
            autoFocus
            onClick={() => dialog.current?.close()}
            aria-label="Закрыть фотографию"
          >
            <X size={24} />
          </button>
        </div>
        {viewing && <img src={url} alt={attachment.name} />}
      </dialog>
    </div>
  );
}
