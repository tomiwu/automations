import { describe, expect, it } from "vitest";
import { REQUEST_FAILED, handleAdmin, routePath, type AdminDeps } from "./admin.ts";
import { parseAllowlist } from "./allowlist.ts";
import type { BotRecord, BotRegistry } from "./registry.ts";

const url = "https://api2.cursor.sh/automations/webhook/example";
const token = "example-admin-token";
const secretKey = "example-webhook-key";

function harness(): AdminDeps & { rows: BotRecord[] } {
  const rows: BotRecord[] = [];
  const allow = { ids: ["1000001"] };
  const registry: BotRegistry = {
    async list() {
      return rows.map((row) => ({ ...row }));
    },
    async upsert(_familyId, bot) {
      const index = rows.findIndex((row) => row.slug === bot.slug);
      if (index >= 0) rows[index] = bot;
      else rows.push(bot);
    },
    async timezone() {
      return "UTC";
    },
  };
  return {
    rows,
    familyId: "family-1",
    registry,
    adminToken: token,
    get allowlist() {
      return allow.ids;
    },
    async seal(slug, key) {
      return `sealed:${slug}:${key}`;
    },
    async saveAllowlist(ids) {
      allow.ids = parseAllowlist(ids);
      return allow.ids;
    },
  };
}

function form(path: string, fields: Record<string, string>, cookie = ""): Request {
  return new Request(`https://example.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams(fields),
  });
}

async function signIn(deps: AdminDeps): Promise<string> {
  const response = await handleAdmin(form("/login", { token }), deps, "");
  const cookie = response.headers.get("set-cookie") ?? "";
  return cookie.slice(0, cookie.indexOf(";"));
}

describe("admin page", () => {
  it("builds a path inside the app mount", () => {
    expect(routePath("https://example.test/kradziejka/edit/", "/kradziejka")).toBe("/edit");
    expect(routePath("https://example.test/login", "")).toBe("/login");
  });

  it("shows the empty form and rejects a cookie that does not match", async () => {
    const deps = harness();
    const cookie = await signIn(deps);
    const form = await handleAdmin(new Request("https://example.test/new", { headers: { cookie } }), deps, "");
    expect(await form.text()).toContain("Webhook URL");
    for (const other of ["theme=dark; other", "kradziejka_admin=short"]) {
      const page = await handleAdmin(new Request("https://example.test/new", { headers: { cookie: other } }), deps, "");
      expect(await page.text()).toContain("Admin token");
    }
  });

  it("handles missing form fields, an inactive bot and a mount path", async () => {
    const deps = harness();
    const none = await handleAdmin(form("/login", {}), deps, "/app");
    expect(await none.text()).toContain("not correct");
    const login = await handleAdmin(form("/app/login", { token }), deps, "/app");
    expect(login.headers.get("set-cookie")).toContain("Path=/app;");
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const noSlug = await handleAdmin(new Request("https://example.test/app/edit", { headers: { cookie } }), deps, "/app");
    expect(noSlug.status).toBe(404);
    const empty = await handleAdmin(form("/app/save", {}, cookie), deps, "/app");
    expect(await empty.text()).toContain(REQUEST_FAILED);
    deps.saveAllowlist = async () => {
      throw new Error("x");
    };
    const list = await handleAdmin(form("/app/allowlist", {}, cookie), deps, "/app");
    expect(await list.text()).toContain(REQUEST_FAILED);
    deps.rows.push({ slug: "off", name: "Off", description: "d", activeHours: "always", webhookUrl: url, webhookKeyCiphertext: "c", active: false });
    const edit = await handleAdmin(new Request("https://example.test/app/edit?slug=off", { headers: { cookie } }), deps, "/app");
    expect(await edit.text()).not.toContain("checked");
  });

  it("hides the registry until the admin token is correct", async () => {
    const deps = harness();
    const anonymous = await handleAdmin(new Request("https://example.test/"), deps, "");
    const anonymousHtml = await anonymous.text();
    expect(anonymousHtml).toContain("Admin token");
    expect(anonymousHtml).not.toContain("Add a bot");
    const wrong = await handleAdmin(form("/login", { token: "not-the-admin-token" }), deps, "");
    expect(await wrong.text()).toContain("not correct");
    const cookie = await signIn(deps);
    expect(cookie).not.toContain(token);
    const page = await handleAdmin(new Request("https://example.test/", { headers: { cookie } }), deps, "");
    const html = await page.text();
    expect(html).toContain("Add a hub entry");
    expect(html).toContain("1000001");
  });

  it("saves a bot without showing the key, and keeps the key on edit", async () => {
    const deps = harness();
    const cookie = await signIn(deps);
    const fields = { slug: "hub", name: "Hub", description: "Chooses an agent.", activeHours: "always", webhookUrl: url, webhookKey: secretKey, active: "true" };
    const saved = await handleAdmin(form("/save", fields, cookie), deps, "");
    expect(saved.status).toBe(303);
    expect(deps.rows[0]?.webhookKeyCiphertext).toBe(`sealed:hub:${secretKey}`);
    const edit = await handleAdmin(new Request("https://example.test/edit?slug=hub", { headers: { cookie } }), deps, "");
    const html = await edit.text();
    expect(html).toContain("Hub");
    expect(html).not.toContain(secretKey);
    expect(html).not.toContain("sealed:hub");
    await handleAdmin(form("/save", { ...fields, description: "Still the hub.", webhookKey: "" }, cookie), deps, "");
    expect(deps.rows.find((row) => row.slug === "hub")?.webhookKeyCiphertext).toBe(`sealed:hub:${secretKey}`);
    expect(deps.rows.find((row) => row.slug === "hub")?.description).toBe("Still the hub.");
    deps.rows.push({
      slug: "old",
      name: "Old & Co",
      description: "Paused.",
      activeHours: "always",
      webhookUrl: url,
      webhookKeyCiphertext: "",
      active: false,
    });
    const listed = await handleAdmin(new Request("https://example.test/", { headers: { cookie } }), deps, "");
    const listedHtml = await listed.text();
    expect(listedHtml).toContain("Old &amp; Co");
    expect(listedHtml).toContain(">no<");
    expect(listedHtml).toContain("missing");
    expect(listedHtml).not.toContain("Add a hub entry");
  });

  it("shows a form error and does not echo the key", async () => {
    const deps = harness();
    const cookie = await signIn(deps);
    const response = await handleAdmin(
      form("/save", { slug: "hub", name: "Hub", description: "Chooses.", activeHours: "nope", webhookUrl: url, webhookKey: secretKey, active: "true" }, cookie),
      deps,
      "",
    );
    const html = await response.text();
    expect(html).toContain(REQUEST_FAILED);
    expect(html).not.toContain(secretKey);
  });

  it("does not return the text of a failing store or allowlist save", async () => {
    const fakeSecret = "fake-secret-supabase-detail";
    const deps = harness();
    const cookie = await signIn(deps);
    deps.saveAllowlist = async () => {
      throw new Error(fakeSecret);
    };
    const list = await handleAdmin(form("/allowlist", { allowlist: "1000001" }, cookie), deps, "");
    const listHtml = await list.text();
    expect(listHtml).toContain(REQUEST_FAILED);
    expect(listHtml).not.toContain(fakeSecret);

    deps.seal = async () => {
      throw new Error(fakeSecret);
    };
    const save = await handleAdmin(
      form("/save", { slug: "hub", name: "Hub", description: "Chooses.", activeHours: "always", webhookUrl: url, webhookKey: secretKey, active: "true" }, cookie),
      deps,
      "",
    );
    const saveHtml = await save.text();
    expect(saveHtml).toContain(REQUEST_FAILED);
    expect(saveHtml).not.toContain(fakeSecret);
  });

  it("updates the allowlist and rejects an unknown path", async () => {
    const deps = harness();
    const cookie = await signIn(deps);
    const bad = await handleAdmin(form("/allowlist", { allowlist: "nope" }, cookie), deps, "");
    expect(await bad.text()).toContain(REQUEST_FAILED);
    const ok = await handleAdmin(form("/allowlist", { allowlist: "1000001, 1000002" }, cookie), deps, "");
    expect(ok.status).toBe(303);
    const page = await handleAdmin(new Request("https://example.test/", { headers: { cookie } }), deps, "");
    expect(await page.text()).toContain("1000002");
    expect((await handleAdmin(new Request("https://example.test/missing", { headers: { cookie } }), deps, "")).status).toBe(404);
    expect((await handleAdmin(new Request("https://example.test/edit?slug=missing", { headers: { cookie } }), deps, "")).status).toBe(404);
    const out = await handleAdmin(form("/logout", {}, cookie), deps, "");
    expect(out.headers.get("set-cookie")).toContain("Max-Age=0");
  });
});
