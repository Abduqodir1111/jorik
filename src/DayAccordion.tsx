import { useId, useRef, useLayoutEffect, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
export default function DayAccordion({
  title,
  count,
  open,
  onToggle,
  actions,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  actions: ReactNode;
  children: ReactNode;
}) {
  const id = useId(),
    content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = content.current;
    if (!el) return;
    if (open) el.removeAttribute("hidden");
    else el.setAttribute("hidden", "until-found");
    const match = () => {
      if (!open) onToggle();
    };
    el.addEventListener("beforematch", match);
    return () => el.removeEventListener("beforematch", match);
  }, [open, onToggle]);
  return (
    <section className="order-group day-accordion">
      <header>
        <button
          className="day-toggle"
          aria-expanded={open}
          aria-controls={id}
          onClick={onToggle}
        >
          <ChevronDown size={18} className={open ? "is-open" : ""} />
          <h2>{title}</h2>
          <span>{count} заказов</span>
        </button>
        <div className="day-actions">{actions}</div>
      </header>
      <div ref={content} id={id}>
        {children}
      </div>
    </section>
  );
}
