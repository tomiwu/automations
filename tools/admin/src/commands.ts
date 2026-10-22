import { encryptCredential, decryptCredential, importCredentialKey, newCredentialKey } from "@automations/shared";
import { oneOf, parseArgs, required, secretName, weekday } from "./args.ts";
import { signWatcherKey } from "./jwt.ts";
import type { RestClient, Row } from "./rest.ts";

export interface AdminDeps {
  rest: () => RestClient;
  env: Record<string, string | undefined>;
  readFile: (path: string) => Promise<string>;
  now: () => number;
  print: (line: string) => void;
  /** Reads one value from the terminal without echo. */
  readSecret: (prompt: string) => Promise<string>;
  /** Reads all of standard input (for `set-credential --stdin`). */
  readStdin: () => Promise<string>;
}

type Flags = Record<string, string>;
type Command = (flags: Flags, positional: string[], deps: AdminDeps) => Promise<void>;

const SERVICES = ["librus", "activenow", "edusky", "mondo"];
const LANGUAGES = ["pl", "en"];
const SEED_TABLES = ["families", "children", "accounts", "activities", "recipients"];

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

export function checkSeedRow(table: string, row: Row): void {
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

const COMMANDS: Record<string, Command> = {
  "new-credential-key": newKey,
  "set-credential": setCredential,
  "list-credentials": listCredentials,
  "rotate-credential-key": rotateKey,
  "add-family": addFamily,
  "add-child": addChild,
  "add-account": addAccount,
  "add-activity": addActivity,
  "add-recipient": addRecipient,
  list,
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
