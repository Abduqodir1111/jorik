export type Mode = "demo" | "real";
export type Status = "queued" | "sending" | "sent" | "error" | "unknown";
export interface Capabilities {
  text: boolean;
  images: boolean;
  files: boolean;
  voice: boolean;
  history: boolean;
  readReceipts: boolean;
  replyWindowSeconds: number | null;
  idempotency: boolean;
}
export interface Account {
  recentImport?: {
    state: "idle" | "running" | "complete" | "error";
    imported: number;
    error?: string;
  };
  receiveMode?: "polling" | "webhook";
  webhookConfigured?: boolean;
  color: string;
  id: string;
  name: string;
  platform: "telegram" | "instagram";
  adapter: string;
  mode: Mode;
  state: "connected" | "offline" | "unconfigured";
  lastSync: string | null;
  error: string | null;
  capabilities: Capabilities;
}
export interface Conversation {
  lastIncomingAt?: string | null;
  needsReply?: boolean;
  stage?: "" | "new" | "paid" | "waiting";
  id: string;
  accountId: string;
  externalId: string;
  name: string;
  username: string;
  unread: number;
  updatedAt: string;
  preview: string;
  draft: string;
}
export interface Attachment {
  latitude?: number;
  longitude?: number;
  duration?: number;
  kind: "image" | "video" | "file" | "voice" | "sticker" | "location";
  url: string;
  name: string;
  mime: string;
  size: number;
}
export interface Message {
  editedAt?: string | null;
  reactions?: { emoji: string; count: number; chosen: boolean }[];
  replyToId?: string | null;
  reply_to?: { sender_name: string; text: string; message_id?: string };
  readAt?: string | null;
  id: string;
  conversationId: string;
  externalId: string | null;
  direction: "in" | "out";
  text: string;
  status: Status;
  createdAt: string;
  error: string | null;
  attachments: Attachment[];
}
