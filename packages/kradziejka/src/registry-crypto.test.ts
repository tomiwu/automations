import { importCredentialKey, newCredentialKey } from "@automations/shared";
import { describe, expect, it } from "vitest";
import { openWebhookKey, sealWebhookKey } from "./registry-crypto.ts";

describe("registry crypto", () => {
  it("round-trips a webhook key and binds it to the slug", async () => {
    const key = await importCredentialKey(newCredentialKey());
    const sealed = await sealWebhookKey(key, "family-1", "grades", "example-webhook-key");
    expect(sealed).toMatch(/^v1\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(sealed).not.toContain("example-webhook-key");
    await expect(openWebhookKey(key, "family-1", "grades", sealed)).resolves.toBe("example-webhook-key");
    await expect(openWebhookKey(key, "family-1", "hub", sealed)).rejects.toThrow("does not decrypt");
    await expect(openWebhookKey(key, "family-2", "grades", sealed)).rejects.toThrow("does not decrypt");
  });
});
