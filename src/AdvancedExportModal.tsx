import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { localDate, type Order } from "../shared/orders";
import type { DeliveryFilter, DeliverySource } from "../shared/delivery-export";
export default function AdvancedExportModal({
  onClose,
  onResult,
}: {
  onClose: () => void;
  onResult: (orders: Order[], filter: DeliveryFilter) => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    lock = useRef(false),
    controller = useRef<AbortController | null>(null);
  const [filter, setFilter] = useState<DeliveryFilter>({
      startDate: localDate(),
      endDate: localDate(),
      source: "ALL",
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    dialog.current?.showModal();
    return () => {
      controller.current?.abort();
      dialog.current?.close();
    };
  }, []);
  async function generate() {
    if (
      lock.current ||
      !filter.startDate ||
      !filter.endDate ||
      filter.startDate > filter.endDate
    )
      return;
    lock.current = true;
    setBusy(true);
    setError("");
    const c = new AbortController();
    controller.current = c;
    try {
      const r = await fetch(
        "/api/orders/export?" +
          new URLSearchParams({ ...filter, scope: "all" }),
        { signal: c.signal },
      );
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || "Не удалось получить заказы");
      if (!c.signal.aborted) await onResult(data, filter);
    } catch (e) {
      if (!c.signal.aborted)
        setError(e instanceof Error ? e.message : "Ошибка экспорта");
    } finally {
      if (!c.signal.aborted) setBusy(false);
      lock.current = false;
    }
  }
  return (
    <dialog
      ref={dialog}
      className="advanced-export"
      aria-labelledby="advanced-export-title"
      onCancel={onClose}
    >
      <header>
        <h2 id="advanced-export-title">Расширенный экспорт</h2>
        <button aria-label="Закрыть расширенный экспорт" onClick={onClose}>
          <X />
        </button>
      </header>
      <p className="export-description">
        Все заказы по дате заказа: доставка, самовывоз и почта. Один Excel с
        листами «Заказы» и «Итоги». Отменённые видны в отчёте, но не увеличивают
        итоговую сумму.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void generate();
        }}
      >
        <label>
          От
          <input
            type="date"
            required
            value={filter.startDate}
            disabled={busy}
            onChange={(e) =>
              setFilter({ ...filter, startDate: e.target.value })
            }
          />
        </label>
        <label>
          До
          <input
            type="date"
            required
            min={filter.startDate}
            value={filter.endDate}
            disabled={busy}
            onChange={(e) => setFilter({ ...filter, endDate: e.target.value })}
          />
        </label>
        <label>
          Магазин
          <select
            aria-label="Магазин"
            value={filter.source}
            disabled={busy}
            onChange={(e) =>
              setFilter({ ...filter, source: e.target.value as DeliverySource })
            }
          >
            <option value="ALL">Все</option>
            <option>STOREBOOKS</option>
            <option>MANGASTORE</option>
          </select>
        </label>
        {error && <p role="alert">{error}</p>}
        <button
          className="primary"
          disabled={
            busy ||
            !filter.startDate ||
            !filter.endDate ||
            filter.startDate > filter.endDate
          }
        >
          {busy ? "Генерируем…" : "Сгенерировать отчёт"}
        </button>
      </form>
    </dialog>
  );
}
