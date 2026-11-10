type Intent = { entry: string; conversation: string; key: string };
let volatile: Intent[] = [];
const storageKey = "jorik-video-intents-v1";
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
function read(storage?: Storage): Intent[] {
  try {
    const rows = JSON.parse(storage?.getItem(storageKey) || "[]");
    return Array.isArray(rows)
      ? rows
          .filter(
            (i) =>
              i &&
              /^[a-f0-9]{24}$/.test(i.entry) &&
              uuid.test(i.conversation) &&
              uuid.test(i.key),
          )
          .slice(-20)
      : [];
  } catch {
    return [];
  }
}
function browserStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return undefined;
  }
}
export function videoIntent(
  entry: string,
  conversation: string,
  storage = browserStorage(),
): Intent {
  const rows = read(storage),
    old =
      rows.find((i) => i.entry === entry && i.conversation === conversation) ||
      volatile.find(
        (i) => i.entry === entry && i.conversation === conversation,
      );
  if (old) return old;
  const intent = { entry, conversation, key: crypto.randomUUID() };
  volatile = [...volatile, intent].slice(-20);
  try {
    storage?.setItem(storageKey, JSON.stringify([...rows, intent].slice(-20)));
  } catch {}
  return intent;
}
export function confirmVideoIntent(key: string, storage = browserStorage()) {
  volatile = volatile.filter((i) => i.key !== key);
  try {
    storage?.setItem(
      storageKey,
      JSON.stringify(read(storage).filter((i) => i.key !== key)),
    );
  } catch {}
}
