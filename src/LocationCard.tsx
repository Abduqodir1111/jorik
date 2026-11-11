import { yandexLocationUrl } from "../shared/location";
import { MapPin } from "lucide-react";
import type { Attachment } from "../shared/types";
export default function LocationCard({
  attachment: a,
}: {
  attachment: Attachment;
}) {
  const lat = a.latitude,
    lon = a.longitude;
  const href = yandexLocationUrl(lat, lon);
  if (!href) return <span>Геолокация недоступна</span>;
  return (
    <a
      className="location-card"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
    >
      <MapPin size={28} />
      <span>
        <strong>{a.name || "Геолокация"}</strong>
        {a.address && <small>{a.address}</small>}
        <small>
          {lat!.toFixed(5)}, {lon!.toFixed(5)} · Открыть карту ↗
        </small>
      </span>
    </a>
  );
}
