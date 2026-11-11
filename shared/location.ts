/** Keep map-center and selected-point coordinates in Yandex's longitude,latitude order. */
export function yandexLocationUrl(latitude: unknown, longitude: unknown) {
  if (
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  )
    return null;
  const point = `${longitude},${latitude}`;
  const url = new URL("https://yandex.ru/maps/");
  url.search = new URLSearchParams({
    ll: point,
    z: "17",
    mode: "whatshere",
    "whatshere[point]": point,
    "whatshere[zoom]": "17",
  }).toString();
  return url.href;
}
