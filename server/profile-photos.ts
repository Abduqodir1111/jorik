import type { FastifyInstance } from "fastify";
import type { Store } from "./store.js";
import { imageMime } from "./telegram-photos.js";
export function registerProfilePhotos(
  app: FastifyInstance,
  store: Store,
  load: (id: string) => Promise<Buffer | null>,
) {
  const pending = new Map<string, Promise<Buffer | null>>();
  let active = 0;
  const waiting: (() => void)[] = [];
  async function limited(id: string) {
    if (active >= 3) await new Promise<void>((r) => waiting.push(r));
    else active++;
    try {
      return await load(id);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active--;
    }
  }
  app.get<{ Params: { id: string } }>(
    "/api/conversations/:id/avatar",
    async (req, reply) => {
      store.conversation(req.params.id);
      const cached = store.db
        .prepare(
          "SELECT bytes,checked_at FROM profile_photos WHERE conversation_id=?",
        )
        .get(req.params.id) as
        { bytes: Buffer | null; checked_at: number } | undefined;
      let bytes = cached?.bytes;
      if (
        !cached ||
        Date.now() - cached.checked_at > (cached.bytes ? 86400000 : 1800000)
      ) {
        let task = pending.get(req.params.id);
        if (!task) {
          task = (async () => {
            let data: Buffer | null = null;
            try {
              data = await limited(req.params.id);
            } catch {}
            if (data) {
              try {
                if (data.length > 2 * 1024 * 1024) data = null;
                else imageMime(data);
              } catch {
                data = null;
              }
            }
            store.db
              .prepare(
                "INSERT INTO profile_photos VALUES(?,?,?) ON CONFLICT(conversation_id) DO UPDATE SET bytes=excluded.bytes,checked_at=excluded.checked_at",
              )
              .run(req.params.id, data, Date.now());
            return data;
          })();
          pending.set(req.params.id, task);
        }
        try {
          bytes = await task;
        } finally {
          pending.delete(req.params.id);
        }
      }
      if (!bytes)
        return reply.code(404).send({ error: "Фото профиля недоступно" });
      return reply
        .header("Cache-Control", "private, max-age=3600")
        .type(imageMime(bytes)!)
        .send(bytes);
    },
  );
}
