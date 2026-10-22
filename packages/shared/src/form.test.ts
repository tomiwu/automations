import { describe, expect, it } from "vitest";
import { formBody } from "./form.ts";

describe("formBody", () => {
  it("encodes plain values like a form", () => {
    expect(formBody({ "user[email]": "a b&c", x: "ł" })).toBe("user%5Bemail%5D=a+b%26c&x=%C5%82");
  });

  it("keeps secret placeholders as they are", () => {
    expect(formBody({ login: "{{secret:LIBRUS_USER}}", pass: "pre {{secret:P}} post" })).toBe(
      "login={{secret:LIBRUS_USER}}&pass=pre+{{secret:P}}+post",
    );
  });
});
