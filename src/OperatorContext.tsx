import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
export type QuickReply = { title: string; text: string };
const empty = () => Array.from({ length: 4 }, () => ({ title: "", text: "" }));
const Context = createContext<{
  fontSize: number;
  setFontSize: (size: number) => void;
  slots: QuickReply[];
  updateSlot: (i: number, patch: Partial<QuickReply>) => void;
  hydrate: (value?: string) => void;
  saveStatus: string;
  dark: boolean;
  toggleTheme: () => void;
}>(null!);
export const useOperator = () => useContext(Context);
export function OperatorProvider({ children }: { children: ReactNode }) {
  const [fontSize, setFontSize] = useState(() => {
    try {
      const size = Number(localStorage.getItem("jorik-font-size"));
      return [14, 16, 18].includes(size) ? size : 16;
    } catch {
      return 16;
    }
  });
  useEffect(() => {
    document.documentElement.style.setProperty(
      "--message-font-size",
      fontSize + "px",
    );
    try {
      localStorage.setItem("jorik-font-size", String(fontSize));
    } catch {}
  }, [fontSize]);
  const [slots, setSlots] = useState<QuickReply[]>(empty),
    [saveStatus, setSaveStatus] = useState("");
  const [dark, setDark] = useState(() => {
    try {
      return localStorage.getItem("jorik-theme") === "dark";
    } catch {
      return false;
    }
  });
  const latest = useRef(slots),
    dirty = useRef(false),
    timer = useRef<ReturnType<typeof setTimeout> | null>(null),
    version = useRef(0),
    chain = useRef(Promise.resolve());
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("jorik-theme", dark ? "dark" : "light");
    } catch {}
  }, [dark]);
  const hydrate = (value?: string) => {
    if (dirty.current) return;
    try {
      const parsed = value ? JSON.parse(value) : empty();
      if (
        Array.isArray(parsed) &&
        parsed.length === 4 &&
        parsed.every(
          (s) => typeof s.title === "string" && typeof s.text === "string",
        )
      ) {
        latest.current = parsed;
        setSlots((old) =>
          JSON.stringify(old) === JSON.stringify(parsed) ? old : parsed,
        );
      }
    } catch {}
  };
  function updateSlot(i: number, patch: Partial<QuickReply>) {
    const next = latest.current.map((s, index) =>
      index === i ? { ...s, ...patch } : s,
    );
    latest.current = next;
    setSlots(next);
    dirty.current = true;
    setSaveStatus("Сохранение…");
    const revision = ++version.current;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      chain.current = chain.current
        .catch(() => {})
        .then(async () => {
          const r = await fetch("/api/quick-replies", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(next),
          });
          if (!r.ok) throw Error();
          if (version.current === revision) {
            dirty.current = false;
            setSaveStatus("Сохранено");
          }
        })
        .catch(() =>
          setSaveStatus(
            "Не удалось сохранить. Измените поле, чтобы повторить.",
          ),
        );
    }, 400);
  }
  useEffect(() => {
    const flush = () => {
      if (dirty.current)
        void fetch("/api/quick-replies", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(latest.current),
          keepalive: true,
        });
    };
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);
  return (
    <Context.Provider
      value={{
        fontSize,
        setFontSize,
        slots,
        updateSlot,
        hydrate,
        saveStatus,
        dark,
        toggleTheme: () => setDark((x) => !x),
      }}
    >
      {children}
    </Context.Provider>
  );
}
export function QuickReplySettings() {
  const { slots, updateSlot, saveStatus } = useOperator();
  return (
    <section className="settings-card">
      <h2>Быстрые ответы на панели</h2>
      <p>
        Кнопка вставляет текст. Ctrl + 1–4 сразу отправляет шаблон в открытый
        чат.
      </p>
      <div className="slot-grid">
        {slots.map((slot, i) => (
          <fieldset key={i}>
            <legend>Слот {i + 1}</legend>
            <label>
              Название кнопки
              <input
                maxLength={40}
                value={slot.title}
                placeholder="Например, 👋 Приветствие"
                onChange={(e) => updateSlot(i, { title: e.target.value })}
              />
            </label>
            <label>
              Текст шаблона
              <textarea
                maxLength={4000}
                value={slot.text}
                placeholder="Текст ответа клиенту…"
                onChange={(e) => updateSlot(i, { text: e.target.value })}
              />
            </label>
          </fieldset>
        ))}
      </div>
      <small role="status">{saveStatus}</small>
    </section>
  );
}
