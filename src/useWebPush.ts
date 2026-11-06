import { useEffect, useState } from "react";
let registration: Promise<ServiceWorkerRegistration> | undefined;
export function registerPushWorker() {
  if (!window.isSecureContext || !("serviceWorker" in navigator)) return;
  return (registration ??= navigator.serviceWorker
    .register("/sw.js", { updateViaCache: "none" })
    .then(() => navigator.serviceWorker.ready)
    .catch((e) => {
      registration = undefined;
      throw e;
    }));
}
async function pushApi(url: string, method = "GET", body?: unknown) {
  const r = await fetch("/api/push/" + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json();
  if (!r.ok) throw Error(data.error || "Не удалось сохранить подписку");
  return data;
}
function serverKey(value: string) {
  return Uint8Array.from(
    atob(value.replace(/-/g, "+").replace(/_/g, "/")),
    (c) => c.charCodeAt(0),
  );
}
export function useWebPush() {
  const ios =
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone;
  const needsInstall = ios && !standalone;
  const supported =
    window.isSecureContext &&
    "Notification" in window &&
    "serviceWorker" in navigator &&
    "PushManager" in window;
  const [ready, setReady] = useState(false),
    [enabled, setEnabled] = useState(false),
    [busy, setBusy] = useState(false),
    [status, setStatus] = useState("");
  useEffect(() => {
    if (!supported || needsInstall) return;
    let active = true;
    Promise.all([registerPushWorker(), pushApi("config")])
      .then(async ([reg]) => {
        const sub = await reg?.pushManager.getSubscription();
        if (sub && Notification.permission === "granted")
          await pushApi("subscriptions", "POST", sub.toJSON());
        if (active) {
          setEnabled(!!sub && Notification.permission === "granted");
          setReady(true);
        }
      })
      .catch(() => {
        if (active)
          setStatus(
            "Не удалось подготовить уведомления. Откройте настройки ещё раз.",
          );
      });
    return () => {
      active = false;
    };
  }, [supported, needsInstall]);
  async function enable() {
    if (busy || !ready) return;
    // Must run synchronously inside the tap handler, before fetch/await (iOS).
    const permission = Notification.requestPermission();
    setBusy(true);
    setStatus("");
    try {
      if ((await permission) !== "granted")
        throw Error(
          "Уведомления не разрешены. Доступ можно изменить в настройках браузера или iPhone.",
        );
      const [{ publicKey }, reg] = await Promise.all([
        pushApi("config"),
        registerPushWorker(),
      ]);
      if (!reg) throw Error("Service Worker недоступен");
      let sub = await reg.pushManager.getSubscription();
      const key = serverKey(publicKey);
      if (
        sub &&
        sub.options.applicationServerKey &&
        Array.from(new Uint8Array(sub.options.applicationServerKey)).join() !==
          Array.from(key).join()
      ) {
        await sub.unsubscribe();
        sub = null;
      }
      sub ??= await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: key,
      });
      await pushApi("subscriptions", "POST", sub.toJSON());
      setEnabled(true);
      setStatus("Уведомления включены на этом устройстве.");
    } catch (e) {
      setStatus(
        e instanceof Error ? e.message : "Не удалось включить уведомления",
      );
    } finally {
      setBusy(false);
    }
  }
  async function disable() {
    setBusy(true);
    setStatus("");
    try {
      const sub = await (
        await registerPushWorker()
      )?.pushManager.getSubscription();
      if (sub) {
        await pushApi("subscriptions", "DELETE", { endpoint: sub.endpoint });
        await sub.unsubscribe();
      }
      setEnabled(false);
      setStatus("Уведомления отключены на этом устройстве.");
    } catch {
      setStatus("Не удалось отключить уведомления. Повторите попытку.");
    } finally {
      setBusy(false);
    }
  }
  return {
    enabled,
    busy,
    ready,
    status,
    enable,
    disable,
    hint: needsInstall
      ? "На iPhone/iPad с iOS 16.4+ добавьте Jorik на экран «Домой» через меню «Поделиться» и откройте его по иконке."
      : !supported
        ? "Push-уведомления недоступны в этом браузере. Нужны HTTPS и поддержка Web Push."
        : "",
  };
}
