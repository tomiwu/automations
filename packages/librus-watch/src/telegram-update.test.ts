import { describe, expect, it } from "vitest";
import { routeTelegramUpdate, type TelegramUpdate } from "./telegram-update.ts";

function setup() {
  const seen: string[] = [];
  const handlers = {
    payment: async (update: TelegramUpdate) => void seen.push(`payment:${update.callback_query?.data}`),
    other: async (update: TelegramUpdate) => void seen.push(`other:${update.update_id}`),
  };
  return { seen, route: (update: TelegramUpdate) => routeTelegramUpdate(update, handlers) };
}

describe("routeTelegramUpdate", () => {
  it("sends a pay: callback to the payment handler", async () => {
    const { seen, route } = setup();
    await route({ update_id: 1, callback_query: { id: "q", data: "pay:p1:paid" } });
    expect(seen).toEqual(["payment:pay:p1:paid"]);
  });

  it("sends a message update to the existing handler", async () => {
    const { seen, route } = setup();
    await route({ update_id: 2, message: {} });
    expect(seen).toEqual(["other:2"]);
  });

  it("sends a callback with other data to the existing handler", async () => {
    const { seen, route } = setup();
    await route({ update_id: 3, callback_query: { id: "q", data: "menu:1" } });
    await route({ update_id: 4, callback_query: { id: "q" } });
    expect(seen).toEqual(["other:3", "other:4"]);
  });
});
