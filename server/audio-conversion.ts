import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
const run = promisify(execFile);
// Callers serialize conversion; fixed local paths only, no URLs or user arguments.
export async function compatibleAudio(
  source: string,
  target: string,
): Promise<Buffer> {
  try {
    return await fs.readFile(target);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const temp = target + "." + randomUUID() + ".m4a";
  try {
    await run(
      "ffmpeg",
      [
        "-nostdin",
        "-v",
        "error",
        "-protocol_whitelist",
        "file,pipe",
        "-i",
        source,
        "-map_metadata",
        "-1",
        "-vn",
        "-t",
        "1800",
        "-ac",
        "1",
        "-c:a",
        "aac",
        "-b:a",
        "64k",
        "-movflags",
        "+faststart",
        temp,
      ],
      { timeout: 90000, maxBuffer: 65536 },
    );
    await fs.chmod(temp, 0o600);
    const bytes = await fs.readFile(temp);
    if (bytes.length > 20 * 1024 * 1024)
      throw new Error("Аудио слишком большое");
    await fs.rename(temp, target);
    return bytes;
  } catch {
    throw new Error(
      "Не удалось подготовить аудио для Safari. Повторите загрузку или откройте Telegram.",
    );
  } finally {
    await fs.rm(temp, { force: true });
  }
}
