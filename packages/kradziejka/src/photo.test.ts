import { describe, expect, it } from "vitest";
import { pickPhoto } from "./photo.ts";

describe("pickPhoto", () => {
  it("returns null when the value is not a list", () => {
    expect(pickPhoto("x")).toBeNull();
    expect(pickPhoto([])).toBeNull();
  });

  it("picks the largest photo and drops unknown fields", () => {
    const photo = pickPhoto([
      { file_id: "small", file_unique_id: "u1", width: 10, height: 10, file_size: 5 },
      { file_id: "large", width: 100, height: 50, extra: "x" },
      { file_id: "mid", file_unique_id: "u3", width: 20, height: 20 },
    ]);
    expect(photo).toEqual({ fileId: "large", fileUniqueId: "", width: 100, height: 50, fileSize: null });
  });

  it("skips items that are incomplete or unsafe", () => {
    expect(pickPhoto([null, 5, { file_id: "a", width: 1 }])).toBeNull();
    expect(pickPhoto([{ file_id: "api.telegram.org/x", width: 1, height: 1 }])).toBeNull();
    expect(pickPhoto([{ file_id: "a", file_unique_id: "/file/bot1", width: 1, height: 1 }])).toBeNull();
  });
});
