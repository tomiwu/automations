import { describe, expect, it } from "vitest";
import { JEV_API_KEY_PLACEHOLDER, JEV_DECISIONS_URL, postDecision } from "./jev.ts";
import { assertBodySafe, postForward } from "./forward.ts";

describe("Jev and forward HTTP", () => {
  it("sends the literal Jev secret placeholder", async () => {
    let seen: RequestInit | undefined;
    const body = await postDecision(async (input, init) => {
      seen = init;
      expect(input).toBe(JEV_DECISIONS_URL);
      return new Response(JSON.stringify({ answers: { route: { choice: "hub", confidence: 0.4 } } }), { status: 200 });
    }, { state: {} });
    expect(body).toMatchObject({ answers: { route: { choice: "hub" } } });
    expect(new Headers(seen?.headers).get("authorization")).toBe(`Bearer ${JEV_API_KEY_PLACEHOLDER}`);
    expect(JEV_API_KEY_PLACEHOLDER).toBe("{{secret:JEV_API_KEY}}");
  });

  it("fails when Jev or the bot webhook rejects the call", async () => {
    await expect(postDecision(async () => new Response("no", { status: 401 }), {})).rejects.toThrow("401");
    const url = "https://api2.cursor.sh/automations/webhook/example";
    await expect(postForward(async () => new Response("no", { status: 500 }), url, "example-key", { text: "Hi" })).rejects.toThrow("500");
    await expect(postForward(async () => new Response("ok"), "https://example.test/hook", "example-key", {})).rejects.toThrow("webhookUrl");
    expect(() => assertBodySafe('{"photo":"https://api.telegram.org/file/bot1:abc/a.jpg"}')).toThrow("file URL");
  });
});
