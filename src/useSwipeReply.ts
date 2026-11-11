import {
  useEffect,
  useRef,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type { Message } from "../shared/types";
import {
  canSwipeReply,
  replySwipeAxis,
  replySwipeDistance,
  REPLY_SWIPE_THRESHOLD,
  type SwipeAxis,
} from "./swipe-reply-gesture";
import "./swipe-reply.css";

type Gesture = {
  pointer: number;
  x: number;
  y: number;
  axis: SwipeAxis;
  element: HTMLDivElement;
  message: Message;
};
export function useSwipeReply(
  messages: Message[],
  onReply: (m: Message) => void,
  onClaim: () => void,
) {
  const gesture = useRef<Gesture | null>(null),
    settling = useRef<{
      element: HTMLDivElement;
      timer: ReturnType<typeof setTimeout>;
    } | null>(null),
    latest = useRef(messages);
  latest.current = messages;
  function clean(element: HTMLDivElement) {
    element.removeAttribute("data-reply-dragging");
    element.removeAttribute("data-reply-ready");
    element.removeAttribute("data-reply-settling");
    element.style.removeProperty("--reply-swipe-x");
    element.style.removeProperty("--reply-swipe-progress");
    element.parentElement?.classList.remove("is-swiping-reply");
  }
  function clearSettling() {
    if (!settling.current) return;
    clearTimeout(settling.current.timer);
    clean(settling.current.element);
    settling.current = null;
  }
  function reset(animate: boolean) {
    const active = gesture.current;
    gesture.current = null;
    if (!active) return;
    const el = active.element;
    if (animate && active.axis === "reply") {
      el.removeAttribute("data-reply-dragging");
      el.setAttribute("data-reply-settling", "true");
      el.style.setProperty("--reply-swipe-x", "0px");
      el.style.setProperty("--reply-swipe-progress", "0");
      settling.current = {
        element: el,
        timer: setTimeout(() => {
          clean(el);
          settling.current = null;
        }, 200),
      };
    } else clean(el);
    if (el.hasPointerCapture?.(active.pointer))
      el.releasePointerCapture(active.pointer);
  }
  function cancel() {
    reset(false);
    clearSettling();
  }
  useEffect(() => {
    const active = gesture.current;
    if (
      active &&
      !messages.some(
        (m) =>
          m.id === active.message.id &&
          m.conversationId === active.message.conversationId &&
          canSwipeReply(m),
      )
    )
      cancel();
  }, [messages]);
  useEffect(() => {
    const stop = () => cancel();
    const extraTouch = (event: PointerEvent) => {
      if (
        gesture.current &&
        event.pointerType === "touch" &&
        !event.isPrimary
      ) {
        cancel();
        onClaim();
      }
    };
    document.addEventListener("pointerdown", extraTouch, true);
    const hidden = () => {
      if (document.hidden) cancel();
    };
    window.addEventListener("resize", stop);
    window.addEventListener("blur", stop);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      cancel();
      document.removeEventListener("pointerdown", extraTouch, true);
      window.removeEventListener("resize", stop);
      window.removeEventListener("blur", stop);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);
  function start(e: ReactPointerEvent<HTMLDivElement>, message: Message) {
    cancel();
    if (
      e.pointerType !== "touch" ||
      !e.isPrimary ||
      innerWidth >= 768 ||
      !canSwipeReply(message) ||
      e.clientX < 24 ||
      e.clientX > innerWidth - 24 ||
      window.getSelection()?.toString() ||
      (e.target as Element).closest(
        'a,button:not(.photo-preview),input,textarea,select,video,audio,[contenteditable="true"],[role="slider"]',
      )
    )
      return;
    gesture.current = {
      pointer: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      axis: "pending",
      element: e.currentTarget,
      message,
    };
  }
  function move(e: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointer) return;
    if (!e.isPrimary || window.getSelection()?.toString()) {
      cancel();
      return;
    }
    const dx = e.clientX - g.x,
      dy = e.clientY - g.y,
      axis = replySwipeAxis(g.axis, dx, dy);
    if (axis === "cancelled") {
      cancel();
      return;
    }
    if (axis !== "reply") return;
    if (g.axis !== "reply") {
      clearSettling();
      onClaim();
      g.element.parentElement?.classList.add("is-swiping-reply");
      g.element.setAttribute("data-reply-dragging", "true");
      try {
        g.element.setPointerCapture(e.pointerId);
      } catch {
        /* Synthetic/cancelled pointer. */
      }
    }
    g.axis = axis;
    const distance = replySwipeDistance(dx);
    g.element.style.setProperty("--reply-swipe-x", `${-distance}px`);
    g.element.style.setProperty(
      "--reply-swipe-progress",
      String(Math.min(1, distance / REPLY_SWIPE_THRESHOLD)),
    );
    g.element.toggleAttribute(
      "data-reply-ready",
      distance >= REPLY_SWIPE_THRESHOLD,
    );
    if (e.cancelable) e.preventDefault();
  }
  function end(e: ReactPointerEvent<HTMLDivElement>) {
    const g = gesture.current;
    if (!g || e.pointerId !== g.pointer) return;
    const current = latest.current.find(
      (m) =>
        m.id === g.message.id && m.conversationId === g.message.conversationId,
    );
    const reply =
      e.isPrimary &&
      g.axis === "reply" &&
      replySwipeAxis(g.axis, e.clientX - g.x, e.clientY - g.y) === "reply" &&
      replySwipeDistance(e.clientX - g.x) >= REPLY_SWIPE_THRESHOLD &&
      !window.getSelection()?.toString() &&
      current &&
      canSwipeReply(current);
    reset(true);
    // Keep focus in this trusted pointer-up event, so iOS can open the keyboard.
    if (reply) onReply(current);
  }
  return {
    start,
    move,
    end,
    cancel,
    active: () => gesture.current?.axis === "reply",
  };
}
