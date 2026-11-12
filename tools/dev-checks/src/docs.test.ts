import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { brokenLinks, relativeLinks } from "./docs.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("relativeLinks", () => {
  it("returns the relative targets without the anchor and the title", () => {
    const text = 'See [a](docs/a.md), [b](./b.md#part), [c](<c d.md>) and ![d](img/d.png "Title").';
    expect(relativeLinks(text)).toEqual(["docs/a.md", "./b.md", "c d.md", "img/d.png"]);
  });

  it("ignores URLs, mail links, anchors of the same file and code", () => {
    const text = "[a](https://example.com) [b](mailto:x) [c](#part) `[d](no.md)`\n```sh\n[e](no.md)\n```\n[f](yes.md)";
    expect(relativeLinks(text)).toEqual(["yes.md"]);
  });
});

describe("brokenLinks", () => {
  it("names each link to a file that does not exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "docs-"));
    dirs.push(dir);
    writeFileSync(join(dir, "here.md"), "text");
    writeFileSync(join(dir, "page.md"), "[ok](here.md) [bad](missing.md) [encoded](no%20file.md)");
    expect(brokenLinks(join(dir, "page.md"))).toEqual(["missing.md", "no file.md"]);
  });
});

describe("the open source documents", () => {
  it.each(["README.md", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md", "LICENSE", ".env.example"])("%s exists", (name) => {
    expect(existsSync(join(root, name))).toBe(true);
  });

  const readme = () => readFileSync(join(root, "README.md"), "utf8");
  const docs = readdirSync(join(root, "docs")).filter((name) => name.endsWith(".md")).map((name) => `docs/${name}`);
  it.each(["README.md", "CONTRIBUTING.md", ...docs])("each relative link in %s points to a file that exists", (name) => {
    expect(brokenLinks(join(root, name))).toEqual([]);
  });

  it("the README links the primary documents", () => {
    expect(relativeLinks(readme())).toEqual(expect.arrayContaining(["docs/architecture.md", "docs/adding-a-child.md", "examples/seed.example.json", "CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md", "LICENSE"]));
  });

  it("the README says that the agent loop tooling is optional", () => {
    const section = readme().split(/^## /m).find((part) => part.includes("`.sandcastle/`") && part.includes("`scripts/sandcastle-loop/`"));
    expect(section).toMatch(/optional/);
    expect(section).toMatch(/not necessary to run the packages/);
  });
});
