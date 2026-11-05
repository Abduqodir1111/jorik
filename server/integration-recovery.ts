// Log classifications only: never stringify provider errors, tokens or message bodies.
const permanentTelegram = new Set([
  "AUTH_KEY_UNREGISTERED",
  "AUTH_KEY_DUPLICATED",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "AUTH_REVOKED",
  "USER_DEACTIVATED",
  "USER_DEACTIVATED_BAN",
  "API_ID_INVALID",
  "SESSION_DECRYPTION_FAILED",
  "LOGIN_REQUIRED",
]);
export function recoveryCode(error: unknown): string {
  const e = error as {
    errorMessage?: unknown;
    code?: unknown;
    graphCode?: unknown;
    message?: unknown;
    name?: unknown;
  };
  if (
    e?.message ===
    "Cannot send requests while disconnected. Please connect first."
  )
    return "DISCONNECTED";
  if (e?.message === "TIMEOUT" || e?.name === "TimeoutError") return "TIMEOUT";
  const value = e?.errorMessage ?? e?.code;
  if (
    typeof value === "string" &&
    (permanentTelegram.has(value) ||
      /^(FLOOD_WAIT|SLOWMODE_WAIT)(?:_\d+)?$/.test(value) ||
      [
        "ECONNRESET",
        "ECONNREFUSED",
        "ETIMEDOUT",
        "ENETUNREACH",
        "EAI_AGAIN",
        "TIMEOUT",
      ].includes(value))
  )
    return value;
  if (typeof e?.graphCode === "number") return `META_${e.graphCode}`;
  return "NETWORK_OR_PROVIDER_ERROR";
}
export function telegramNeedsLogin(error: unknown) {
  return permanentTelegram.has(recoveryCode(error));
}
export function recoveryDelay(attempt: number, cooldownMs = 0) {
  return Math.max(
    Math.min(60000, 5000 * 2 ** Math.min(4, Math.max(0, attempt - 1))),
    cooldownMs,
  );
}
export function logRecovery(
  account: string,
  event: "retry" | "connected" | "requires_login" | "catchup_failed",
  attempt: number,
  error?: unknown,
  delayMs?: number,
) {
  console.info(
    JSON.stringify({
      event: "integration_recovery",
      account,
      action: event,
      attempt,
      code: error ? recoveryCode(error) : undefined,
      delayMs,
    }),
  );
}
