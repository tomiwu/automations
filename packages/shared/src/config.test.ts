import { describe, expect, it } from "vitest";
import { validateAccount, validateConfig, validateRecipient } from "./index.ts";
import type { Raw, RawConfig, Account } from "./index.ts";

const account = (overrides: Raw<Account> = {}): Raw<Account> => ({
  id: "a1",
  family_id: "f1",
  child_id: "c1",
  service: "librus",
  origin: "https://example.test",
  group: null,
  login_secret: "CHILD1_LIBRUS_LOGIN",
  password_secret: "CHILD1_LIBRUS_PASSWORD",
  enabled: true,
  ...overrides,
});

const raw = (accounts: Raw<Account>[], recipients: RawConfig["recipients"] = []): RawConfig => ({
  family: { id: "f1", name: "Example Family", timezone: "Europe/Warsaw", default_language: "en" },
  children: [{ id: "c1", family_id: "f1", name: "Child One", has_librus: true, calendar_id: null }],
  accounts,
  activities: [],
  recipients,
});

describe("validateAccount", () => {
  const children = new Set(["c1"]);

  it("accepts a valid Account", () => {
    expect(validateAccount(account(), children)).toBeUndefined();
  });

  it("rejects an unknown Service", () => {
    const error = validateAccount(account({ service: "other" }), children);
    expect(error).toMatchObject({ id: "a1", code: "unknown_service" });
    expect(error?.message).toContain('"other"');
  });

  it("rejects a missing login secret name", () => {
    expect(validateAccount(account({ login_secret: "" }), children)?.code).toBe("missing_secret_name");
    expect(validateAccount(account({ login_secret: undefined }), children)?.message).toContain("login_secret");
  });

  it("rejects a missing password secret name", () => {
    const error = validateAccount(account({ password_secret: "  " }), children);
    expect(error?.code).toBe("missing_secret_name");
    expect(error?.message).toContain("password_secret");
  });

  it("rejects a bad origin", () => {
    expect(validateAccount(account({ origin: "not a url" }), children)?.code).toBe("bad_origin");
    expect(validateAccount(account({ origin: "ftp://example.test" }), children)?.code).toBe("bad_origin");
    expect(validateAccount(account({ origin: 5 }), children)?.code).toBe("bad_origin");
  });

  it("rejects a Child that is not in the Family", () => {
    expect(validateAccount(account({ child_id: "c9" }), children)?.code).toBe("unknown_child");
    expect(validateAccount(account({ child_id: undefined }), children)?.code).toBe("unknown_child");
  });
});

describe("validateRecipient", () => {
  it("accepts pl and en", () => {
    expect(validateRecipient({ id: "r1", language: "pl" })).toBeUndefined();
    expect(validateRecipient({ id: "r1", language: "en" })).toBeUndefined();
  });

  it("rejects a bad language", () => {
    const error = validateRecipient({ id: "r1", language: "de" });
    expect(error).toMatchObject({ subject: "recipient", id: "r1", code: "bad_language" });
  });

  it("names a Recipient without an id", () => {
    expect(validateRecipient({ language: 1 })?.id).toBe("");
  });
});

describe("validateConfig", () => {
  it("gives one error per bad Account and keeps the other Accounts", () => {
    const result = validateConfig(
      raw([account(), account({ id: "a2", service: "x" }), account({ id: "a3", password_secret: undefined })]),
    );
    expect(result.accounts.map((a) => a.id)).toEqual(["a1"]);
    expect(result.errors.map((e) => [e.id, e.code])).toEqual([
      ["a2", "unknown_service"],
      ["a3", "missing_secret_name"],
    ]);
  });

  it("skips disabled Accounts without an error", () => {
    const result = validateConfig(raw([account({ enabled: false, service: "x" })]));
    expect(result).toMatchObject({ accounts: [], errors: [] });
  });

  it("reports a Recipient with a bad language and keeps the others", () => {
    const result = validateConfig(
      raw([], [
        { id: "r1", telegram_chat_id: "1000001", language: "en", child_ids: ["c1"] },
        { id: "r2", telegram_chat_id: "1000002", language: "xx", child_ids: [] },
      ]),
    );
    expect(result.recipients.map((r) => r.id)).toEqual(["r1"]);
    expect(result.errors).toHaveLength(1);
  });
});
