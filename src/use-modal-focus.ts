import { useEffect, useRef, type RefObject } from "react";

/** Close before unmounting so native dialogs can release their modal focus. */
export function useModalFocus(dialog: RefObject<HTMLDialogElement | null>) {
  const pending = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (pending.current !== undefined) cancelAnimationFrame(pending.current);
    const origin = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    return () => {
      element?.close();
      pending.current = requestAnimationFrame(() => {
        if (origin instanceof HTMLElement && origin.isConnected) {
          origin.focus({ preventScroll: true });
        }
      });
    };
  }, [dialog]);
}
