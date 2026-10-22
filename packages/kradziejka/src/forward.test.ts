import { describe, expect, it } from "vitest";
import { assertBodySafe, postForward } from "./forward.ts";

const url = "https://api2.cursor.sh/automations/webhook/example";

describe("forward", () => {
  it("posts the payload with a bearer key", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchFn = (async (target: string, init: RequestInit) => {
      calls.push({ url: target, init });
      return new Response("", { status: 200 });
    }) as never;
    await postForward(fetchFn, url, "example-key", { text: "Page 4." });
    expect(calls[0]?.url).toBe(url);
    expect(calls[0]?.init.body).toBe('{"text":"Page 4."}');
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer example-key");
  });

  it("rejects a bad URL, an unsafe body and a failed response", async () => {
    const fail = (async () => new Response("", { status: 500 })) as never;
    await expect(postForward(fail, "https://example.test/x", "k", {})).rejects.toThrow("webhookUrl");
    await expect(postForward(fail, url, "k", { file: "https://api.telegram.org/file/bot1/x" })).rejects.toThrow("Telegram file URL");
    await expect(postForward(fail, url, "k", {})).rejects.toThrow("500");
    expect(() => assertBodySafe("{}")).not.toThrow();
  });
});
