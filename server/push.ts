import * as webpush from "web-push";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import type { DB } from "./db.js";
import { hashToken } from "./auth.js";

export type IncomingNotification = {
  conversationId: string;
  messageId: string;
};
export type PushOptions = {
  publicKey?: string;
  privateKey?: string;
  subject?: string;
};
const subscriptionSchema = z.object({
  endpoint: z.string().url().max(2048).refine(validPushEndpoint),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: z.string().regex(/^[A-Za-z0-9_-]{87}$/),
    auth: z.string().regex(/^[A-Za-z0-9_-]{22}$/),
  }),
});
// Subscription endpoints are supplied by clients: never let them become an SSRF proxy.
export function validPushEndpoint(value: string) {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      !u.username &&
      !u.password &&
      !u.port &&
      (u.hostname === "fcm.googleapis.com" ||
        u.hostname === "updates.push.services.mozilla.com" ||
        u.hostname.endsWith(".push.services.mozilla.com") ||
        u.hostname.endsWith(".push.apple.com") ||
        u.hostname.endsWith(".notify.windows.com"))
    );
  } catch {
    return false;
  }
}
export function loadVapid(dataDir: string, options: PushOptions = {}) {
  if (options.publicKey || options.privateKey) {
    if (!options.publicKey || !options.privateKey)
      throw Error("Both VAPID keys are required");
    return { publicKey: options.publicKey, privateKey: options.privateKey };
  }
  const file = path.join(dataDir, "vapid.json");
  try {
    const keys = webpush.generateVAPIDKeys();
    fs.writeFileSync(file, JSON.stringify(keys), { mode: 0o600, flag: "wx" });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  fs.chmodSync(file, 0o600);
  return JSON.parse(fs.readFileSync(file, "utf8")) as {
    publicKey: string;
    privateKey: string;
  };
}
export class PushService {
  private active?: Promise<void>;
  private closed = false;
  constructor(
    private db: DB,
    private keys: { publicKey: string; privateKey: string },
    private subject: string,
    private sender: typeof webpush.sendNotification = webpush.sendNotification,
  ) {}
  enqueue({ conversationId, messageId }: IncomingNotification) {
    if (this.closed) return;
    const message = this.db
      .prepare(
        "SELECT 1 FROM messages WHERE id=? AND conversation_id=? AND direction='in'",
      )
      .get(messageId, conversationId);
    if (!message) return;
    this.db
      .prepare(
        `INSERT OR IGNORE INTO push_jobs(message_id,endpoint,next_attempt)
      SELECT ?,p.endpoint,? FROM push_subscriptions p JOIN sessions s ON s.token_hash=p.session_hash WHERE s.expires_at>?`,
      )
      .run(messageId, Date.now(), Date.now());
  }
  flush() {
    if (this.closed) return Promise.resolve();
    if (this.active) return this.active;
    this.active = this.deliver().finally(() => {
      this.active = undefined;
    });
    return this.active;
  }
  private async deliver() {
    this.db
      .prepare(
        "DELETE FROM push_subscriptions WHERE session_hash NOT IN (SELECT token_hash FROM sessions WHERE expires_at>?)",
      )
      .run(Date.now());
    const jobs = this.db
      .prepare(
        `SELECT j.message_id,j.endpoint,j.attempts,p.subscription,c.id AS conversationId,
      c.name,c.username,a.name AS accountName,m.text FROM push_jobs j
      JOIN push_subscriptions p ON p.endpoint=j.endpoint JOIN messages m ON m.id=j.message_id
      JOIN conversations c ON c.id=m.conversation_id JOIN accounts a ON a.id=c.account_id
      WHERE j.next_attempt<=? ORDER BY j.next_attempt LIMIT 10`,
      )
      .all(Date.now()) as Array<{
      message_id: string;
      endpoint: string;
      attempts: number;
      subscription: string;
      conversationId: string;
      name: string;
      username: string;
      accountName: string;
      text: string;
    }>;
    // Two requests at a time keeps memory bounded on the NAS.
    for (let i = 0; i < jobs.length && !this.closed; i += 2)
      await Promise.all(
        jobs.slice(i, i + 2).map(async (job) => {
          try {
            await this.sender(
              JSON.parse(job.subscription),
              JSON.stringify({
                title: `${job.username || job.name} · ${job.accountName}`.slice(
                  0,
                  120,
                ),
                body: job.text.slice(0, 180) || "Новое вложение",
                tag: `message-${job.message_id}`,
                url: `/?conversation=${encodeURIComponent(job.conversationId)}`,
              }),
              {
                vapidDetails: { subject: this.subject, ...this.keys },
                TTL: 3600,
                timeout: 10000,
                urgency: "normal",
              },
            );
            this.db
              .prepare(
                "DELETE FROM push_jobs WHERE message_id=? AND endpoint=?",
              )
              .run(job.message_id, job.endpoint);
          } catch (e) {
            const status = (e as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410)
              this.db
                .prepare("DELETE FROM push_subscriptions WHERE endpoint=?")
                .run(job.endpoint);
            else if (
              job.attempts >= 2 ||
              (status && status >= 400 && status < 500 && status !== 429)
            )
              this.db
                .prepare(
                  "DELETE FROM push_jobs WHERE message_id=? AND endpoint=?",
                )
                .run(job.message_id, job.endpoint);
            else
              this.db
                .prepare(
                  "UPDATE push_jobs SET attempts=attempts+1,next_attempt=? WHERE message_id=? AND endpoint=?",
                )
                .run(
                  Date.now() + 30000 * (job.attempts + 1),
                  job.message_id,
                  job.endpoint,
                );
            console.warn("Web Push delivery failed", status || "network");
          }
        }),
      );
  }
  async close() {
    this.closed = true;
    await this.active;
  }
  register(app: FastifyInstance) {
    // Jorik currently has one owner account. Bind every device to its authenticated
    // session; never accept owner/user IDs from the request body.
    app.get("/api/push/config", async () => ({
      publicKey: this.keys.publicKey,
    }));
    app.post("/api/push/subscriptions", async (req) => {
      const sub = subscriptionSchema.parse(req.body);
      this.db
        .prepare(
          `INSERT INTO push_subscriptions(endpoint,session_hash,subscription,updated_at) VALUES(?,?,?,?)
        ON CONFLICT(endpoint) DO UPDATE SET session_hash=excluded.session_hash,subscription=excluded.subscription,updated_at=excluded.updated_at`,
        )
        .run(
          sub.endpoint,
          hashToken(req.cookies.session ?? ""),
          JSON.stringify(sub),
          Date.now(),
        );
      return { ok: true };
    });
    app.delete("/api/push/subscriptions", async (req) => {
      const { endpoint } = z
        .object({ endpoint: z.string().max(2048) })
        .parse(req.body);
      this.db
        .prepare(
          "DELETE FROM push_subscriptions WHERE endpoint=? AND session_hash=?",
        )
        .run(endpoint, hashToken(req.cookies.session ?? ""));
      return { ok: true };
    });
  }
}
