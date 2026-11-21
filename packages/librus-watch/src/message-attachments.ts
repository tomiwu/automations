import { attachmentObjectPath, sha256Hex, type NewJournalEvent, type NewNotification, type StorageAdapter } from "@automations/librus-data";
import { t, type Language, type Recipient } from "@automations/shared";
import type { Announcement, ChildCheck } from "./engine.ts";
import { formatMessage } from "./format.ts";
import type { MessageAttachmentLink, MessageItem, OpenedMessage } from "./types.ts";

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

function journalForStored(
  check: ChildCheck,
  message: MessageItem,
  link: MessageAttachmentLink,
  path: string,
  sha256: string,
  size: number,
  mimeType: string,
): NewJournalEvent {
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

type StoreResult = { stored: true; path: string; journal: NewJournalEvent } | { stored: false; fallback: NewNotification[] };

async function storeOne(
  ctx: AttachmentRunContext,
  message: MessageItem,
  link: MessageAttachmentLink,
  storage: StorageAdapter,
): Promise<StoreResult> {
  const { check, chargeFetch } = ctx;
  const fallback = (): StoreResult => ({ stored: false, fallback: attachmentFallback(check, ctx.scope, message.id, link) });
  if (link.size > ATTACHMENT_SIZE_LIMIT || chargeFetch?.() === false) return fallback();
  try {
    const bytes = await check.source.fetchAttachment(link.downloadPath);
    if (bytes.byteLength > ATTACHMENT_SIZE_LIMIT) return fallback();
    const path = attachmentObjectPath(check.familyId, message.id, link.id);
    const mimeType = mimeOf(link.name);
    const sha256 = await sha256Hex(bytes);
    await storage.putAttachment(path, bytes, mimeType);
    return { stored: true, path, journal: journalForStored(check, message, link, path, sha256, bytes.byteLength, mimeType) };
  } catch {
    return fallback();
  }
}

/** Counts for the log. Never names, paths or contents. */
interface AttachmentCounts {
  found: number;
  stored: number;
  fallback: number;
  unrecognized: number;
}

function unrecognizedNote(check: ChildCheck, scope: string, messageId: string): NewNotification[] {
  return mapNotifications(check, scope, messageId, "attachments-unrecognized", (recipient) => ({
    text: t(recipient.language as Language, "message.attachment.unrecognized"),
  }));
}

/** Stores the files of one opened message. It never throws: a failure becomes the "open in Librus" text. */
async function attachmentsOf(
  item: MessageItem,
  opened: OpenedMessage,
  ctx: AttachmentRunContext,
  counts: AttachmentCounts,
): Promise<{ notifications: NewNotification[]; journal: NewJournalEvent[] }> {
  const { check, scope } = ctx;
  const notifications: NewNotification[] = [];
  const journal: NewJournalEvent[] = [];
  if (opened.unrecognizedAttachments > 0) {
    counts.unrecognized += 1;
    notifications.push(...unrecognizedNote(check, scope, item.id));
  }
  for (const link of opened.attachments) {
    counts.found += 1;
    const stored = await storeOne(ctx, item, link, check.storage);
    if (!stored.stored) {
      counts.fallback += 1;
      notifications.push(...stored.fallback);
      continue;
    }
    counts.stored += 1;
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
  return { notifications, journal };
}

async function announceOne(
  item: MessageItem,
  ctx: AttachmentRunContext,
  counts: AttachmentCounts,
): Promise<{ announcement: Announcement; notifications: NewNotification[]; journal: NewJournalEvent[] }> {
  const opened = await ctx.check.source.openMessage(item.id);
  const announcement: Announcement = {
    key: item.id,
    text: (context) => formatMessage(context, item, opened.body),
    itemId: item.id,
    body: opened.body,
  };
  try {
    return { announcement, ...(await attachmentsOf(item, opened, ctx, counts)) };
  } catch {
    counts.unrecognized += 1;
    return { announcement, notifications: unrecognizedNote(ctx.check, ctx.scope, item.id), journal: [] };
  }
}

/**
 * Opens each new message one after another, stores its attachments and builds the Outbox and Journal entries. The
 * log gets counts only.
 */
export async function announceMessages(
  changes: { item: MessageItem }[],
  ctx: AttachmentRunContext,
): Promise<{ announcements: Announcement[]; notifications: NewNotification[]; journal: NewJournalEvent[] }> {
  const counts: AttachmentCounts = { found: 0, stored: 0, fallback: 0, unrecognized: 0 };
  const announcements: Announcement[] = [];
  const notifications: NewNotification[] = [];
  const journal: NewJournalEvent[] = [];
  for (const { item } of changes) {
    const result = await announceOne(item, ctx, counts);
    announcements.push(result.announcement);
    notifications.push(...result.notifications);
    journal.push(...result.journal);
  }
  if (counts.found + counts.unrecognized > 0) {
    ctx.check.log?.(`attachments: found=${counts.found} stored=${counts.stored} fallback=${counts.fallback} unrecognized=${counts.unrecognized}`);
  }
  return { announcements, notifications, journal };
}
