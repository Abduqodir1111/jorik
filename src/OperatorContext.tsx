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
  hydrate: (value?: string, serverVersion?: string) => void;
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
      return [14, 15, 18].includes(size) ? size : 15;
    } catch {
      return 15;
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
    chain = useRef(Promise.resolve()),
    serverVersion = useRef<string | undefined>(undefined);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
    try {
      localStorage.setItem("jorik-theme", dark ? "dark" : "light");
    } catch {}
  }, [dark]);
  const hydrate = (value?: string, remoteVersion?: string) => {
    if (dirty.current) return;
    try {
      const parsed = normalizeQuickReplies(value ? JSON.parse(value) : []);
      if (parsed) {
        serverVersion.current = remoteVersion;
        latest.current = parsed;
        setSlots((old) =>
          JSON.stringify(old) === JSON.stringify(parsed) ? old : parsed,
        );
      }
    } catch {}
  };
  const headers = () => ({
    "Content-Type": "application/json",
    ...(serverVersion.current
      ? { "If-Match": JSON.stringify(serverVersion.current) }
      : {}),
  });
  async function persist(next: QuickReply[]) {
    const r = await fetch("/api/quick-replies", {
      method: "PUT",
      headers: headers(),
      body: JSON.stringify(next),
    });
    const data = await r.json();
    if (!r.ok) throw Error(data.error || "Не удалось сохранить быстрые ответы");
    serverVersion.current = data.version;
  }
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
          await persist(next);
          if (version.current === revision) {
            dirty.current = false;
            setSaveStatus("Сохранено");
          }
        })
        .catch((error: Error) =>
          setSaveStatus(
            error.message ||
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
        await persist(next);
        if (version.current === revision) {
          dirty.current = false;
          setSaveStatus("Сохранено");
        }
      });
    chain.current = task.catch((error: Error) => {
      setSaveStatus(
        error.message || "Не удалось сохранить. Повторите попытку.",
      );
    });
    await task;
  }
  useEffect(() => {
    const flush = () => {
      if (dirty.current)
        void fetch("/api/quick-replies", {
          method: "PUT",
          headers: headers(),
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
