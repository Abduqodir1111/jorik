import { MapPin } from "lucide-react";
import type { Attachment } from "../shared/types";
export default function LocationCard({
  attachment: a,
}: {
  attachment: Attachment;
}) {
  const lat = a.latitude,
    lon = a.longitude;
  if (
    typeof lat !== "number" ||
    typeof lon !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    Math.abs(lat) > 90 ||
    Math.abs(lon) > 180
  )
    return <span>Геолокация недоступна</span>;
  return (
    <a
      className="location-card"
      href={`https://yandex.ru/maps/?pt=${lon},${lat}&z=17&l=map`}
      target="_blank"
      rel="noopener noreferrer"
    >
      <MapPin size={28} />
      <span>
        <strong>{a.name || "Геолокация"}</strong>
        <small>
          {lat.toFixed(5)}, {lon.toFixed(5)} · Открыть карту ↗
        </small>
      </span>
    </a>
  );
}
