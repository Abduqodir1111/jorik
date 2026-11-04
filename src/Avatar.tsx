import { useState } from "react";
export default function Avatar({
  name,
  index = 0,
  conversationId,
}: {
  name: string;
  index?: number;
  conversationId?: string;
}) {
  const [failed, setFailed] = useState("");
  const src = conversationId
    ? `/api/conversations/${conversationId}/avatar`
    : "";
  return (
    <span className={"avatar color" + (index % 5)}>
      {src && failed !== src ? (
        <img
          src={src}
          loading="lazy"
          decoding="async"
          alt=""
          onError={() => setFailed(src)}
        />
      ) : (
        name
          .split(" ")
          .map((s) => Array.from(s)[0])
          .slice(0, 2)
          .join("")
      )}
    </span>
  );
}
