import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  normalizeQuickReplies,
  MAX_QUICK_REPLIES,
  type QuickReply,
} from "../shared/quick-replies";
export type { QuickReply } from "../shared/quick-replies";
const Context = createContext<{
  fontSize: number;
  setFontSize: (size: number) => void;
  slots: QuickReply[];
  addTemplate: () => void;
  removeTemplate: (id: string) => void;
  updateTemplate: (id: string, field: "title" | "text", value: string) => void;
  hydrate: (value?: string) => void;
  saveStatus: string;
  saveSlots: () => Promise<void>;
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
  const [slots, setSlots] = useState<QuickReply[]>([]),
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
      const parsed = normalizeQuickReplies(value ? JSON.parse(value) : []);
      if (parsed) {
        latest.current = parsed;
        setSlots((old) =>
          JSON.stringify(old) === JSON.stringify(parsed) ? old : parsed,
        );
      }
    } catch {}
  };
  function changeTemplates(next: QuickReply[]) {
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
  function addTemplate() {
    if (latest.current.length >= MAX_QUICK_REPLIES) return;
    changeTemplates([
      ...latest.current,
      { id: crypto.randomUUID(), title: "", text: "" },
    ]);
  }
  function removeTemplate(id: string) {
    changeTemplates(latest.current.filter((s) => s.id !== id));
  }
  function updateTemplate(id: string, field: "title" | "text", value: string) {
    changeTemplates(
      latest.current.map((s) => (s.id === id ? { ...s, [field]: value } : s)),
    );
  }
  async function saveSlots() {
    if (timer.current) clearTimeout(timer.current);
    const next = latest.current,
      revision = ++version.current;
    setSaveStatus("Сохранение…");
    const task = chain.current
      .catch(() => {})
      .then(async () => {
        const r = await fetch("/api/quick-replies", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(next),
        });
        if (!r.ok) throw Error("Не удалось сохранить быстрые ответы");
        if (version.current === revision) {
          dirty.current = false;
          setSaveStatus("Сохранено");
        }
      });
    chain.current = task.catch(() => {
      setSaveStatus("Не удалось сохранить. Повторите попытку.");
    });
    await task;
  }
  useEffect(() => {
    const flush = () => {
      if (dirty.current)
        void fetch("/api/quick-replies", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(latest.current),
          keepalive: new Blob([JSON.stringify(latest.current)]).size < 60000,
        }).catch(() => {});
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
        addTemplate,
        removeTemplate,
        updateTemplate,
        hydrate,
        saveStatus,
        saveSlots,
        dark,
        toggleTheme: () => setDark((x) => !x),
      }}
    >
      {children}
    </Context.Provider>
  );
}
