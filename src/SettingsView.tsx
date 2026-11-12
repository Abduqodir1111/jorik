import { useState, type ReactNode } from "react";
import { Plus, Trash2, Check, LogOut, Volume2, Sun, Moon, Save, Server, Users, ChevronDown } from "lucide-react";
import { useOperator } from "./OperatorContext";
import type { Mode } from "../shared/types";
import "./settings-view.css";
import { MAX_QUICK_REPLIES, quickReplyHotkey } from "../shared/quick-replies";
import { useWebPush } from "./useWebPush";

type Props = {
  accountsContent: ReactNode;
  accountsExpanded: boolean;
  onToggleAccounts: () => void;
  ownerName: string;
  online: boolean;
  mode: Mode;
  sound: {
    enabled: boolean;
    setEnabled: (v: boolean) => void;
    play: (preview?: boolean) => void;
    status: string;
  };
  onSaveOwner: (name: string) => Promise<void>;
  onLogout?: () => void;
};
export default function SettingsView({
  accountsContent,
  accountsExpanded,
  onToggleAccounts,
  ownerName,
  online,
  mode,
  sound,
  onSaveOwner,
  onLogout,
}: Props) {
  const push = useWebPush();
  const {
    fontSize,
    setFontSize,
    dark,
    toggleTheme,
    slots,
    addTemplate,
    removeTemplate,
    updateTemplate,
    saveStatus,
    saveSlots,
  } = useOperator();
  const [name, setName] = useState(ownerName),
    [busy, setBusy] = useState(false),
    [result, setResult] = useState("");
  async function save() {
    if (busy) return;
    if (!name.trim()) {
      setResult("Введите отображаемое имя.");
      return;
    }
    setBusy(true);
    setResult("");
    try {
      await saveSlots();
      await onSaveOwner(name.trim());
      setResult("Все настройки сохранены");
    } catch (e) {
      setResult(
        e instanceof Error ? e.message : "Не удалось сохранить настройки",
      );
    } finally {
      setBusy(false);
    }
  }
  const saveButton = (label: string) => (
    <button
      type="button"
      className="primary settings-save"
      disabled={busy || !name.trim()}
      onClick={() => void save()}
    >
      <Save size={15} />
      {busy ? "Сохраняем…" : label}
    </button>
  );
  return (
    <div className="page-content settings-page redesigned-settings">
      <div className="settings-inner">
        <header className="settings-title">
          <div>
            <span className="eyebrow">ВАШЕ ПРОСТРАНСТВО</span>
            <h1>Настройки</h1>
            <p>
              Управление диалогами, быстрыми ответами и рабочим пространством.
            </p>
          </div>
          {saveButton("Сохранить изменения")}
        </header>
        <section className="settings-card accounts-settings-card">
          <button
            type="button"
            className="settings-accounts-toggle"
            aria-expanded={accountsExpanded}
            aria-controls="settings-account-connections"
            onClick={onToggleAccounts}
          >
            <Users size={20} aria-hidden="true" />
            <span>Аккаунты и подключения</span>
            <ChevronDown size={18} aria-hidden="true" style={{transform:accountsExpanded ? "rotate(180deg)" : undefined}} />
          </button>
          <p>Управление подключениями Telegram и Instagram. Ответ отправляется через аккаунт, в который написал клиент.</p>
          {accountsExpanded && <div id="settings-account-connections">{accountsContent}</div>}
        </section>
        <section className="settings-card">
          <h2>Push-уведомления</h2>
          <p>Новые сообщения Telegram и Instagram, даже когда Jorik закрыт. Настройка действует для этого устройства.</p>
          {push.hint ? <p>{push.hint}</p> : <button type="button" className="primary"
            disabled={!push.ready || push.busy}
            onClick={() => void (push.enabled ? push.disable() : push.enable())}>
            {push.busy ? "Подождите…" : push.enabled ? "Отключить push-уведомления" : "Включить push-уведомления"}
          </button>}
          {push.status && <p role="status">{push.status}</p>}
        </section>
        <section className="settings-card preferences-card">
          <header>
            <h2>Внешний вид и уведомления</h2>
            <p>
              Шрифт, тема и звук сохраняются на этом устройстве сразу после
              изменения.
            </p>
          </header>
          <div className="preferences-grid">
            <div>
              <label>Размер текста сообщений</label>
              <div
                className="settings-segments"
                role="group"
                aria-label="Размер текста"
              >
                {[14, 15, 18].map((size) => (
                  <button
                    type="button"
                    key={size}
                    aria-pressed={fontSize === size}
                    onClick={() => setFontSize(size)}
                  >
                    {size} px
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label>Звуковое уведомление</label>
              <div className="sound-controls">
                <button
                  type="button"
                  className="settings-switch"
                  role="switch"
                  aria-label="Звук новых сообщений"
                  aria-checked={sound.enabled}
                  onClick={() => sound.setEnabled(!sound.enabled)}
                >
                  <span />
                </button>
                <span>{sound.enabled ? "Включён" : "Отключён"}</span>
                <button
                  type="button"
                  className="sound-preview"
                  onClick={() => sound.play(true)}
                >
                  <Volume2 size={14} />
                  Тест звука
                </button>
              </div>
              <small>Мягкий двойной сигнал для Telegram и Instagram.</small>
              {sound.status && <small role="status">{sound.status}</small>}
            </div>
          </div>
          <div className="theme-row">
            <div>
              <label>Цветовое оформление</label>
              <p>Выберите удобную тему для работы.</p>
            </div>
            <div
              className="settings-segments"
              role="group"
              aria-label="Цветовое оформление"
            >
              <button
                type="button"
                aria-pressed={!dark}
                onClick={() => {
                  if (dark) toggleTheme();
                }}
              >
                <Sun size={14} />
                Светлая
              </button>
              <button
                type="button"
                aria-pressed={dark}
                onClick={() => {
                  if (!dark) toggleTheme();
                }}
              >
                <Moon size={14} />
                Тёмная
              </button>
            </div>
          </div>
        </section>
        <section className="settings-card replies-card">
          <header>
            <div>
              <h2>Быстрые ответы на панели</h2>
              <p>
                Кнопка вставляет текст. Ctrl + 1–9 сразу отправляет шаблон в
                чат.
              </p>
            </div>
            <span className="slot-count">{slots.length} / {MAX_QUICK_REPLIES} шаблонов</span>
          </header>
          <div className="settings-slots">
            {slots.map((slot, i) => (
              <fieldset key={slot.id}>
                <legend>Слот {i + 1}</legend>
                {quickReplyHotkey(i) && <kbd>{quickReplyHotkey(i)}</kbd>}
                <button type="button" className="template-delete" aria-label={`Удалить шаблон ${i + 1}`} onClick={() => removeTemplate(slot.id)}><Trash2 size={16} /></button>
                <label>
                  Название кнопки
                  <input
                    aria-label={`Название слота ${i + 1}`}
                    maxLength={40}
                    value={slot.title}
                    placeholder="Например, 🚚 Доставка"
                    onChange={(e) => {
                      setResult("");
                      updateTemplate(slot.id, "title", e.target.value);
                    }}
                  />
                </label>
                <label>
                  Текст шаблона
                  <textarea
                    aria-label={`Текст слота ${i + 1}`}
                    rows={2}
                    maxLength={4000}
                    value={slot.text}
                    placeholder="Текст ответа клиенту…"
                    onChange={(e) => {
                      setResult("");
                      updateTemplate(slot.id, "text", e.target.value);
                    }}
                  />
                </label>
              </fieldset>
            ))}
          </div>
          <button type="button" className="template-add" disabled={slots.length >= MAX_QUICK_REPLIES} onClick={addTemplate}><Plus size={16} /> Добавить шаблон</button>
          <small role="status">
            {saveStatus ||
              "Быстрые ответы автоматически сохраняются на сервере."}
          </small>
        </section>
        <section className="settings-card profile-card">
          <header>
            <h2>Профиль и синхронизация</h2>
            <p>Имя владельца и состояние соединения с сервером Jorik.</p>
          </header>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label>
              Отображаемое имя
              <div className="profile-name-row">
                <input
                  required
                  maxLength={80}
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    setResult("");
                  }}
                  aria-label="Отображаемое имя"
                  placeholder="Имя владельца или оператора"
                />
                {saveButton("Сохранить")}
              </div>
            </label>
          </form>
          <div className="settings-server">
            <div>
              <strong>
                <Server size={16} />
                <span
                  className={online ? "server-dot" : "server-dot offline"}
                />
                {online
                  ? "Соединение с Jorik активно"
                  : "Нет соединения с Jorik"}
              </strong>
              <p>
                История, заказы и черновики хранятся на сервере.
                {mode === "demo" ? " Демонстрационный режим." : ""}
              </p>
            </div>

          </div>
        </section>
        <footer className="settings-footer">
          <p role="status">
            {result && (
              <>
                {result === "Все настройки сохранены" && <Check size={15} />}
                {result}
              </>
            )}
          </p>
          {saveButton("Сохранить все настройки")}
        </footer>
        {onLogout && <section className="settings-card settings-session-card" aria-label="Выход из аккаунта">
          <p>Приём сообщений продолжится на сервере после выхода.</p>
          <button type="button" className="settings-logout" onClick={onLogout}>
            <LogOut size={16} aria-hidden="true" />
            Выйти из системы
          </button>
        </section>}

      </div>
    </div>
  );
}
