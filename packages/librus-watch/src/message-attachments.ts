import { attachmentObjectPath, sha256Hex, type NewJournalEvent, type NewNotification, type StorageAdapter } from "@automations/librus-data";
import { t, type Language, type Recipient } from "@automations/shared";
import type { Announcement, ChildCheck } from "./engine.ts";
import { formatMessage } from "./format.ts";
import type { MessageAttachmentLink, MessageItem } from "./types.ts";

/** Telegram limit is 50 MB; stay below it. */
export const ATTACHMENT_SIZE_LIMIT = 45 * 1024 * 1024;

const SOURCE = "librus-watch";

export interface AttachmentRunContext {
  check: ChildCheck;
  scope: string;
  /** Returns false when the run must not make another Librus fetch. */
  chargeFetch?: () => boolean;
}

function attachmentStream(childId: string, messageId: string, attachmentId: string): string {
  return `attachment:messages:${childId}:${messageId}:${attachmentId}`;
}

const MIME_BY_SUFFIX: readonly [string, string][] = [
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
];

export function mimeOf(name: string): string {
  const lower = name.toLowerCase();
  for (const [suffix, mime] of MIME_BY_SUFFIX) {
    if (lower.endsWith(suffix)) return mime;
  }
  return "application/octet-stream";
}

function fallbackText(language: Language, name: string): string {
  return t(language, "message.attachment.fallback", { name });
}

function captionText(language: Language, name: string): string {
  return t(language, "message.attachment.caption", { name });
}

function mapNotifications(
  check: ChildCheck,
  scope: string,
  messageId: string,
  suffix: string,
  build: (recipient: Recipient) => Pick<NewNotification, "text" | "kind" | "storagePath" | "fileName">,
): NewNotification[] {
  return check.recipients.map((recipient) => ({
    ...build(recipient),
    key: `${scope}:${messageId}:${suffix}:${recipient.telegram_chat_id}`,
    familyId: check.familyId,
    chatId: recipient.telegram_chat_id,
  }));
}

async function journalForStored(
  check: ChildCheck,
  message: MessageItem,
  link: MessageAttachmentLink,
  path: string,
  sha256: string,
  size: number,
  mimeType: string,
): Promise<NewJournalEvent> {
  const stream = attachmentStream(check.child.id, message.id, link.id);
  return {
    familyId: check.familyId,
    childId: check.child.id,
    stream,
    seq: 1,
    kind: "attachment",
    day: message.sentAt.slice(0, 10) || null,
    eventType: "AttachmentSeen",
    payload: {
      messageId: message.id,
      attachmentId: link.id,
      fileName: link.name,
      size,
      mimeType,
      sha256,
      storagePath: path,
    },
    contentHash: sha256,
    source: SOURCE,
  };
}

function attachmentFallback(check: ChildCheck, scope: string, messageId: string, link: MessageAttachmentLink): NewNotification[] {
  return mapNotifications(check, scope, messageId, `fallback:${link.id}`, (recipient) => ({
    text: fallbackText(recipient.language as Language, link.name),
  }));
}

type StoreResult = {
  path?: string;
  sha256?: string;
  size?: number;
  mimeType?: string;
  journal?: NewJournalEvent;
  fallback?: NewNotification[];
};

async function storeOne(
  ctx: AttachmentRunContext,
  message: MessageItem,
  link: MessageAttachmentLink,
  storage: StorageAdapter,
): Promise<StoreResult> {
  const { check, chargeFetch } = ctx;
  const fallback = (): StoreResult => ({ fallback: attachmentFallback(check, ctx.scope, message.id, link) });
  if (link.size > ATTACHMENT_SIZE_LIMIT || chargeFetch?.() === false) return fallback();
  try {
    const bytes = await check.source.fetchAttachment(link.downloadPath);
    if (bytes.byteLength > ATTACHMENT_SIZE_LIMIT) return fallback();
    const path = attachmentObjectPath(check.familyId, message.id, link.id);
    const mimeType = mimeOf(link.name);
    const sha256 = await sha256Hex(bytes);
    await storage.putAttachment(path, bytes, mimeType);
    return {
      path,
      sha256,
      size: bytes.byteLength,
      mimeType,
      journal: await journalForStored(check, message, link, path, sha256, bytes.byteLength, mimeType),
    };
  } catch {
    return fallback();
  }
}

async function announceOne(
  item: MessageItem,
  ctx: AttachmentRunContext,
): Promise<{ announcement: Announcement; notifications: NewNotification[]; journal: NewJournalEvent[] }> {
  const { check, scope } = ctx;
  const opened = await check.source.openMessage(item.id);
  const announcement: Announcement = {
    key: item.id,
    text: (context) => formatMessage(context, item, opened.body),
    itemId: item.id,
    body: opened.body,
  };
  const notifications: NewNotification[] = [];
  const journal: NewJournalEvent[] = [];
  for (const link of opened.attachments) {
    const stored = await storeOne(ctx, item, link, check.storage);
    if (stored.fallback) {
      notifications.push(...stored.fallback);
      continue;
    }
    if (!stored.path || !stored.journal) continue;
    journal.push(stored.journal);
    notifications.push(
      ...mapNotifications(check, scope, item.id, `doc:${link.id}`, (recipient) => ({
        kind: "document",
        text: captionText(recipient.language as Language, link.name),
        storagePath: stored.path,
        fileName: link.name,
      })),
    );
  }
  return { announcement, notifications, journal };
}

/** Opens each new message, stores attachments and builds Outbox and Journal entries. */
export async function announceMessages(
  changes: { item: MessageItem }[],
  ctx: AttachmentRunContext,
): Promise<{ announcements: Announcement[]; notifications: NewNotification[]; journal: NewJournalEvent[] }> {
  const results = await Promise.all(changes.map(({ item }) => announceOne(item, ctx)));
  return {
    announcements: results.map((result) => result.announcement),
    notifications: results.flatMap((result) => result.notifications),
    journal: results.flatMap((result) => result.journal),
  };
}