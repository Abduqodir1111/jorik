export default function PlatformIcon({
  platform,
}: {
  platform: "telegram" | "instagram";
}) {
  if (platform === "instagram")
    return (
      <svg
        className="platform-icon"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        aria-hidden="true"
      >
        <rect x="3" y="3" width="18" height="18" rx="5" />
        <circle cx="12" cy="12" r="4" />
        <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
      </svg>
    );
  return (
    <svg
      className="platform-icon"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M21.9 3.7 18.6 20c-.2 1.2-.9 1.5-1.9.9l-5-3.7-2.4 2.3c-.3.3-.5.5-1 .5l.4-5.1L18 6.5c.4-.4-.1-.6-.6-.3L5.8 13.5l-5-1.6c-1.1-.4-1.1-1.1.2-1.6L20.5 2.8c.9-.3 1.7.2 1.4.9Z" />
    </svg>
  );
}
