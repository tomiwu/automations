import { encryptCredential, decryptCredential, importCredentialKey, isValidNip, isValidNrb, newCredentialKey } from "@automations/shared";
import { comparePaymentsProjection, paymentStream, type ProjectionRow } from "@automations/librus-data";
import { oneOf, parseArgs, required, secretName, weekday } from "./args.ts";
import { dayOffPayload, familyOf, headOf, isoDate, manualStream, nextEvent, type JournalRow } from "./day-off.ts";
import { signWatcherKey } from "./jwt.ts";
import { rekey } from "./rekey.ts";
import type { RestClient, Row } from "./rest.ts";

export interface AdminDeps {
  rest: () => RestClient;
  env: Record<string, string | undefined>;
  readFile: (path: string) => Promise<string>;
  now: () => number;
  print: (line: string) => void;
  readSecret: (prompt: string) => Promise<string>;
  readStdin: () => Promise<string>;
}

type Flags = Record<string, string>;
type Command = (flags: Flags, positional: string[], deps: AdminDeps) => Promise<void>;

const SERVICES = ["librus", "activenow", "edusky", "mondo"];
const LANGUAGES = ["pl", "en"];
const SEED_TABLES = ["families", "children", "accounts", "activities", "recipients", "fees"];

const optional = (flags: Flags, name: string): string | undefined => (flags[name] === undefined ? undefined : required(flags, name));

async function insertOne(deps: AdminDeps, table: string, row: Row): Promise<Row> {
  const [created] = await deps.rest().insert(table, [row]);
  if (created === undefined) throw new Error(`No row came back from ${table}`);
  deps.print(`Added to ${table}: ${String(created.id)}`);
  return created;
}

const addFamily: Command = async (flags, _positional, deps) => {
  await insertOne(deps, "families", {
    name: required(flags, "name"),
    timezone: flags.timezone ?? "UTC",
    default_language: oneOf(flags.language ?? "en", LANGUAGES, "language"),
  });
};

const addChild: Command = async (flags, _positional, deps) => {
  await insertOne(deps, "children", {
    family_id: required(flags, "family"),
    name: required(flags, "name"),
    has_librus: flags["has-librus"] === "true",
    calendar_id: optional(flags, "calendar-id") ?? null,
  });
};

export function secretInstructions(login: string, password: string): string[] {
  return [
    "Set the two credentials of this Account (encrypted on this computer):",
    `  admin set-credential --family <family id> --name ${login}`,
    `  admin set-credential --family <family id> --name ${password}`,
  ];
}

const addAccount: Command = async (flags, _positional, deps) => {
  const login = secretName(required(flags, "login-secret"), "login-secret");
  const password = secretName(required(flags, "password-secret"), "password-secret");
  await insertOne(deps, "accounts", {
    family_id: required(flags, "family"),
    child_id: required(flags, "child"),
    service: oneOf(required(flags, "service"), SERVICES, "service"),
    origin: optional(flags, "origin") ?? null,
    group: optional(flags, "group") ?? null,
    login_secret: login,
    password_secret: password,
  });
  for (const line of secretInstructions(login, password)) deps.print(line);
};

const addActivity: Command = async (flags, _positional, deps) => {
  await insertOne(deps, "activities", {
    family_id: required(flags, "family"),
    child_id: required(flags, "child"),
    account_id: optional(flags, "account") ?? null,
    name: required(flags, "name"),
    weekday: weekday(required(flags, "weekday")),
    start_time: required(flags, "start"),
    end_time: required(flags, "end"),
    place: optional(flags, "place") ?? null,
  });
};

const addRecipient: Command = async (flags, _positional, deps) => {
  const children = (optional(flags, "children") ?? "").split(",").filter((id) => id !== "");
  await insertOne(deps, "recipients", {
    family_id: required(flags, "family"),
    telegram_chat_id: required(flags, "chat-id"),
    language: oneOf(required(flags, "language"), LANGUAGES, "language"),
    child_ids: children,
  });
};

function intInRange(value: string, min: number, max: number, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`Option --${name} must be a whole number from ${min} to ${max}`);
  return number;
}

export function parseAmounts(value: string): Record<string, number> {
  const amounts: Record<string, number> = {};
  for (const pair of value.split(",").filter((item) => item !== "")) {
    const [month = "", grosze = ""] = pair.split("=");
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !/^[1-9]\d*$/.test(grosze)) {
      throw new Error("Option --amounts is a list of YYYY-MM=grosze, for example 2026-09=15000");
    }
    amounts[month] = Number(grosze);
  }
  return amounts;
}

function checkedNrb(value: string): string {
  const account = value.replace(/\s+/g, "");
  if (!isValidNrb(account)) throw new Error("Option --account is not a valid NRB (26 digits with a correct checksum)");
  return account;
}

function checkedNip(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!isValidNip(value)) throw new Error("Option --nip is not a valid NIP (10 digits with a correct checksum)");
  return value;
}

function feeDays(flags: Flags): { due_day: number; notify_day: number; reminder_day: number } {
  const dueDay = intInRange(required(flags, "due-day"), 1, 28, "due-day");
  const notifyDay = intInRange(flags["notify-day"] ?? "10", 1, 28, "notify-day");
  if (notifyDay >= dueDay) throw new Error("Option --notify-day must be less than --due-day");
  return { due_day: dueDay, notify_day: notifyDay, reminder_day: intInRange(flags["reminder-day"] ?? "14", 1, 28, "reminder-day") };
}

const setFee: Command = async (flags, _positional, deps) => {
  const checked = { account: checkedNrb(required(flags, "account")), nip: checkedNip(optional(flags, "nip")), ...feeDays(flags) };
  await insertOne(deps, "fees", {
    family_id: required(flags, "family"),
    child_id: required(flags, "child"),
    organizer: required(flags, "organizer"),
    recipient_name: required(flags, "recipient-name"),
    title: required(flags, "title"),
    amounts: parseAmounts(optional(flags, "amounts") ?? ""),
    source_url: optional(flags, "source-url") ?? null,
    account_id: optional(flags, "account-id") ?? null,
    ...checked,
  });
};

const listFees: Command = async (flags, _positional, deps) => {
  const filter = optional(flags, "family");
  const query = `select=*${filter === undefined ? "" : `&family_id=eq.${filter}`}&order=organizer`;
  const rows = await deps.rest().select("fees", query);
  deps.print(`fees: ${rows.length}`);
  for (const row of rows) deps.print(`  ${JSON.stringify(row)}`);
};

const list: Command = async (flags, _positional, deps) => {
  const filter = optional(flags, "family");
  for (const table of SEED_TABLES) {
    const query = filter === undefined || table === "families" ? "select=*" : `select=*&family_id=eq.${filter}`;
    const rows = await deps.rest().select(table, query);
    deps.print(`${table}: ${rows.length}`);
    for (const row of rows) deps.print(`  ${JSON.stringify(row)}`);
  }
};

const disableAccount: Command = async (flags, _positional, deps) => {
  const id = required(flags, "id");
  const rows = await deps.rest().update("accounts", `id=eq.${id}`, { enabled: false });
  if (rows.length === 0) throw new Error(`No Account with id ${id}`);
  deps.print(`Disabled Account ${id}`);
};

function checkFeeRow(row: Row): void {
  checkedNrb(String(row.account));
  if (row.nip !== null && row.nip !== undefined) checkedNip(String(row.nip));
}

export function checkSeedRow(table: string, row: Row): void {
  if (table === "fees") checkFeeRow(row);
  if (table !== "accounts") return;
  secretName(String(row.login_secret), "login_secret");
  secretName(String(row.password_secret), "password_secret");
}

type Seed = Record<string, Row[] | undefined>;

async function readSeed(path: string | undefined, deps: AdminDeps): Promise<Seed> {
  if (path === undefined) throw new Error("Usage: admin import-seed <file>");
  const seed = JSON.parse(await deps.readFile(path)) as Seed;
  for (const table of SEED_TABLES) for (const row of seed[table] ?? []) checkSeedRow(table, row);
  return seed;
}

const importSeed: Command = async (_flags, positional, deps) => {
  const seed = await readSeed(positional[0], deps);
  for (const table of SEED_TABLES) {
    const rows = seed[table] ?? [];
    if (rows.length > 0) await deps.rest().insert(table, rows);
    deps.print(`${table}: ${rows.length} imported`);
  }
};

const makeWatcherKey: Command = async (_flags, _positional, deps) => {
  const secret = deps.env.SUPABASE_JWT_SECRET;
  if (!secret) throw new Error("Set SUPABASE_JWT_SECRET in the environment");
  deps.print("Enter this key in Kody as SUPABASE_KEY. It is shown one time.");
  deps.print(signWatcherKey(secret, Math.floor(deps.now() / 1000)));
};

async function credentialKey(deps: AdminDeps, name = "CREDENTIAL_KEY"): Promise<CryptoKey> {
  const value = deps.env[name];
  if (!value) throw new Error(`Set ${name} in the environment (admin new-credential-key makes one)`);
  return importCredentialKey(value);
}

const newKey: Command = async (_flags, _positional, deps) => {
  deps.print("Credential key (shown one time; keep it in a password manager and pass it to ./configure yourself):");
  deps.print(newCredentialKey());
};

const setCredential: Command = async (flags, _positional, deps) => {
  const familyId = required(flags, "family");
  const name = secretName(required(flags, "name"), "name");
  const key = await credentialKey(deps);
  const value =
    flags.stdin === "true"
      ? (await deps.readStdin()).replace(/\r?\n$/, "")
      : await deps.readSecret(`Value of ${name} (not shown): `);
  if (value === "") throw new Error("The value is empty");
  const ciphertext = await encryptCredential(key, familyId, name, value);
  await deps.rest().upsert("credentials", [{ family_id: familyId, name, ciphertext, updated_at: new Date(deps.now()).toISOString() }]);
  deps.print(`Saved credential ${name} (encrypted)`);
};

const verifyCredential: Command = async (flags, _positional, deps) => {
  const familyId = required(flags, "family");
  const name = secretName(required(flags, "name"), "name");
  const key = await credentialKey(deps);
  const value = (await deps.readStdin()).replace(/\r?\n$/, "");
  const query = `select=ciphertext&family_id=eq.${encodeURIComponent(familyId)}&name=eq.${encodeURIComponent(name)}`;
  const sealed = (await deps.rest().select("credentials", query))[0]?.ciphertext;
  if (typeof sealed !== "string") {
    deps.print(`${name}: not stored`);
    return;
  }
  let stored: string;
  try {
    stored = await decryptCredential(key, familyId, name, sealed);
  } catch {
    deps.print(`${name}: does not decrypt with this CREDENTIAL_KEY`);
    return;
  }
  deps.print(`${name}: ${stored === value ? "match" : "no match"}`);
};

const listCredentials: Command = async (flags, _positional, deps) => {
  const rows = await deps.rest().select("credentials", `select=name,updated_at&family_id=eq.${required(flags, "family")}`);
  for (const row of rows) deps.print(`${String(row.name)}  ${String(row.updated_at)}`);
};

const rotateKey: Command = async (flags, _positional, deps) => {
  const familyId = required(flags, "family");
  const oldKey = await credentialKey(deps);
  const newKeyValue = await credentialKey(deps, "NEW_CREDENTIAL_KEY");
  const rows = await deps.rest().select("credentials", `select=family_id,name,ciphertext&family_id=eq.${familyId}`);
  const updated = [];
  for (const row of rows) {
    const name = String(row.name);
    const value = await decryptCredential(oldKey, familyId, name, String(row.ciphertext));
    updated.push({ family_id: familyId, name, ciphertext: await encryptCredential(newKeyValue, familyId, name, value) });
  }
  if (updated.length > 0) await deps.rest().upsert("credentials", updated);
  deps.print(`Re-encrypted ${updated.length} credentials. Now call ./configure with the new key in each package.`);
};

const rekeyCommand: Command = async (flags, _positional, deps) => {
  const bad = await rekey({ ...deps, rest: deps.rest() }, required(flags, "family"));
  if (bad > 0) throw new Error(`${bad} credential(s) are not ok`);
};

const isoText = (value: unknown): string | null => (value === null || value === undefined ? null : new Date(String(value)).toISOString());

function rowOf(row: Row, childOf: Map<string, string>): ProjectionRow[] {
  const childId = childOf.get(String(row.fee_id));
  if (childId === undefined) return [];
  return [{
    id: String(row.id),
    stream: paymentStream(childId, String(row.fee_id), String(row.month)),
    status: String(row.status),
    amount: Number(row.amount),
    amountSource: String(row.amount_source),
    notifiedAt: isoText(row.notified_at),
    remindedAt: isoText(row.reminded_at),
  }];
}

const paymentsConsistency: Command = async (flags, _positional, deps) => {
  const family = `family_id=eq.${encodeURIComponent(required(flags, "family"))}`;
  const rest = deps.rest();
  const fees = await rest.select("fees", `select=id,child_id&${family}`);
  const childOf = new Map(fees.map((fee) => [String(fee.id), String(fee.child_id)]));
  const payments = await rest.select("payments", `select=id,fee_id,month,status,amount,amount_source,notified_at,reminded_at&${family}`);
  const heads = await rest.select("journal_heads", `select=stream,payload&kind=eq.payment&${family}`);
  const differences = comparePaymentsProjection(
    heads.map((head) => ({ stream: String(head.stream), payload: (head.payload ?? {}) as Record<string, unknown> })),
    payments.flatMap((row) => rowOf(row, childOf)),
  );
  deps.print(`Payments: ${payments.length}, Journal heads: ${heads.length}, differences: ${differences.length}`);
  for (const item of differences) deps.print(`${item.problem}  ${item.stream}  ${item.paymentId ?? "-"}  ${item.field ?? ""}`.trimEnd());
  if (differences.length > 0) throw new Error(`${differences.length} difference(s) between the Journal and the payments table`);
};

async function appendOrReport(deps: AdminDeps, event: JournalRow | null, flags: Flags, done: string): Promise<void> {
  if (event === null) {
    deps.print("No change: the Journal head has this content already");
    return;
  }
  if (flags["dry-run"] === "true") {
    deps.print(`Dry run, nothing written: ${JSON.stringify(event)}`);
    return;
  }
  await deps.rest().insert("journal_events", [event]);
  deps.print(`${done}: ${event.stream} (seq ${event.seq})`);
}

const addDayOff: Command = async (flags, _positional, deps) => {
  const childId = required(flags, "child");
  const from = isoDate(required(flags, "from"), "from");
  const to = isoDate(optional(flags, "to") ?? from, "to");
  if (to < from) throw new Error("Option --to must not be before --from");
  const sourceStream = required(flags, "source-stream");
  const rest = deps.rest();
  const familyId = await familyOf(rest, childId);
  if ((await headOf(rest, familyId, sourceStream)) === undefined) throw new Error(`No stream ${sourceStream} in the Journal`);
  const payload = dayOffPayload({ childId, from, to, reason: required(flags, "reason"), sourceStream });
  const stream = manualStream(childId, from);
  const event = await nextEvent({ family_id: familyId, child_id: childId, stream, day: from }, payload, await headOf(rest, familyId, stream));
  await appendOrReport(deps, event, flags, "Added day off");
};

const removeDayOff: Command = async (flags, _positional, deps) => {
  const childId = required(flags, "child");
  const from = isoDate(required(flags, "from"), "from");
  const rest = deps.rest();
  const familyId = await familyOf(rest, childId);
  const stream = manualStream(childId, from);
  const head = await headOf(rest, familyId, stream);
  if (head === undefined) throw new Error(`No manual day off ${stream} in the Journal`);
  const payload = { ...(head.payload as Record<string, unknown>), withdrawn: true };
  const event = await nextEvent({ family_id: familyId, child_id: childId, stream, day: from }, payload, head);
  await appendOrReport(deps, event, flags, "Withdrew day off");
};

const COMMANDS: Record<string, Command> = {
  rekey: rekeyCommand,
  "new-credential-key": newKey,
  "set-credential": setCredential,
  "list-credentials": listCredentials,
  "verify-credential": verifyCredential,
  "rotate-credential-key": rotateKey,
  "add-family": addFamily,
  "add-child": addChild,
  "add-account": addAccount,
  "add-activity": addActivity,
  "add-recipient": addRecipient,
  list,
  "set-fee": setFee,
  "list-fees": listFees,
  "payments-consistency": paymentsConsistency,
  "add-day-off": addDayOff,
  "remove-day-off": removeDayOff,
  "disable-account": disableAccount,
  "import-seed": importSeed,
  "make-watcher-key": makeWatcherKey,
};

export async function runAdmin(args: readonly string[], deps: AdminDeps): Promise<void> {
  const [name, ...rest] = args;
  const command = name === undefined ? undefined : COMMANDS[name];
  if (command === undefined) throw new Error(`Usage: admin <${Object.keys(COMMANDS).join("|")}> [options]`);
  const { flags, positional } = parseArgs(rest);
  await command(flags, positional, deps);
}
