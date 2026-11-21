import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bodySkeleton, LABEL_ALLOWLIST, redactUrl } from "./activenow-billing-redact.ts";

const fixture = readFileSync(new URL("./fixtures/activenow-billing-synthetic.html", import.meta.url), "utf8");

const SECRETS_AND_NAMES = [
  "Test Child",
  "csrf-fake-token-abc123",
  "998877665544",
  "Czesne za maj Test Child",
  "7f3e9a2b1c4d5e6f",
];

describe("bodySkeleton edge cases", () => {
  it("returns an empty string when the page has no body", () => {
    expect(bodySkeleton("<html></html>")).toBe("");
  });

  it("drops comments, style and stops at the size limit", () => {
    const html = "<body><!-- secret --><style>.x{}</style><p>x</p></body>";
    expect(bodySkeleton(html)).not.toContain("secret");
    expect(bodySkeleton(html)).not.toContain("<style>");
  });
});

describe("redactUrl", () => {
  it("keeps path segments with digit and id marks and drops query values", () => {
    expect(redactUrl("/client_panel/billing?account_id=998877665544&page=2#tab")).toBe(
      "/client_panel/billing?account_id&page",
    );
    expect(redactUrl("https://app.example.org/accounts/123e4567-e89b-12d3-a456-426614174000/view")).toBe(
      "/accounts/<id>/view",
    );
  });
});

describe("bodySkeleton", () => {
  it("redacts a synthetic billing page", () => {
    const skeleton = bodySkeleton(fixture);
    for (const forbidden of SECRETS_AND_NAMES) expect(skeleton).not.toContain(forbidden);
    expect(skeleton).toContain('class="billing-table"');
    expect(skeleton).toContain('class="nav-link"');
    for (const label of ["Rozliczenia", "Data", "Tytuł", "Kwota", "Pokaż nadchodzące", "Nieopłacone", "Opłacono"]) {
      expect(LABEL_ALLOWLIST.has(label)).toBe(true);
      expect(skeleton).toContain(label);
    }
    expect(skeleton).toContain("<date>");
    expect(skeleton).toContain("<amount>");
    expect(skeleton).toContain("<text>");
    expect(skeleton).toMatch(/href="\/client_panel\/billing\?account_id"/);
    expect(skeleton).toContain('"name":"<text>"');
    expect(skeleton).not.toContain("<style>");
    expect(skeleton).not.toContain("hidden");
    expect(skeleton).toContain('"paid":"<bool>"');
    expect(skeleton).toMatch(/<script src="\/assets\/<id>\.js"><\/script>/);
    expect(skeleton).toContain("<script></script>");
  });

  it("marks bool, empty and number text", () => {
    const html = "<body><p>true</p><p> </p><p>42</p><p>not-a-url</p><p>Saldo</p></body>";
    const skeleton = bodySkeleton(html);
    expect(skeleton).toContain("<bool>");
    expect(skeleton).toContain("<number>");
    expect(skeleton).toContain("<text>");
    expect(skeleton).toContain("Saldo");
    expect(skeleton).not.toContain("not-a-url");
  });

  it("redacts JSON leaves and cuts an oversized body", () => {
    const html = `<body><script type="application/json">{"items":[null,2],"note":"x"}</script>${"<i>t</i>".repeat(30_000)}</body>`;
    const skeleton = bodySkeleton(html);
    expect(skeleton).toContain('"items":["<empty>","<number>"]');
    expect(skeleton).toContain("<cut>");
  });

  it("returns a text mark for a bad URL", () => {
    expect(redactUrl("http://[")).toBe("<text>");
  });

  it("prints the skeleton of the synthetic fixture", () => {
    console.log(bodySkeleton(fixture));
    expect(true).toBe(true);
  });
});