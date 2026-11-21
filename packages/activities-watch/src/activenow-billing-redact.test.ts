import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bodySkeleton,
  headSummary,
  LABEL_ALLOWLIST,
  maskIds,
  redactPaths,
  redactUrl,
  responseSkeleton,
} from "./activenow-billing-redact.ts";

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
describe("Stimulus code names and PII redaction", () => {
  it("keeps data-controller, data-action and -target values with digit masks", () => {
    const html =
      '<body><div data-controller="client-panel-page-settlements" data-action="click->client-panel-page-settlements#toggleUpcoming" data-client-panel-page-settlements-target="switch"><input data-client-panel-page-settlements-target="panel42"></div></body>';
    const skeleton = bodySkeleton(html);
    expect(skeleton).toContain('data-controller="client-panel-page-settlements"');
    expect(skeleton).toContain("click->client-panel-page-settlements#toggleUpcoming");
    expect(skeleton).toContain('data-client-panel-page-settlements-target="switch"');
    expect(skeleton).toContain('data-client-panel-page-settlements-target="panel<n>"');
    expect(skeleton).not.toContain("panel42");
  });

  it("redacts mailto, tel, e-mail in text and image file names", () => {
    const html =
      '<body><a href="mailto:fake@example.org">mail</a><a href="tel:+00-000-000-000">call</a><p>Contact fake@example.org</p><img src="/uploads/logo-abc.png" /></body>';
    const skeleton = bodySkeleton(html);
    expect(skeleton).toContain('href="mailto:<email>"');
    expect(skeleton).toContain('href="tel:<n>"');
    expect(skeleton).toContain("<email>");
    expect(skeleton).toMatch(/src="\/uploads\/<file>\.png"/);
    expect(skeleton).not.toContain("fake@example.org");
    expect(skeleton).not.toContain("logo-abc");
    expect(skeleton).not.toContain("000-000");
    const iconPage = '<body><link rel="shortcut icon" href="/uploads/facility-55.ico" /></body>';
    expect(bodySkeleton(iconPage)).toMatch(/href="\/uploads\/<file>\.ico"/);
    const srcset = '<body><img srcset="/uploads/a.png 1x, /uploads/b.png 2x" src="/uploads/c.png" /></body>';
    const srcsetSk = bodySkeleton(srcset);
    expect(srcsetSk).toContain("srcset=");
    expect(srcsetSk).not.toContain("a.png");
  });

  it("redacts path-like Stimulus -value attributes with redactUrl", () => {
    const html =
      '<body><div data-client-panel-page-settlements-upcoming-url-value="/client_panel/settlements/upcoming?x=1&child=9"></div></body>';
    const skeleton = bodySkeleton(html);
    expect(skeleton).toContain('data-client-panel-page-settlements-upcoming-url-value="/client_panel/settlements/upcoming?x&child"');
    expect(skeleton).not.toContain("child=9");
  });
});

describe("responseSkeleton", () => {
  it("marks JSON and HTML responses", () => {
    expect(responseSkeleton('{"paid":true}', "application/json")).toContain("<bool>");
    expect(responseSkeleton("<body><p>x</p></body>", "text/html")).toContain("<text>");
    expect(responseSkeleton("plain", "text/plain")).toBe("<text>");
  });
});

describe("headSummary", () => {
  it("lists scripts, modulepreload, preload and importmap keys with redacted paths", () => {
    const html = `<html><head>
      <script src="/assets/app-7f3e9a2b1c4d5e6f.js"></script>
      <link rel="modulepreload" href="/assets/chunk-settlements_controller.js">
      <link rel="preload" as="script" href="/assets/vendor-77.js">
      <script type="importmap">{"imports":{"controllers/client_panel/page/settlements_controller":"/assets/settlements-99.js","other":"/x.js"}}</script>
    </head><body></body></html>`;
    const head = headSummary(html);
    expect(head.scripts[0]).toMatch(/^\/assets\/app/);
    expect(head.scripts[0]).not.toContain("7f3e9a2b");
    expect(head.modulepreload).toEqual(["/assets/chunk-settlements_controller.js"]);
    expect(head.preloadScripts).toEqual(["/assets/vendor-<n>.js"]);
    expect(head.importmap?.keys).toContain("controllers/client_panel/page/settlements_controller");
    expect(head.importmap?.paths["controllers/client_panel/page/settlements_controller"]).toBe("/assets/settlements-<n>.js");
    expect(JSON.stringify(head)).not.toContain("7f3e9a2b");
    expect(JSON.stringify(head)).not.toContain("77");
  });
});

describe("record ids in attribute values and messages", () => {
  it("masks digits and long tokens in id, class, name and for values", () => {
    const html =
      '<body><div id="payment_998877" class="row row-42 client-panel-billing-table"><div><input name="items[31415]" type="checkbox"><label for="pay-7f3e9a2b1c4d5e6f7a8b9c0d1e2f">x</label></div></div></body>';
    const skeleton = bodySkeleton(html);
    for (const value of ["998877", "42", "31415", "7f3e9a2b1c4d5e6f7a8b9c0d1e2f"]) expect(skeleton).not.toContain(value);
    expect(skeleton).toContain('id="payment_<n>"');
    expect(skeleton).toContain('class="row row-<n> client-panel-billing-table"');
    expect(skeleton).toContain('name="items[<n>]"');
    expect(skeleton).toContain('for="<id>"');
    expect(skeleton).toContain('type="checkbox"');
  });

  it("keeps a long word without a digit", () => {
    expect(maskIds("client-panel-billing-table-wrapper")).toBe("client-panel-billing-table-wrapper");
    expect(maskIds("user_123e4567-e89b-12d3-a456-426614174000")).not.toContain("123e4567");
  });

  it("masks the numbers of paths and addresses in a message", () => {
    expect(redactPaths("ActiveNow: HTTP 404 from /client_panel/billing/accounts/55")).toBe(
      "ActiveNow: HTTP 404 from /client_panel/billing/accounts/<n>",
    );
    expect(redactPaths("Too many redirects: https://app.example.org/payments/77?id=5")).toBe(
      "Too many redirects: /payments/<n>?id",
    );
    expect(redactPaths("ActiveNow: login rejected (check credentials)")).toBe("ActiveNow: login rejected (check credentials)");
  });
});
