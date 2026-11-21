import { addDays, localDate } from "@automations/shared";
import { checkEvent, planEvents } from "@automations/librus-data";
import type { Classifier, JournalEvent, Observed, StorageAdapter } from "@automations/librus-data";
import { WINDOW_DAYS, type Session } from "./sessions.ts";
import type { ActivityTarget } from "./targets.ts";

const SOURCE = "activities-watch";

export interface AccountSessions {
  target: ActivityTarget;
  sessions: readonly Session[];
}

export interface SessionsJournalDeps {
  storage: StorageAdapter;
  familyId: string;
  accounts: readonly AccountSessions[];
  timezone: string;
  now: Date;
  log?: (message: string) => void;
}

type SessionState = {
  accountId: string;
  service: string;
  activity: string;
  start: string;
  end: string;
  place: string;
  status: Session["status"];
  warning: string | null;
};

const sessionStream = (childId: string, id: string) => `session:${childId}:${id}`;
const checkStream = (accountId: string) => `check:${SOURCE}:${accountId}`;

function addedSession(state: SessionState): string {
  if (state.status === "cancelled") return "SessionCancelled";
  return state.status === "moved" ? "SessionMoved" : "SessionScheduled";
}

const isMovedNow = (previous: SessionState, next: SessionState): boolean =>
  (next.status === "moved" && previous.status !== "moved") || previous.start !== next.start || previous.end !== next.end;

const isRestoredNow = (previous: SessionState, next: SessionState): boolean =>
  next.status === "planned" && previous.status !== "planned";

function changedSession(previous: SessionState, next: SessionState): string {
  if (next.status === "cancelled" && previous.status !== "cancelled") return "SessionCancelled";
  if (isMovedNow(previous, next)) return "SessionMoved";
  return isRestoredNow(previous, next) ? "SessionRestored" : "SessionChanged";
}

const SESSION_TYPES: Classifier<SessionState> = { added: addedSession, changed: changedSession, vanished: "SessionVanished" };

function stateOf(accountId: string, session: Session): SessionState {
  const { service, activity, start, end, place, status } = session;
  return { accountId, service, activity, start, end, place, status, warning: session.warning ?? null };
}

function observedOf({ target, sessions }: AccountSessions): Observed<SessionState>[] {
  return sessions.map((session) => ({
    stream: sessionStream(target.child.id, session.id),
    childId: target.child.id,
    kind: "session",
    day: session.start.slice(0, 10),
    state: stateOf(target.account.id, session),
  }));
}

async function readHeads(deps: SessionsJournalDeps, today: string, observed: readonly string[]): Promise<Map<string, JournalEvent>> {
  const { storage, familyId } = deps;
  const first = await storage.listHeads(familyId, { kinds: ["session"], from: today, to: addDays(today, WINDOW_DAYS - 1) });
  const heads = new Map(first.map((head) => [head.stream, head]));
  const missing = observed.filter((stream) => !heads.has(stream));
  const checks = deps.accounts.map(({ target }) => checkStream(target.account.id));
  for (const head of await storage.listHeads(familyId, { streams: [...checks, ...missing] })) heads.set(head.stream, head);
  return heads;
}

async function checkEvents(deps: SessionsJournalDeps, today: string, heads: ReadonlyMap<string, JournalEvent>) {
  return Promise.all(
    deps.accounts.map(({ target, sessions }) => {
      const stream = checkStream(target.account.id);
      const payload = { service: target.account.service, sessions: sessions.length };
      return checkEvent({ familyId: deps.familyId, childId: target.child.id, stream, source: SOURCE, day: today, head: heads.get(stream), payload });
    }),
  );
}

export async function appendSessionsJournal(deps: SessionsJournalDeps): Promise<number> {
  if (deps.accounts.length === 0) return 0;
  const today = localDate(deps.now, deps.timezone);
  const observed = deps.accounts.flatMap(observedOf);
  const heads = await readHeads(deps, today, observed.map((item) => item.stream));
  const okAccounts = new Set(deps.accounts.map(({ target }) => target.account.id));
  const last = addDays(today, WINDOW_DAYS - 1);
  const inScope = (head: JournalEvent) =>
    head.day !== null && head.day >= today && head.day <= last && okAccounts.has(String((head.payload as Partial<SessionState>).accountId));
  const sessionHeads = [...heads.values()].filter((head) => head.kind === "session");
  const changes = await planEvents({ familyId: deps.familyId, source: SOURCE, heads: sessionHeads, observed, inVanishScope: inScope, classify: SESSION_TYPES });
  const count = await deps.storage.appendEvents([...changes, ...(await checkEvents(deps, today, heads))]);
  deps.log?.(`journal: +${count} events`);
  return count;
}
