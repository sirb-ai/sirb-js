import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  discoverFixtures,
  fixturesDir,
  formatSummary,
  locatorMatches,
  runConformance,
  runFixture,
  specPackageDir,
  type FixtureFile,
} from "../src/conformance.js";

// The sirb-spec conformance suite, run through the public API of @sirb/core.
const files = discoverFixtures();

describe("sirb-spec conformance fixtures", () => {
  it("discovers the fixtures of the installed @sirb/spec", () => {
    expect(specPackageDir()).toMatch(/@sirb[\\/]spec$/);
    expect(files.length).toBeGreaterThan(0);
    const levels = new Set(files.map((f) => f.fixture.level));
    expect([...levels].sort()).toEqual(["loader", "schema"]);
  });

  for (const file of files) {
    it(file.name, () => {
      const result = runFixture(file);
      expect(result.failures).toEqual([]);
      expect(result.passed).toBe(true);
    });
  }

  it("checks defineAgent parity on every schema-level Agent fixture", () => {
    const agentFixtures = files.filter(
      (f) =>
        f.fixture.level === "schema" &&
        (f.fixture.document as { kind?: unknown } | null)?.kind === "Agent",
    );
    expect(agentFixtures.length).toBeGreaterThan(0);
    for (const f of agentFixtures)
      expect(runFixture(f).defineAgentParity).toBe(true);
  });
});

const agentDoc = {
  apiVersion: "sirb/v1alpha1",
  kind: "Agent",
  metadata: { name: "a" },
  spec: { modelBinding: "m", instructions: "i" },
};

const fixtureFile = (
  name: string,
  fixture: FixtureFile["fixture"],
): FixtureFile => ({
  name,
  fixture,
});

describe("conformance runner", () => {
  it("fails unknown levels such as the reserved semantic level", () => {
    const result = runFixture(
      fixtureFile("workflow/valid-x.json", {
        level: "semantic",
        expect: { valid: true },
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.failures[0]).toMatch(/unknown fixture level "semantic"/);
  });

  it("fails a fixture without a boolean expect.valid", () => {
    expect(
      runFixture(fixtureFile("x/valid-x.json", { level: "schema" })).passed,
    ).toBe(false);
  });

  it("fails when the file name prefix disagrees with expect.valid", () => {
    const result = runFixture(
      fixtureFile("agent/invalid-x.json", {
        level: "schema",
        expect: { valid: true },
        document: agentDoc,
      }),
    );
    expect(result.failures).toEqual([
      "file name prefix disagrees with expect.valid",
    ]);
  });

  it("fails a wrong verdict and an unmatched locator, naming locators only", () => {
    const result = runFixture(
      fixtureFile("agent/invalid-x.json", {
        level: "schema",
        expect: {
          valid: false,
          errors: [{ instancePath: "/spec", keyword: "required" }],
        },
        document: agentDoc,
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.defineAgentParity).toBe(false);
    expect(result.failures.join("\n")).toMatch(
      /validateSpec: valid=true, expected false/,
    );
    expect(result.failures.join("\n")).toMatch(
      /expected error .* not reported; got errors: none/,
    );
    expect(result.failures.join("\n")).not.toContain('"i"');
  });

  it("matches loader warnings against warning-severity issues only", () => {
    const source =
      "# ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE\n" + JSON.stringify(agentDoc);
    const ok = runFixture(
      fixtureFile("loader/valid-x.json", {
        level: "loader",
        format: "yaml",
        source,
        expect: {
          valid: true,
          warnings: [{ code: "possible-secret", line: 1 }],
        },
      }),
    );
    expect(ok.failures).toEqual([]);
    const wrong = runFixture(
      fixtureFile("loader/valid-x.json", {
        level: "loader",
        format: "yaml",
        source,
        expect: { valid: true, errors: [{ code: "possible-secret" }] },
      }),
    );
    expect(wrong.failures[0]).toMatch(/expected error .* not reported/);
  });

  it("fails malformed loader and schema fixtures", () => {
    const loader = runFixture(
      fixtureFile("loader/invalid-x.json", {
        level: "loader",
        expect: { valid: false, errors: [] },
      }),
    );
    expect(loader.failures).toEqual(
      expect.arrayContaining([
        "loader fixture has no string source",
        "loader fixture has no yaml|json format",
      ]),
    );
    const schema = runFixture(
      fixtureFile("x/invalid-x.json", {
        level: "schema",
        expect: { valid: false, errors: [] },
      }),
    );
    expect(schema.failures).toContain("schema fixture has no document");
  });

  it("matches a locator only when every given field is equal", () => {
    const issue = {
      code: "schema",
      severity: "error",
      message: "m",
      instancePath: "/a",
      keyword: "type",
    } as const;
    expect(locatorMatches({ instancePath: "/a" }, issue)).toBe(true);
    expect(locatorMatches({ instancePath: "/a", keyword: "type" }, issue)).toBe(
      true,
    );
    expect(locatorMatches({ instancePath: "/a", property: "x" }, issue)).toBe(
      false,
    );
    expect(locatorMatches({ instancePath: "/b" }, issue)).toBe(false);
  });

  it("summarises results and fails on an empty fixture set", () => {
    const summary = runConformance([
      fixtureFile("agent/valid-x.json", {
        level: "schema",
        expect: { valid: true },
        document: agentDoc,
      }),
      fixtureFile("workflow/valid-y.json", {
        level: "semantic",
        expect: { valid: true },
      }),
    ]);
    expect(summary).toMatchObject({
      total: 2,
      passed: 1,
      byLevel: {
        schema: { total: 1, passed: 1 },
        semantic: { total: 1, passed: 0 },
      },
      defineAgentParity: { total: 1, passed: 1 },
    });
    const text = formatSummary(summary);
    expect(text).toContain("FAIL workflow/valid-y.json");
    expect(text).toContain("defineAgent parity: 1/1 passed");
    expect(text.split("\n").at(-1)).toBe("FAIL: 1/2 fixtures passed");
    expect(() => runConformance([])).toThrow(/no conformance fixtures/);
  });

  it("fails when a fixtures directory has no fixtures", () => {
    const empty = mkdtempSync(join(tmpdir(), "sirb-core-fixtures-"));
    try {
      expect(() => discoverFixtures(empty)).toThrow(
        /no conformance fixtures found/,
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
    expect(fixturesDir()).toBe(
      join(specPackageDir(), "conformance", "fixtures"),
    );
  });
});
