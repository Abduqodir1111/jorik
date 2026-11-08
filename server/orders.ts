import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { districts, manualSources, type Order } from "../shared/orders.js";
import type { Store } from "./store.js";
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(s + "T12:00:00Z");
    return Number.isFinite(+d) && d.toISOString().slice(0, 10) === s;
  }, "Укажите существующую дату");
const schema = z
  .object({
    conversationId: z.string().uuid().nullable(),
    client: z.string().trim().min(1).max(160),
    source: z.string().trim().min(1).max(100),
    date,
    phone: z.string().regex(/^\+998\d{9}$/, "Введите 9 цифр после +998"),
    additionalPhone: z
      .union([
        z.literal(""),
        z
          .string()
          .regex(/^\+998\d{9}$/, "Введите 9 цифр дополнительного номера"),
      ])
      .optional()
      .transform((value) => value || undefined),
    deliveryType: z.enum(["delivery", "pickup", "mail"]),
    district: z.string().max(50),
    address: z.string().trim().max(2000),
    coordinates: z.string().trim().max(2000),
    amount: z.number().finite().positive().max(1e12),
    isPaid: z.boolean(),
    items: z.string().trim().min(1).max(10000),
  })
  .strict()
  .refine(
    (o) =>
      o.deliveryType !== "delivery" || districts.some((d) => d === o.district),
    { message: "Выберите район доставки", path: ["district"] },
  );
type Row = {
  id: string;
  data: string;
  refused: number;
  created_at: string;
  updated_at: string;
};
const decode = (r: Row): Order => ({
  ...JSON.parse(r.data),
  id: r.id,
  refused: !!r.refused,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
export function registerOrders(app: FastifyInstance, store: Store) {
  const db = store.db;
  const get = (id: string) => {
    const r = db.prepare("SELECT * FROM orders WHERE id=?").get(id) as
      Row | undefined;
    if (!r)
      throw Object.assign(new Error("Заказ не найден"), { statusCode: 404 });
    return decode(r);
  };
  const validate = (body: unknown, existing?: Order) => {
    const o = schema.parse(body);
    if (
      existing &&
      (o.conversationId !== existing.conversationId ||
        (existing.conversationId &&
          (o.client !== existing.client || o.source !== existing.source)))
    )
      throw new Error("Клиент и источник заказа из чата не изменяются");
    if (o.conversationId && !existing) {
      const c = store.conversation(o.conversationId),
        a = store.account(c.accountId);
      o.client = c.username || c.name;
      o.source = a.name;
    } else if (!o.conversationId && !manualSources.some((s) => s === o.source))
      throw new Error("Неверный источник ручного заказа");
    if (o.deliveryType !== "delivery") {
      o.district = "";
      o.address = "";
      o.coordinates = "";
    }
    return o;
  };
  app.get<{ Querystring: { phone?: string } }>("/api/orders", async (req) => {
    const phone = req.query.phone;
    if (phone)
      z.string()
        .regex(/^\+998\d{9}$/)
        .parse(phone);
    return (
      phone
        ? db
            .prepare(
              "SELECT * FROM orders WHERE phone=? ORDER BY date DESC,created_at DESC",
            )
            .all(phone)
        : db
            .prepare("SELECT * FROM orders ORDER BY date DESC,created_at DESC")
            .all()
    ).map((r) => decode(r as Row));
  });
  app.get("/api/orders/export", async (req, reply) => {
    const filter = z
      .object({
        startDate: date,
        endDate: date,
        source: z.enum(["ALL", "STOREBOOKS", "MANGASTORE"]).default("ALL"),
      })
      .strict()
      .refine((f) => f.startDate <= f.endDate, "Начало периода позже окончания")
      .parse(req.query);
    const params: string[] = [filter.startDate, filter.endDate];
    const source =
      filter.source === "ALL"
        ? ""
        : " AND upper(trim(json_extract(data,'$.source')))=?";
    if (source) params.push(filter.source);
    const rows = db
      .prepare(
        "SELECT * FROM orders WHERE date>=? AND date<=? AND refused=0 AND json_extract(data,'$.deliveryType') IN ('delivery','mail')" +
          source +
          " ORDER BY date DESC,created_at DESC LIMIT 10001",
      )
      .all(...params) as Row[];
    if (rows.length > 10000)
      return reply.code(400).send({
        error: "В отчёте больше 10 000 заказов. Выберите меньший период.",
      });
    return rows.map(decode);
  });
  app.post("/api/orders", async (req, reply) => {
    const o = validate(req.body),
      id = randomUUID(),
      now = new Date().toISOString();
    db.prepare(
      "INSERT INTO orders(id,date,phone,data,created_at,updated_at) VALUES(?,?,?,?,?,?)",
    ).run(id, o.date, o.phone, JSON.stringify(o), now, now);
    store.ordersChanged();
    reply.code(201);
    return get(id);
  });
  app.put<{ Params: { id: string } }>("/api/orders/:id", async (req) => {
    const o = validate(req.body, get(req.params.id));
    db.prepare(
      "UPDATE orders SET date=?,phone=?,data=?,updated_at=? WHERE id=?",
    ).run(
      o.date,
      o.phone,
      JSON.stringify(o),
      new Date().toISOString(),
      req.params.id,
    );
    store.ordersChanged();
    return get(req.params.id);
  });
  app.patch<{ Params: { id: string } }>(
    "/api/orders/:id/refused",
    async (req) => {
      get(req.params.id);
      const { refused } = z
        .object({ refused: z.boolean() })
        .strict()
        .parse(req.body);
      db.prepare("UPDATE orders SET refused=?,updated_at=? WHERE id=?").run(
        refused ? 1 : 0,
        new Date().toISOString(),
        req.params.id,
      );
      store.ordersChanged();
      return get(req.params.id);
    },
  );
  app.delete<{ Params: { id: string } }>("/api/orders/:id", async (req) => {
    get(req.params.id);
    db.prepare("DELETE FROM orders WHERE id=?").run(req.params.id);
    store.ordersChanged();
    return { ok: true };
  });
}
