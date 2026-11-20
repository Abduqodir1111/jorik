import { useEffect, useRef, type PointerEvent } from "react";

// Leave native vertical scrolling to the browser; pointercancel cancels the hold.
export function useChatLongPress(onHold: () => void) {
  const callback = useRef(onHold);
  callback.current = onHold;
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const start = useRef<{ id: number; x: number; y: number } | null>(null);
  const suppressClick = useRef(false);
  function cancel() {
    clearTimeout(timer.current);
    timer.current = undefined;
    start.current = null;
  }
  useEffect(() => {
    window.addEventListener("blur", cancel);
    window.addEventListener("scroll", cancel, true);
    return () => {
      cancel();
      window.removeEventListener("blur", cancel);
      window.removeEventListener("scroll", cancel, true);
    };
  }, []);
  return {
    onPointerDown(e: PointerEvent) {
      cancel();
      suppressClick.current = false;
      if (
        !e.isPrimary ||
        e.button !== 0 ||
        e.pointerType === "mouse" ||
        !window.matchMedia("(max-width: 767px)").matches
      )
        return;
      start.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        timer.current = undefined;
        suppressClick.current = true;
        callback.current();
      }, 500);
    },
    onPointerMove(e: PointerEvent) {
      const origin = start.current;
      if (
        origin &&
        (origin.id !== e.pointerId ||
          Math.hypot(e.clientX - origin.x, e.clientY - origin.y) > 10)
      )
        cancel();
    },
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu(e: React.MouseEvent) {
      if (window.matchMedia("(max-width: 767px)").matches) e.preventDefault();
    },
    consumeClick() {
      const consumed = suppressClick.current;
      suppressClick.current = false;
      return consumed;
    },
  };
}
