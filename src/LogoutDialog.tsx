import { useEffect, useRef, useState } from "react";
import { LogOut, X } from "lucide-react";
import "./logout-dialog.css";

export default function LogoutDialog({
  onCancel,
  onConfirm,
}: {
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const stay = useRef<HTMLButtonElement>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    stay.current?.focus();
  }, []);
  async function confirm() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Не удалось выйти. Попробуйте ещё раз.",
      );
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="logout-dialog"
      aria-labelledby="logout-title"
      aria-describedby="logout-description"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onCancel();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div className="logout-card">
        <button
          type="button"
          className="logout-close"
          aria-label="Закрыть подтверждение выхода"
          disabled={busy}
          onClick={onCancel}
        >
          <X size={19} />
        </button>
        <span className="logout-symbol">
          <LogOut size={26} />
        </span>
        <h2 id="logout-title">Выйти из Jorik?</h2>
        <p id="logout-description">
          Вы завершите сеанс на этом устройстве. Чтобы вернуться к диалогам,
          потребуется снова войти.
        </p>
        <div className="logout-note">
          Сообщения продолжат поступать на сервер.
        </div>
        {error && (
          <p className="logout-error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button
            type="button"
            ref={stay}
            className="logout-stay"
            autoFocus
            disabled={busy}
            onClick={onCancel}
          >
            Остаться
          </button>
          <button
            type="button"
            className="logout-confirm"
            disabled={busy}
            onClick={() => void confirm()}
          >
            <LogOut size={16} />
            {busy ? "Выходим…" : "Выйти"}
          </button>
        </footer>
      </div>
    </dialog>
  );
}
