import { describe, expect, it } from "vitest";
import {
  ACTIVITY1,
  CHILD1,
  CHILD2,
  EDUSKY_ACCOUNT,
  FAMILY_ID,
  NOW_ACCOUNT,
  choirActivity,
  testConfig,
} from "./test-fixtures.ts";
import { activityTargets, firstActivity } from "./targets.ts";

describe("activityTargets", () => {
  it("builds one target for each ActiveNow and Edusky Account with its Activities and Recipients", () => {
    const { targets, errors } = activityTargets(testConfig());
    expect(errors).toEqual([]);
    expect(targets.map((t) => [t.account.id, t.child.id])).toEqual([
      [NOW_ACCOUNT, CHILD1],
      [EDUSKY_ACCOUNT, CHILD2],
    ]);
    expect(targets[0]?.activities.map((a) => a.id)).toEqual([ACTIVITY1]);
    expect(targets[0]?.recipients.map((r) => r.telegram_chat_id)).toEqual(["1000001", "1000002"]);
    expect(targets[1]?.recipients.map((r) => r.telegram_chat_id)).toEqual(["1000002", "1000003"]);
  });

  it("skips other Services and disabled Accounts", () => {
    const config = testConfig();
    config.accounts.push({ ...config.accounts[0]!, id: "a3", service: "librus" });
    config.accounts.push({ ...config.accounts[0]!, id: "a4", service: "mondo" });
    config.accounts.push({ ...config.accounts[0]!, id: "a5", enabled: false });
    expect(activityTargets(config).targets).toHaveLength(2);
  });

  it("skips disabled Activities", () => {
    const config = testConfig();
    config.activities = [{ ...choirActivity, enabled: false }];
    expect(activityTargets(config).targets[0]?.activities).toEqual([]);
  });

  it("gives one error for a bad Account and keeps the other Accounts", () => {
    const config = testConfig();
    config.accounts[0] = { ...config.accounts[0]!, login_secret: "" };
    const { targets, errors } = activityTargets(config);
    expect(targets.map((t) => t.account.id)).toEqual([EDUSKY_ACCOUNT]);
    expect(errors).toEqual([expect.stringContaining("login_secret is missing")]);
  });

  it("gives an error for an unknown Service and ignores the errors of Librus Accounts", () => {
    const config = testConfig();
    config.accounts.push({ ...config.accounts[0]!, id: "a3", service: "librus", origin: "bad" });
    config.accounts.push({ ...config.accounts[0]!, id: "a4", service: "unknown" as never });
    const { errors } = activityTargets(config);
    expect(errors).toEqual([expect.stringContaining('unknown service "unknown"')]);
  });

  it("reports a Recipient with a bad language", () => {
    const config = testConfig();
    config.recipients.push({ id: "r9", family_id: FAMILY_ID, telegram_chat_id: "1000009", language: "de" as never, child_ids: [] });
    const { targets, errors } = activityTargets(config);
    expect(errors).toEqual([expect.stringContaining("language")]);
    expect(targets[0]?.recipients.map((r) => r.id)).toEqual(["r1", "r2"]);
  });
});

describe("firstActivity", () => {
  it("returns the first Activity and rejects an Account without one", () => {
    const [target] = activityTargets(testConfig()).targets;
    expect(firstActivity(target!).id).toBe(ACTIVITY1);
    expect(() => firstActivity({ ...target!, activities: [] })).toThrow(/no enabled Activity/);
  });
});
