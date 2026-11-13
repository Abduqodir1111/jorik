import {
  useId,
  useLayoutEffect,
  useEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Smile, Search, X } from "lucide-react";
import {
  allEmoji,
  emojiCategories,
  filterEmoji,
  insertEmoji,
} from "./emoji-data";
import "./emoji-picker.css";

type Position = { top: number; left: number; width: number; height: number };
export default function EmojiButton({
  input,
  value,
  onChange,
  disabled,
  onOpen,
}: {
  input: RefObject<HTMLTextAreaElement | null>;
  value: string;
  onChange: (text: string) => void;
  disabled: boolean;
  onOpen?: () => void;
}) {
  const id = useId();
  const [open, setOpen] = useState(false),
    [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("smiles");
  const [position, setPosition] = useState<Position>();
  const button = useRef<HTMLButtonElement>(null),
    panel = useRef<HTMLDivElement>(null);
  const range = useRef({ start: value.length, end: value.length });
  const pendingCaret = useRef<number | null>(null);
  const search = useRef<HTMLInputElement>(null);
  function close(restore = false) {
    setOpen(false);
    if (restore) input.current?.focus({ preventScroll: true });
  }
  useLayoutEffect(() => {
    if (pendingCaret.current === null || !input.current) return;
    input.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    pendingCaret.current = null;
  }, [value, input]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const anchor = button.current?.getBoundingClientRect();
      if (!anchor) return;
      const viewport = window.visualViewport;
      const leftEdge = viewport?.offsetLeft ?? 0,
        topEdge = viewport?.offsetTop ?? 0;
      const width = Math.min(320, (viewport?.width ?? innerWidth) - 16);
      const bottom = topEdge + (viewport?.height ?? innerHeight);
      const above = anchor.top - topEdge - 16,
        below = bottom - anchor.bottom - 16;
      const height = Math.max(
        100,
        Math.min(350, Math.max(above, below), bottom - topEdge - 16),
      );
      const top = above >= below ? anchor.top - height - 8 : anchor.bottom + 8;
      const next = {
        left: Math.max(
          leftEdge + 8,
          Math.min(
            anchor.right - width,
            leftEdge + (viewport?.width ?? innerWidth) - width - 8,
          ),
        ),
        top: Math.max(topEdge + 8, Math.min(top, bottom - height - 8)),
        width,
        height,
      };
      setPosition((old) =>
        old &&
        Object.keys(next).every(
          (k) => old[k as keyof Position] === next[k as keyof Position],
        )
          ? old
          : next,
      );
    };
    update();
    const frame = requestAnimationFrame(update);
    // The mobile navigation can reappear after the textarea blurs without a
    // window resize. Track the layout too, so the panel never covers the input.
    const observer = new ResizeObserver(update);
    const main = button.current?.closest("main");
    if (main) observer.observe(main);
    if (button.current?.parentElement)
      observer.observe(button.current.parentElement);
    const viewport = window.visualViewport;
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
    };
  }, [open]);
  const positionReady = position !== undefined;
  useLayoutEffect(() => {
    if (!open || !positionReady) return;
    // Focus only after the measured panel is visible. Avoid opening the
    // software keyboard just to choose an emoji on a phone.
    (innerWidth >= 768 ? search.current : panel.current)?.focus({
      preventScroll: true,
    });
  }, [open, positionReady]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !button.current?.contains(target))
        setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(true);
      }
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("focusin", outside, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("focusin", outside, true);
      document.removeEventListener("keydown", key, true);
    };
  }, [open]);
  const items = query.trim()
    ? filterEmoji(query)
    : allEmoji.filter((item) =>
        emojiCategories
          .find((c) => c.id === category)
          ?.items.some(([emoji]) => emoji === item.emoji),
      );
  function select(emoji: string) {
    const textarea = input.current;
    if (disabled || !textarea || textarea.readOnly) return;
    const next = insertEmoji(
      textarea.value,
      range.current.start,
      range.current.end,
      emoji,
    );
    range.current = { start: next.caret, end: next.caret };
    if (next.text === textarea.value) {
      textarea.setSelectionRange(next.caret, next.caret);
      return;
    }
    pendingCaret.current = next.caret;
    onChange(next.text);
  }
  return (
    <>
      <button
        ref={button}
        type="button"
        className="emoji-toggle"
        aria-label="Выбрать эмодзи"
        title="Эмодзи"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-haspopup="dialog"
        disabled={disabled}
        onPointerDown={(event) => event.preventDefault()}
        onClick={() => {
          if (open) {
            close(true);
            return;
          }
          const textarea = input.current;
          range.current = {
            start: textarea?.selectionStart ?? value.length,
            end: textarea?.selectionEnd ?? value.length,
          };
          setQuery("");
          onOpen?.();
          setOpen(true);
        }}
      >
        <Smile size={23} />
      </button>
      {open &&
        createPortal(
          <div
            ref={panel}
            id={id}
            role="dialog"
            aria-label="Эмодзи"
            tabIndex={-1}
            className="emoji-popover"
            style={{ ...position, visibility: position ? "visible" : "hidden" }}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <header>
              <strong>Эмодзи</strong>
              <button
                type="button"
                aria-label="Закрыть эмодзи"
                onClick={() => close(true)}
              >
                <X size={18} />
              </button>
            </header>
            <label className="emoji-search">
              <Search size={16} />
              <input
                ref={search}
                type="search"
                aria-label="Найти эмодзи"
                placeholder="Найти эмодзи"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
            <div
              className="emoji-categories"
              role="group"
              aria-label="Категории эмодзи"
            >
              {emojiCategories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  aria-label={c.name}
                  title={c.name}
                  aria-pressed={!query.trim() && category === c.id}
                  onClick={() => {
                    setCategory(c.id);
                    setQuery("");
                  }}
                >
                  {c.icon}
                </button>
              ))}
            </div>
            <div
              className="emoji-grid"
              role="group"
              aria-label="Список эмодзи"
              onKeyDown={(e) => {
                const buttons = [
                    ...e.currentTarget.querySelectorAll<HTMLButtonElement>(
                      "button",
                    ),
                  ],
                  index = buttons.indexOf(
                    document.activeElement as HTMLButtonElement,
                  );
                const step = {
                  ArrowRight: 1,
                  ArrowLeft: -1,
                  ArrowDown: 8,
                  ArrowUp: -8,
                }[e.key];
                if (step !== undefined && index >= 0) {
                  e.preventDefault();
                  buttons[
                    Math.max(0, Math.min(buttons.length - 1, index + step))
                  ]?.focus();
                }
              }}
            >
              {items.map((item) => (
                <button
                  key={item.emoji}
                  type="button"
                  aria-label={item.emoji + " " + item.label}
                  title={item.label}
                  onClick={() => select(item.emoji)}
                >
                  {item.emoji}
                </button>
              ))}
            </div>
            {!items.length && (
              <p role="status" className="emoji-empty">
                Ничего не найдено
              </p>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
