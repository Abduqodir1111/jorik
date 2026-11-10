import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import bigInt from "big-integer";
import { Api, type TelegramClient } from "teleproto";
// Avoid the SDK small-file MD5 path, which reads a whole file into memory.
export async function uploadArchiveTelegram(
  client: Pick<TelegramClient, "invoke">,
  file: string,
  size: number,
  progress?: (bytes: number, total: number) => void,
) {
  if (size <= 0 || size > 18 * 1024 * 1024 || (await stat(file)).size !== size)
    throw new Error("Размер видео изменился");
  const fileId = bigInt(randomBytes(8).readBigInt64LE().toString());
  const parts = Math.ceil(size / (512 * 1024)),
    big = size > 10 * 1024 * 1024,
    hash = createHash("md5");
  let part = 0,
    bytes = 0;
  for await (const chunk of createReadStream(file, {
    highWaterMark: 512 * 1024,
  })) {
    bytes += chunk.length;
    if (bytes > size) throw new Error("Видео изменилось при загрузке");
    hash.update(chunk);
    const ok = await client.invoke(
      big
        ? new Api.upload.SaveBigFilePart({
            fileId,
            filePart: part,
            fileTotalParts: parts,
            bytes: chunk,
          })
        : new Api.upload.SaveFilePart({ fileId, filePart: part, bytes: chunk }),
    );
    if (!ok) throw new Error("Telegram не подтвердил часть видео");
    part++;
    try {
      progress?.(bytes, size);
    } catch {
      /* Telemetry must not interrupt an upload. */
    }
  }
  if (bytes !== size || part !== parts)
    throw new Error("Видео изменилось при загрузке");
  return big
    ? new Api.InputFileBig({ id: fileId, parts, name: "review.mp4" })
    : new Api.InputFile({
        id: fileId,
        parts,
        name: "review.mp4",
        md5Checksum: hash.digest("hex"),
      });
}
