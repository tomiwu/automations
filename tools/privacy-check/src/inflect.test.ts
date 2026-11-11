import { describe, expect, it } from "vitest";
import { inflectedForms } from "./inflect.ts";

// Invented words only. The endings are the Polish case endings without diacritics.
describe("inflectedForms", () => {
  it("gives the case forms of a word that ends with a", () => {
    const forms = inflectedForms("zorka");
    for (const form of ["zorka", "zorki", "zorke", "zorko", "zorce"]) expect(forms).toContain(form);
  });

  it("gives the case forms of a word that ends with a consonant", () => {
    const forms = inflectedForms("borzym");
    for (const form of ["borzym", "borzyma", "borzymowi", "borzymem", "borzymie", "borzymu"]) expect(forms).toContain(form);
  });

  it("drops the e of the ek ending", () => {
    const forms = inflectedForms("borek");
    for (const form of ["borek", "borka", "borkowi", "borkiem", "borku"]) expect(forms).toContain(form);
  });

  it("gives the forms of a word that ends with another vowel", () => {
    const forms = inflectedForms("zorko");
    for (const form of ["zorko", "zorka", "zorkowi", "zorkiem", "zorku"]) expect(forms).toContain(form);
  });

  it("softens the stem in the dative and locative of an a word", () => {
    expect(inflectedForms("morga")).toContain("mordze");
    expect(inflectedForms("zora")).toContain("zorze");
    expect(inflectedForms("zota")).toContain("zocie");
    expect(inflectedForms("zoda")).toContain("zodzie");
    expect(inflectedForms("zonia")).toContain("zonii");
  });

  it("gives no duplicate and no form shorter than 3 characters", () => {
    const forms = inflectedForms("zo");
    expect(new Set(forms).size).toBe(forms.length);
    expect(forms.every((form) => form.length >= 3)).toBe(true);
  });
});
