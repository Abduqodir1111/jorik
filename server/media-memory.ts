import fs from "node:fs/promises";
export interface MediaMemorySnapshot {
  supported: boolean;
  hostAvailable?: number;
  limit?: number;
  usage?: number;
  inactiveFile?: number;
}
const value = (text: string, key: string) => {
  const found = text.match(new RegExp("^" + key + "\\s+(\\d+)$", "m"));
  return found ? Number(found[1]) : undefined;
};
const valid = (n: unknown): n is number =>
  typeof n === "number" && Number.isFinite(n) && n >= 0;
export function mediaMemoryReady(
  snapshot: MediaMemorySnapshot,
  hostNeeded: number,
  groupNeeded: number,
) {
  if (!snapshot.supported) return true;
  if (!valid(snapshot.hostAvailable) || snapshot.hostAvailable < hostNeeded)
    return false;
  if (snapshot.limit === undefined) return true;
  if (!valid(snapshot.limit) || !valid(snapshot.usage)) return false;
  // Match Docker's working-set accounting: inactive file cache is reclaimable.
  // Do not subtract active cache, anonymous memory, dirty pages or swap.
  const reclaim =
    valid(snapshot.inactiveFile) && snapshot.inactiveFile <= snapshot.usage
      ? snapshot.inactiveFile
      : 0;
  return snapshot.limit - Math.max(0, snapshot.usage - reclaim) >= groupNeeded;
}
export async function readMediaMemory(
  read: (file: string) => Promise<string> = (file) => fs.readFile(file, "utf8"),
  platform = process.platform,
): Promise<MediaMemorySnapshot> {
  if (platform !== "linux") return { supported: false };
  const snapshot: MediaMemorySnapshot = { supported: true };
  try {
    const text = await read("/proc/meminfo"),
      n = text.match(/^MemAvailable:\s+(\d+)/m);
    if (n) snapshot.hostAvailable = Number(n[1]) * 1024;
  } catch {
    return snapshot;
  }
  let usage: string,
    limit: string,
    stat: string = "";
  try {
    [usage, limit] = await Promise.all([
      read("/sys/fs/cgroup/memory.current"),
      read("/sys/fs/cgroup/memory.max"),
    ]);
    try {
      stat = await read("/sys/fs/cgroup/memory.stat");
    } catch {}
    snapshot.inactiveFile = value(stat, "inactive_file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      return { ...snapshot, limit: 0 };
    try {
      [usage, limit] = await Promise.all([
        read("/sys/fs/cgroup/memory/memory.usage_in_bytes"),
        read("/sys/fs/cgroup/memory/memory.limit_in_bytes"),
      ]);
      try {
        stat = await read("/sys/fs/cgroup/memory/memory.stat");
      } catch {}
      snapshot.inactiveFile =
        value(stat, "total_inactive_file") ?? value(stat, "inactive_file");
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? snapshot
        : { ...snapshot, limit: 0 };
    }
  }
  const used = Number(usage.trim()),
    max = Number(limit.trim());
  snapshot.usage = usage.trim() && valid(used) ? used : undefined;
  if (limit.trim() !== "max" && max < 2 ** 60)
    snapshot.limit = limit.trim() && valid(max) ? max : 0;
  else if (limit.trim() !== "max" && !valid(max)) snapshot.limit = 0;
  return snapshot;
}
