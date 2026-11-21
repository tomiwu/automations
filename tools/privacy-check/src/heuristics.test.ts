import { describe, expect, it } from "vitest";
import { ibanValid, scanLine } from "./heuristics.ts";

// The positive samples are built at run time, so this file has no finding of its own.
const join = (separator: string, ...parts: Array<string | number>) => parts.join(separator);
const none = new Set<string>();
const withCheckDigits = (body: string) => {
  for (let check = 2; check < 99; check += 1) {
    const candidate = String(check).padStart(2, "0") + body;
    if (ibanValid(candidate)) return candidate;
  }
  throw new Error("no check digits");
};
const account = withCheckDigits("109010140000071219812874");

describe("scanLine: e-mail", () => {
  it("finds a private address", () => {
    expect(scanLine(`contact: ${join("@", "some.parent", "private-mail.net")}`, none)).toEqual(["email"]);
  });

  it("allows the documented example domains and no-reply addresses", () => {
    for (const address of ["parent@example.com", "a@mail.example.org", "x@school.example", "y@host.test", "git@github.com", "noreply@anthropic.com", "1+bot@users.noreply.github.com"]) {
      expect(scanLine(`to ${address}`, none)).toEqual([]);
    }
  });

  it("does not find a package version", () => {
    expect(scanLine("npm install typescript@5.6.0 @scope/name@1.2.3", none)).toEqual([]);
  });
});

describe("scanLine: phone", () => {
  it("finds a number with a country code", () => {
    expect(scanLine(`tel ${join(" ", "+48", "601", "234", "567")}`, none)).toEqual(["phone"]);
    expect(scanLine(`tel ${join("", "+48", "601234567")}`, none)).toEqual(["phone"]);
  });

  it("finds a national number in three groups", () => {
    expect(scanLine(`tel ${join("-", "601", "234", "567")}`, none)).toEqual(["phone"]);
  });

  it("does not find dates, ids and plain numbers", () => {
    expect(scanLine("2026-11-11 id 601234567 uuid 00000000-0000-0000-0000-000000000001 sum 1 000 000", none)).toEqual([]);
  });
});

describe("scanLine: account number", () => {
  it("finds a 26-digit number with a valid checksum, compact, grouped and with a country code", () => {
    const grouped = account.replace(/^(\d\d)/, "$1 ").replace(/(\d{4})(?=\d)/g, "$1 ");
    expect(scanLine(`account ${account}`, none)).toEqual(["iban"]);
    expect(scanLine(`account ${grouped}`, none)).toEqual(["iban"]);
    expect(scanLine(`account PL${account}`, none)).toEqual(["iban"]);
  });

  it("does not find a synthetic number with a wrong checksum", () => {
    expect(scanLine(`account ${"1".repeat(26)} or ${"12345678901234567890123456"}`, none)).toEqual([]);
  });
});

describe("scanLine: private IP address", () => {
  it("finds addresses of the private ranges", () => {
    for (const address of [join(".", 192, 168, 1, 20), join(".", 10, 0, 0, 5), join(".", 172, 16, 4, 1), join(".", 100, 100, 1, 2)]) {
      expect(scanLine(`host ${address}:8080`, none)).toEqual(["private-ip"]);
    }
  });

  it("allows loopback, RFC 5737 and public addresses", () => {
    expect(scanLine("127.0.0.1 192.0.2.10 198.51.100.7 203.0.113.9 8.8.8.8 172.32.0.1", none)).toEqual([]);
  });
});

describe("scanLine: Telegram chat id", () => {
  const key = join("_", "chat", "id");

  it("finds a chat id next to its key", () => {
    expect(scanLine(`${key}: 584930211`, none)).toEqual(["telegram-chat-id"]);
    expect(scanLine(`"${join("", "chat", "Id")}": "-${join("", 100, 1234567890)}"`, none)).toEqual(["telegram-chat-id"]);
  });

  it("allows the documented example ids", () => {
    expect(scanLine(`${key}: 1000001, ${key}=1000002 ${key}: 42`, none)).toEqual([]);
  });
});

describe("scanLine: tokens", () => {
  it("finds a URL with a token in the query", () => {
    const url = `https://api.service.example/v1/feed?user=1&${join("=", "token", "a8f3k2m9x7q1w5e4")}`;  // gitleaks:allow (synthetic sample)
    expect(scanLine(url, none)).toEqual(["url-token"]);
  });

  it("allows a placeholder in the query", () => {
    expect(scanLine("https://api.service.example/feed?token=<TOKEN> https://x.example/?key=${KEY} https://x.example/?token=short", none)).toEqual([]);
  });

  it("finds a Telegram bot token, a JWT and a Supabase project ref", () => {
    expect(scanLine(join(":", 123456789, "A".repeat(35)), none)).toEqual(["telegram-bot-token"]);
    expect(scanLine(join(".", `eyJ${"a".repeat(20)}`, `eyJ${"b".repeat(20)}`, "c".repeat(20)), none)).toEqual(["jwt"]);
    expect(scanLine(`https://${"abcdefghij".repeat(2)}.${join(".", "supabase", "co")}`, none)).toEqual(["supabase-ref"]);
  });

  it("allows the example Supabase hosts", () => {
    expect(scanLine("https://example.supabase.co https://x.supabase.co", none)).toEqual([]);
  });
});

describe("scanLine: allowlist", () => {
  it("drops a value of the allowlist", () => {
    const phone = join("-", "601", "234", "567");
    expect(scanLine(`tel ${phone}`, new Set([phone]))).toEqual([]);
  });

  it("reports each category one time for each line", () => {
    const address = join("@", "a.b", "private-mail.net");
    expect(scanLine(`${address} ${address} ${join(".", 10, 1, 1, 1)}`, none)).toEqual(["email", "private-ip"]);
  });
});
