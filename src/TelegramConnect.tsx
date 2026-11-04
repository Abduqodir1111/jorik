import { useEffect, useState } from "react";
type Status = {
  ready: boolean;
  stage: "phone" | "code" | "password" | "connected";
  busy: boolean;
  syncing: boolean;
  error: string | null;
  connected: boolean;
  codeViaApp: boolean;
  scope: string;
};
export default function TelegramConnect({
  onChange,
  accountId,
  active = true,
}: {
  onChange: () => void;
  accountId: string;
  active?: boolean;
}) {
  const [status, setStatus] = useState<Status | null>(null),
    [phone, setPhone] = useState(""),
    [code, setCode] = useState(""),
    [password, setPassword] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function request(path: string, body?: unknown) {
    const res = await fetch(
      "/api/telegram/" + path + "?account=" + encodeURIComponent(accountId),
      {
        method: body === undefined ? "GET" : "POST",
        headers:
          body === undefined
            ? undefined
            : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? "Запрос не выполнен");
    return data;
  }
  useEffect(() => {
    if (!active) return;
    let mounted = true;
    const update = () =>
      request("status")
        .then((s) => {
          if (mounted) setStatus(s);
        })
        .catch(() => {});
    void update();
    const timer = setInterval(update, 2000);
    return () => {
      mounted = false;
      clearInterval(timer);
    };
  }, [accountId, active]);
  async function submit() {
    if (busy || !status) return;
    setBusy(true);
    setError("");
    try {
      if (status.stage === "phone") {
        setStatus(await request("start", { phone: phone.trim() }));
        setPhone("");
      } else if (status.stage === "code") {
        const value = code;
        setCode("");
        setStatus(await request("code", { code: value.trim() }));
      } else if (status.stage === "password") {
        const value = password;
        setPassword("");
        setStatus(await request("password", { password: value }));
      } else {
        await request("sync", {});
        setStatus(await request("status"));
      }
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не удалось выполнить вход");
    } finally {
      setBusy(false);
    }
  }
  if (!status) return <p>Проверяем настройки Telegram…</p>;
  return (
    <div className="telegram-connect">
      {status.stage === "connected" ? (
        <>
          <p className="connection-description">
            {status.syncing
              ? "Загружаем диалоги…"
              : status.connected
                ? "Сессия сохранена. Можно отвечать из раздела «Входящие»."
                : "Восстанавливаем соединение…"}
          </p>
          <button
            className="primary"
            disabled={busy || status.syncing}
            onClick={() => void submit()}
          >
            {busy || status.syncing ? "Синхронизация…" : "Обновить диалоги"}
          </button>
          <small>
            {status.scope}. Откройте диалог для загрузки истории. Фотографии
            открываются прямо в чате.
          </small>
        </>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <h3>Подключить ваш Telegram</h3>
          <p className="connection-description">
            {status.stage === "phone"
              ? "Войдите в этот аккаунт по номеру телефона. Это даст Jorik доступ к вашим личным диалогам. Сообщения отправляются только по кнопке «Отправить»."
              : status.stage === "code"
                ? `Введите код, который Telegram отправил ${status.codeViaApp ? "в приложение Telegram" : "на ваш номер"}. Код из my.telegram.org здесь не подходит.`
                : "Введите пароль двухэтапной защиты Telegram. Это не пароль владельца Jorik."}
          </p>
          {!status.ready ? (
            <p className="error">
              На сервере не настроены API-ключи или ключ шифрования.
            </p>
          ) : (
            <>
              {status.stage === "phone" && (
                <label>
                  Номер телефона
                  <input
                    type="tel"
                    placeholder="+998…"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    autoComplete="tel"
                    required
                    pattern="\+[1-9][0-9]{6,14}"
                  />
                </label>
              )}
              {status.stage === "code" && (
                <label>
                  Код входа
                  <input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    required
                    minLength={4}
                    maxLength={8}
                  />
                </label>
              )}
              {status.stage === "password" && (
                <label>
                  Пароль двухэтапной защиты
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="off"
                    required
                  />
                </label>
              )}
              <button className="primary" disabled={busy || status.busy}>
                {busy
                  ? "Проверяем…"
                  : status.stage === "phone"
                    ? "Получить код Telegram"
                    : "Подтвердить вход"}
              </button>
              {(status.stage === "code" || status.stage === "password") && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy}
                  onClick={() => {
                    setCode("");
                    setPassword("");
                    setStatus({ ...status, stage: "phone" });
                    setError("");
                  }}
                >
                  Начать заново
                </button>
              )}
            </>
          )}
          <small>
            Код и пароль не сохраняются. Сессия хранится зашифрованной только на
            вашем Mac. Доступ можно отозвать в Telegram → Настройки →
            Устройства.
          </small>
        </form>
      )}
      {(error || status.error) && (
        <p className="error" role="alert">
          {error || status.error}
        </p>
      )}
    </div>
  );
}
