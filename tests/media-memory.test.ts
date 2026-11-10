import test from "node:test";
import assert from "node:assert/strict";
import { readMediaMemory, mediaMemoryReady } from "../server/media-memory.js";
const MiB = 1024 * 1024;
const reader = (values: Record<string, string>) => async (file: string) => {
  if (file in values) return values[file];
  throw Object.assign(Error("missing"), { code: "ENOENT" });
};
test("Media gate counts reclaimable inactive file cache without ignoring genuine RAM pressure", async () => {
  const values = {
    "/proc/meminfo": "MemAvailable: 262144\n",
    "/sys/fs/cgroup/memory/memory.usage_in_bytes": String(400 * MiB),
    "/sys/fs/cgroup/memory/memory.limit_in_bytes": String(448 * MiB),
    "/sys/fs/cgroup/memory/memory.stat": `cache ${220 * MiB}\ntotal_inactive_file ${180 * MiB}\nactive_file ${40 * MiB}\nrss ${180 * MiB}\n`,
  };
  const snapshot = await readMediaMemory(reader(values), "linux");
  assert.equal(snapshot.inactiveFile, 180 * MiB);
  assert.equal(mediaMemoryReady(snapshot, 180 * MiB, 160 * MiB), true);
  assert.equal(
    mediaMemoryReady({ ...snapshot, inactiveFile: 0 }, 180 * MiB, 160 * MiB),
    false,
  );
  assert.equal(
    mediaMemoryReady({ ...snapshot, hostAvailable: 0 }, 180 * MiB, 160 * MiB),
    false,
  );
  assert.equal(
    mediaMemoryReady(
      { ...snapshot, hostAvailable: 100 * MiB },
      180 * MiB,
      160 * MiB,
    ),
    false,
  );
  assert.equal(
    mediaMemoryReady(
      { ...snapshot, inactiveFile: 900 * MiB },
      180 * MiB,
      160 * MiB,
    ),
    false,
  );
  assert.equal(
    mediaMemoryReady({ ...snapshot, limit: 0 }, 180 * MiB, 160 * MiB),
    false,
  );
});
test("Media gate understands cgroup v2, unlimited groups, unavailable metrics and non-Linux environments", async () => {
  const v2 = {
    "/proc/meminfo": "MemAvailable: 524288\n",
    "/sys/fs/cgroup/memory.current": String(400 * MiB),
    "/sys/fs/cgroup/memory.max": String(448 * MiB),
    "/sys/fs/cgroup/memory.stat": `inactive_file ${200 * MiB}\n`,
  };
  assert.equal(
    mediaMemoryReady(
      await readMediaMemory(reader(v2), "linux"),
      180 * MiB,
      160 * MiB,
    ),
    true,
  );
  assert.equal(
    mediaMemoryReady(
      await readMediaMemory(
        reader({ ...v2, "/sys/fs/cgroup/memory.max": "max" }),
        "linux",
      ),
      180 * MiB,
      160 * MiB,
    ),
    true,
  );
  assert.equal(
    mediaMemoryReady(
      await readMediaMemory(
        reader({ ...v2, "/sys/fs/cgroup/memory.max": "nonsense" }),
        "linux",
      ),
      180 * MiB,
      160 * MiB,
    ),
    false,
  );
  assert.equal(
    mediaMemoryReady(
      await readMediaMemory(reader({}), "linux"),
      180 * MiB,
      160 * MiB,
    ),
    false,
  );
  assert.equal(
    mediaMemoryReady(
      await readMediaMemory(reader({}), "darwin"),
      180 * MiB,
      160 * MiB,
    ),
    true,
  );
});
