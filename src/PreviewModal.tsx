import { useEffect, useRef, useState } from "react";
import { Copy, Download, X } from "lucide-react";
import {
  deliveryTSV,
  type DeliveryWorksheet,
  type DeliveryFilter,
} from "../shared/delivery-export";
import { downloadDelivery } from "./orders-export";
export default function PreviewModal({
  sheet,
  filter,
  onClose,
}: {
  sheet: DeliveryWorksheet;
  filter: DeliveryFilter;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null),
    lock = useRef(false);
  const [busy, setBusy] = useState(false),
    [status, setStatus] = useState(""),
    [page, setPage] = useState(0);
  const pageSize = 200;
  useEffect(() => {
    dialog.current?.showModal();
    return () => dialog.current?.close();
  }, []);
  async function perform(kind: "copy" | "download") {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setStatus("");
    try {
      if (kind === "copy") {
        await navigator.clipboard.writeText(deliveryTSV(sheet));
        setStatus("Таблица скопирована");
      } else await downloadDelivery(sheet, filter);
    } catch (e) {
      setStatus(
        e instanceof Error ? e.message : "Не удалось выполнить действие",
      );
    } finally {
      lock.current = false;
      setBusy(false);
    }
  }
  return (
    <dialog
      ref={dialog}
      className="delivery-preview"
      aria-labelledby="delivery-preview-title"
      onCancel={onClose}
    >
      <header>
        <div>
          <h2 id="delivery-preview-title">Предпросмотр доставок</h2>
          <small>
            {filter.startDate} — {filter.endDate} · {sheet.rows.length} заказов
          </small>
        </div>
        <div className="delivery-modal-actions">
          <button
            disabled={busy || !sheet.rows.length}
            onClick={() => void perform("copy")}
          >
            <Copy size={16} />
            Скопировать всё
          </button>
          <button
            disabled={busy || !sheet.rows.length}
            onClick={() => void perform("download")}
          >
            <Download size={16} />
            Excel
          </button>
          <button aria-label="Закрыть предпросмотр" onClick={onClose}>
            <X />
          </button>
        </div>
      </header>
      <p role="status">{status}</p>
      <div className="delivery-preview-scroll">
        <table>
          <thead>
            <tr>
              {sheet.headers.map((h, i) => (
                <th key={i}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sheet.rows
              .slice(page * pageSize, (page + 1) * pageSize)
              .map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j}>{cell}</td>
                  ))}
                </tr>
              ))}
          </tbody>
        </table>
        {sheet.rows.length > pageSize && (
          <nav aria-label="Страницы предпросмотра">
            <button disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
              Назад
            </button>
            <span>
              Строки {page * pageSize + 1}–
              {Math.min((page + 1) * pageSize, sheet.rows.length)} из{" "}
              {sheet.rows.length}
            </span>
            <button
              disabled={(page + 1) * pageSize >= sheet.rows.length}
              onClick={() => setPage((p) => p + 1)}
            >
              Далее
            </button>
          </nav>
        )}
        {!sheet.rows.length && <p>Нет доставок за выбранный период.</p>}
      </div>
    </dialog>
  );
}
