import { useState } from "react";
import type { Account } from "../shared/types";

export default function AccountName({
  account,
  onSaved,
}: {
  account: Account;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState(account.name);
  const [color, setColor] = useState(account.color);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  return (
    <form
      className="account-name-form"
      onSubmit={async (e) => {
        e.preventDefault();
        if (busy || !name.trim()) return;
        setBusy(true);
        setNotice("");
        setError("");
        try {
          const response = await fetch(`/api/accounts/${account.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name: name.trim(), color }),
          });
          if (!response.ok)
            throw new Error(
              (await response.json()).error ?? "Не удалось сохранить название",
            );
          setName(name.trim());
          await onSaved();
          setNotice("Название и цвет сохранены");
        } catch (e) {
          setError(
            e instanceof Error ? e.message : "Не удалось сохранить название",
          );
        } finally {
          setBusy(false);
        }
      }}
    >
      <label htmlFor={`name-${account.id}`}>Название аккаунта</label>
      <div className="account-name-row">
        <input
          id={`name-${account.id}`}
          style={{ color }}
          value={name}
          maxLength={80}
          required
          disabled={busy}
          placeholder="Например: Магазин · Заказы"
          onChange={(e) => {
            setName(e.target.value);
            setNotice("");
            setError("");
          }}
        />
        <button
          className="primary"
          disabled={
            busy ||
            !name.trim() ||
            (name.trim() === account.name && color === account.color)
          }
        >
          {busy ? "Сохраняем…" : "Сохранить"}
        </button>
      </div>
      <div className="account-color-row">
        <label htmlFor={`color-${account.id}`}>Цвет названия</label>
        <input
          id={`color-${account.id}`}
          type="color"
          value={color}
          disabled={busy}
          onChange={(e) => {
            setColor(e.target.value);
            setNotice("");
          }}
        />
        {["#286a90", "#276749", "#934866", "#8b5a16", "#6b46a1", "#b83232"].map(
          (value) => (
            <button
              key={value}
              type="button"
              className="color-swatch"
              style={{ backgroundColor: value }}
              aria-label={`Цвет ${value}`}
              aria-pressed={color === value}
              disabled={busy}
              onClick={() => {
                setColor(value);
                setNotice("");
              }}
            >
              {color === value ? "✓" : ""}
            </button>
          ),
        )}
      </div>
      <small>Это имя увидите в диалогах и возле кнопки отправки.</small>
      <small role="status">{notice}</small>
      {error && (
        <small className="error" role="alert">
          {error}
        </small>
      )}
    </form>
  );
}
