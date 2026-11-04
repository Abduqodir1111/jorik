import { useLayoutEffect, useRef } from "react";
import {
  nationalPhoneMask,
  phoneCaret,
  uzPhoneDigits,
} from "../shared/order-form";

export default function OrderPhone({
  value,
  onChange,
  invalid,
  onBlur,
}: {
  value: string;
  onChange: (value: string) => void;
  invalid: boolean;
  onBlur: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const caret = useRef<number | null>(null);
  const mask = nationalPhoneMask(value.slice(4));
  useLayoutEffect(() => {
    if (caret.current !== null && document.activeElement === input.current) {
      const position = phoneCaret(mask, caret.current);
      input.current?.setSelectionRange(position, position);
      caret.current = null;
    }
  }, [mask]);
  return (
    <div className={"order-phone compact-phone " + (invalid ? "invalid" : "")}>
      <span aria-hidden="true">+998</span>
      <input
        ref={input}
        type="tel"
        aria-label="Телефон — 9 цифр"
        aria-invalid={invalid}
        aria-describedby={invalid ? "order-phone-error" : undefined}
        inputMode="tel"
        autoComplete="tel-national"
        placeholder="(90) 123-45-67"
        value={mask}
        onBlur={onBlur}
        onPaste={(e) => {
          e.preventDefault();
          const digits = uzPhoneDigits(e.clipboardData.getData("text"));
          caret.current = digits.length;
          onChange("+998" + digits);
        }}
        onKeyDown={(e) => {
          const el = e.currentTarget,
            start = el.selectionStart ?? 0,
            end = el.selectionEnd ?? start;
          if (start !== end || !["Backspace", "Delete"].includes(e.key)) return;
          const position = e.key === "Backspace" ? start - 1 : start;
          if (
            position < 0 ||
            position >= mask.length ||
            /\d/.test(mask[position])
          )
            return;
          const before = mask.slice(0, start).replace(/\D/g, "").length;
          const index = e.key === "Backspace" ? before - 1 : before;
          if (index < 0) return;
          e.preventDefault();
          const digits = uzPhoneDigits(value.slice(4));
          caret.current = index;
          onChange("+998" + digits.slice(0, index) + digits.slice(index + 1));
        }}
        onChange={(e) => {
          caret.current = e.currentTarget.value
            .slice(0, e.currentTarget.selectionStart ?? 0)
            .replace(/\D/g, "").length;
          onChange("+998" + uzPhoneDigits(e.target.value));
        }}
      />
    </div>
  );
}
