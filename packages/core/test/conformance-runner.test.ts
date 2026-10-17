// Tests of the conformance runner itself, against synthetic fixtures (in memory
// or in a temp directory). They do not depend on the installed fixture set, so a
// runner that always says "pass" cannot hide behind a green real-fixture run.
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  discoverFixtures,
  fixturesDir,
  formatSummary,
  isDeepFrozen,
  locatorMatches,
  runConformance,
  runFixture,
  type Fixture,
  type FixtureFile,
} from "../src/conformance.js";

const agentDoc = {
  apiVersion: "sirb/v1alpha1",
  kind: "Agent",
  metadata: { name: "a" },
  spec: { modelBinding: "m", instructions: "i" },
};
const badAgentDoc = { ...agentDoc, spec: { instructions: "i" } };
const missingModelBinding = {
  instancePath: "/spec",
  keyword: "required",
  property: "modelBinding",
};

const fx = (name: string, fixture: Fixture): FixtureFile => ({ name, fixture });
const schemaFixture = (
  name: string,
  document: unknown,
  expect: Fixture["expect"],
): FixtureFile => fx(name, { level: "schema", document, expect });
const loaderFixture = (
  name: string,
  source: unknown,
  format: unknown,
  expect: Fixture["expect"],
): FixtureFile => fx(name, { level: "loader", source, format, expect });
const joined = (r: { failures: readonly string[] }): string =>
  r.failures.join("\n");

describe("runFixture verdicts", () => {
  it("passes a correct valid and a correct invalid schema fixture", () => {
    expect(
      runFixture(schemaFixture("agent/valid-a.json", agentDoc, { valid: true }))
        .failures,
    ).toEqual([]);
    const result = runFixture(
      schemaFixture("agent/invalid-a.json", badAgentDoc, {
        valid: false,
        errors: [missingModelBinding],
      }),
    );
    expect(result).toMatchObject({
      passed: true,
      failures: [],
      defineAgentParity: true,
    });
  });

  it("fails when a valid-expected schema fixture is invalid, on every API", () => {
    const result = runFixture(
      schemaFixture("agent/valid-a.json", badAgentDoc, { valid: true }),
    );
    expect(result.passed).toBe(false);
    const text = joined(result);
    expect(text).toMatch(/validateSpec: valid=false, expected true/);
    expect(text).toMatch(/loadSpec \(json encoding\): valid=false/);
    expect(text).toMatch(/loadSpec \(yaml encoding\): valid=false/);
    expect(text).toMatch(/defineAgent: valid=false, expected true/);
    expect(result.defineAgentParity).toBe(false);
  });

  it("fails when an invalid-expected schema fixture is valid, on every API", () => {
    const result = runFixture(
      schemaFixture("agent/invalid-a.json", agentDoc, {
        valid: false,
        errors: [],
      }),
    );
    expect(result.passed).toBe(false);
    const text = joined(result);
    expect(text).toMatch(/validateSpec: valid=true, expected false/);
    expect(text).toMatch(/loadSpec \(json encoding\): valid=true/);
    expect(text).toMatch(/loadSpec \(yaml encoding\): valid=true/);
    expect(text).toMatch(/defineAgent: valid=true, expected false/);
  });

  it("fails a loader fixture with the wrong verdict in either direction", () => {
    const yaml = JSON.stringify(agentDoc);
    const wrongInvalid = runFixture(
      loaderFixture("loader/invalid-x.json", yaml, "yaml", {
        valid: false,
        errors: [],
      }),
    );
    expect(joined(wrongInvalid)).toMatch(
      /loadSpec: valid=true, expected false/,
    );
    const wrongValid = runFixture(
      loaderFixture("loader/valid-x.json", "a: &x 1\nb: *x\n", "yaml", {
        valid: true,
      }),
    );
    expect(joined(wrongValid)).toMatch(/loadSpec: valid=false, expected true/);
  });

  it("passes a loader fixture whose verdict and locators match", () => {
    const result = runFixture(
      loaderFixture("loader/invalid-alias.json", "a: &x 1\nb: *x\n", "yaml", {
        valid: false,
        errors: [{ code: "yaml-alias" }],
      }),
    );
    expect(result).toMatchObject({ passed: true, failures: [] });
    expect(result.defineAgentParity).toBeUndefined();
  });

  it("does not run the defineAgent parity check on non-Agent documents", () => {
    const memory = {
      apiVersion: "sirb/v1alpha1",
      kind: "Memory",
      metadata: { name: "m" },
      spec: { type: "buffer", scope: "session" },
    };
    const result = runFixture(
      schemaFixture("memory/valid-m.json", memory, { valid: true }),
    );
    expect(result.failures).toEqual([]);
    expect(result.defineAgentParity).toBeUndefined();
  });

  it("treats a non-object schema document without throwing", () => {
    for (const document of [null, "Agent", 42, [agentDoc]]) {
      const result = runFixture(
        schemaFixture("resource/invalid-x.json", document, {
          valid: false,
          errors: [{ code: "not-an-object" }],
        }),
      );
      // Verdicts agree (invalid everywhere); the schema-level locator is a loader code.
      expect(result.defineAgentParity).toBeUndefined();
      expect(joined(result)).not.toMatch(/valid=true/);
    }
  });
});

describe("runFixture locators", () => {
  const invalid = (errors: Fixture["expect"] extends infer E ? E : never) =>
    runFixture(schemaFixture("agent/invalid-a.json", badAgentDoc, errors));

  it("fails when an expected locator matches no reported error", () => {
    const result = invalid({
      valid: false,
      errors: [{ instancePath: "/spec/nope", keyword: "required" }],
    });
    expect(result.passed).toBe(false);
    expect(joined(result)).toMatch(
      /expected error .*\/spec\/nope.* not reported/,
    );
  });

  it("requires every field of a locator to match the same error", () => {
    // /spec exists and `required` exists, but only as one error with both.
    const ok = invalid({
      valid: false,
      errors: [{ instancePath: "/spec", keyword: "required" }],
    });
    expect(ok.passed).toBe(true);
    for (const wrong of [
      { instancePath: "/spec", keyword: "type" },
      { instancePath: "/spec", keyword: "required", property: "instructions" },
      { instancePath: "/", keyword: "required" },
      { instancePath: "/spec", keyword: "required", code: "literal-secret" },
      { instancePath: "/spec", keyword: "required", document: 0 },
    ]) {
      expect(invalid({ valid: false, errors: [wrong] }).passed).toBe(false);
    }
  });

  it("fails once per unmatched locator and tolerates extra reported errors", () => {
    const result = invalid({
      valid: false,
      errors: [missingModelBinding, { instancePath: "/x" }, { keyword: "y" }],
    });
    // Each unmatched locator is reported by validateSpec and by defineAgent;
    // the matched one is never reported.
    const unmatched = result.failures.filter((f) => f.includes("not reported"));
    expect(unmatched).toHaveLength(4);
    expect(unmatched.filter((f) => f.includes('"/x"'))).toHaveLength(2);
    expect(unmatched.filter((f) => f.includes('"y"'))).toHaveLength(2);
    expect(unmatched.some((f) => f.includes("modelBinding"))).toBe(false);
    // Extra reported errors are fine: one locator for a document with several errors.
    const many = runFixture(
      schemaFixture(
        "agent/invalid-a.json",
        { ...badAgentDoc, metadata: { name: "Bad" } },
        { valid: false, errors: [missingModelBinding] },
      ),
    );
    expect(many.failures).toEqual([]);
  });

  it("names locators and codes only in failure text, never document values", () => {
    const secret = "FAKE-never-print-me";
    const doc = {
      ...badAgentDoc,
      spec: { instructions: secret },
      metadata: { name: secret },
    };
    const result = runFixture(
      schemaFixture("agent/invalid-a.json", doc, {
        valid: false,
        errors: [{ instancePath: "/nope" }],
      }),
    );
    expect(result.passed).toBe(false);
    expect(joined(result)).not.toContain(secret);
    expect(
      formatSummary(
        runConformance([
          schemaFixture("agent/invalid-a.json", doc, {
            valid: false,
            errors: [{ instancePath: "/nope" }],
          }),
        ]),
      ),
    ).not.toContain(secret);
  });

  it("matches warnings against warnings and errors against errors only", () => {
    const source = `# ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE\n${JSON.stringify(agentDoc)}`;
    const run = (expect: Fixture["expect"]) =>
      runFixture(loaderFixture("loader/valid-w.json", source, "yaml", expect));
    expect(
      run({ valid: true, warnings: [{ code: "possible-secret", line: 1 }] })
        .failures,
    ).toEqual([]);
    // A warning that is not reported fails the fixture.
    expect(
      run({ valid: true, warnings: [{ code: "possible-secret", line: 2 }] })
        .passed,
    ).toBe(false);
    expect(
      run({ valid: true, warnings: [{ code: "literal-secret" }] }).passed,
    ).toBe(false);
    // A warning cannot satisfy an error locator, and vice versa.
    expect(
      run({ valid: true, errors: [{ code: "possible-secret" }] }).passed,
    ).toBe(false);
    const withError = runFixture(
      loaderFixture(
        "loader/invalid-w.json",
        `${source}`.replace("modelBinding", "modelBindin"),
        "yaml",
        { valid: false, warnings: [{ code: "schema" }] },
      ),
    );
    expect(withError.passed).toBe(false);
  });

  it("an expected warning on a schema-level fixture is not silently invented", () => {
    // Schema fixtures have no warnings; only errors are matched there.
    const result = runFixture(
      schemaFixture("agent/valid-a.json", agentDoc, {
        valid: true,
        warnings: [{ code: "possible-secret" }],
      }),
    );
    expect(result.passed).toBe(true);
  });

  it("locatorMatches: empty locator matches any issue, missing fields never match", () => {
    const issue = { code: "schema", severity: "error", message: "m" } as const;
    expect(locatorMatches({}, issue)).toBe(true);
    expect(locatorMatches({ keyword: "required" }, issue)).toBe(false);
    expect(locatorMatches({ code: "schema" }, issue)).toBe(true);
    expect(locatorMatches({ code: "Schema" }, issue)).toBe(false);
    expect(locatorMatches({ line: undefined, code: "schema" }, issue)).toBe(
      true,
    );
  });
});

describe("runFixture levels and shape", () => {
  it.each([
    ["semantic", "semantic"],
    ["runtime", "runtime"],
    ["wrong case", "Schema"],
    ["empty", ""],
    ["a number", 1],
    ["null", null],
  ])("fails an unknown level (%s)", (_label, level) => {
    const result = runFixture(
      fx("agent/valid-a.json", {
        level,
        document: agentDoc,
        expect: { valid: true },
      }),
    );
    expect(result.passed).toBe(false);
    expect(joined(result)).toMatch(
      /unknown fixture level ".*"; this runner supports schema and loader/,
    );
  });

  it("fails a fixture with no level at all, naming it undefined", () => {
    const result = runFixture(
      fx("agent/valid-a.json", { document: agentDoc, expect: { valid: true } }),
    );
    expect(result).toMatchObject({ level: "undefined", passed: false });
  });

  it.each([
    ["missing", undefined],
    ["a string", "true"],
    ["a number", 1],
    ["null", null],
  ])("fails when expect.valid is %s", (_label, valid) => {
    const result = runFixture(
      fx("agent/valid-a.json", {
        level: "schema",
        document: agentDoc,
        expect:
          valid === undefined ? {} : { valid: valid as unknown as boolean },
      }),
    );
    expect(result).toMatchObject({
      passed: false,
      failures: ["fixture has no boolean expect.valid"],
    });
    expect(
      runFixture(fx("agent/valid-a.json", { level: "schema" })).passed,
    ).toBe(false);
  });

  it.each([
    ["valid fixture named invalid-", "agent/invalid-a.json", true],
    ["invalid fixture named valid-", "agent/valid-a.json", false],
    ["no prefix", "agent/a.json", true],
    ["prefix without dash", "agent/validity-a.json", true],
    ["prefix only on a directory", "valid-dir/a.json", true],
  ])("fails the file name rule: %s", (_label, name, valid) => {
    const doc = valid ? agentDoc : badAgentDoc;
    const result = runFixture(
      schemaFixture(name, doc, { valid, errors: valid ? undefined : [] }),
    );
    expect(result.failures).toEqual([
      "file name prefix disagrees with expect.valid",
    ]);
  });

  it("uses the base name, so a nested directory path still works", () => {
    const result = runFixture(
      schemaFixture("deep/er/valid-a.json", agentDoc, { valid: true }),
    );
    expect(result.failures).toEqual([]);
  });

  it("fails malformed loader fixtures even when the loader verdict happens to match", () => {
    for (const [source, format, message] of [
      [undefined, "yaml", "loader fixture has no string source"],
      [42, "yaml", "loader fixture has no string source"],
      [
        JSON.stringify(agentDoc),
        "toml",
        "loader fixture has no yaml|json format",
      ],
      [
        JSON.stringify(agentDoc),
        undefined,
        "loader fixture has no yaml|json format",
      ],
    ] as const) {
      const result = runFixture(
        loaderFixture("loader/valid-m.json", source, format, { valid: true }),
      );
      expect(result.passed).toBe(false);
      expect(result.failures).toContain(message);
    }
  });

  it("fails a schema fixture that has no document key", () => {
    const result = runFixture(
      fx("agent/invalid-a.json", {
        level: "schema",
        expect: { valid: false, errors: [] },
      }),
    );
    expect(result.failures).toContain("schema fixture has no document");
  });
});

describe("defineAgent parity checks the real defineAgent", () => {
  it("reports parity per Agent fixture and leaves other kinds out", () => {
    const summary = runConformance([
      schemaFixture("agent/valid-a.json", agentDoc, { valid: true }),
      schemaFixture("agent/invalid-a.json", badAgentDoc, {
        valid: false,
        errors: [missingModelBinding],
      }),
      schemaFixture(
        "agent/invalid-b.json",
        { ...agentDoc, kind: "Tool" },
        {
          valid: false,
          errors: [{ instancePath: "/kind", keyword: "const" }],
        },
      ),
    ]);
    expect(summary.passed).toBe(2);
    // The Tool-kind document is not an Agent document, so no parity check ran for it.
    expect(summary.defineAgentParity).toEqual({ total: 2, passed: 2 });
  });

  it("isDeepFrozen sees a shallow freeze", () => {
    expect(isDeepFrozen(Object.freeze({ a: { b: 1 } }))).toBe(false);
    expect(isDeepFrozen(Object.freeze({ a: Object.freeze([1]) }))).toBe(true);
    expect(isDeepFrozen(Object.freeze({ a: [Object.freeze({})] }))).toBe(false);
    expect(isDeepFrozen("x")).toBe(true);
  });
});

describe("runConformance and formatSummary", () => {
  it("refuses an empty list", () => {
    expect(() => runConformance([])).toThrow(/no conformance fixtures to run/);
  });

  it("counts passes and failures by level and prints FAIL/PASS", () => {
    const pass = schemaFixture("agent/valid-a.json", agentDoc, { valid: true });
    const fail = schemaFixture("agent/valid-b.json", badAgentDoc, {
      valid: true,
    });
    const loaderPass = loaderFixture(
      "loader/invalid-a.json",
      "a: &x 1\nb: *x\n",
      "yaml",
      { valid: false, errors: [{ code: "yaml-alias" }] },
    );
    const all = runConformance([pass, loaderPass]);
    expect(all).toMatchObject({
      total: 2,
      passed: 2,
      byLevel: {
        schema: { total: 1, passed: 1 },
        loader: { total: 1, passed: 1 },
      },
    });
    expect(formatSummary(all).split("\n").at(-1)).toBe(
      "PASS: 2/2 fixtures passed",
    );

    const mixed = runConformance([pass, fail, loaderPass]);
    expect(mixed).toMatchObject({ total: 3, passed: 2 });
    expect(mixed.byLevel.schema).toEqual({ total: 2, passed: 1 });
    const text = formatSummary(mixed);
    expect(text).toContain("FAIL agent/valid-b.json");
    expect(text).not.toContain("FAIL agent/valid-a.json");
    expect(text).toContain("level loader: 1/1 passed");
    expect(text).toContain("level schema: 1/2 passed");
    expect(text.split("\n").at(-1)).toBe("FAIL: 2/3 fixtures passed");
  });

  it("a single failing fixture makes the whole run fail", () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      schemaFixture(`agent/valid-${i}.json`, agentDoc, { valid: true }),
    );
    many.push(
      fx("agent/valid-z.json", { level: "semantic", expect: { valid: true } }),
    );
    const summary = runConformance(many);
    expect(summary.passed).toBe(20);
    expect(summary.total).toBe(21);
  });
});

describe("discoverFixtures", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sirb-core-discover-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  const put = (rel: string, content: string): void => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  };
  const doc = (valid: boolean): string =>
    JSON.stringify({
      level: "schema",
      document: valid ? agentDoc : badAgentDoc,
      expect: valid ? { valid } : { valid, errors: [missingModelBinding] },
    });

  it("reads nested .json files in sorted order with / separators and ignores the rest", () => {
    put("b/valid-b.json", doc(true));
    put("a/invalid-a.json", doc(false));
    put("a/deeper/valid-c.json", doc(true));
    put("README.md", "# not a fixture");
    put("a/valid-a.json.bak", "{not json");
    put("a/valid-a.json5", "{not json");
    expect(discoverFixtures(dir).map((f) => f.name)).toEqual([
      "a/deeper/valid-c.json",
      "a/invalid-a.json",
      "b/valid-b.json",
    ]);
  });

  it("runs a discovered temp set end to end", () => {
    put("agent/valid-a.json", doc(true));
    put("agent/invalid-a.json", doc(false));
    const summary = runConformance(discoverFixtures(dir));
    expect(summary).toMatchObject({ total: 2, passed: 2 });
  });

  it("an on-disk fixture with a wrong verdict fails the run", () => {
    put("agent/valid-a.json", doc(false).replace('"errors"', '"ignored"'));
    const summary = runConformance(discoverFixtures(dir));
    expect(summary.passed).toBe(0);
  });

  it("throws when the directory has no fixtures, or only other file types", () => {
    expect(() => discoverFixtures(dir)).toThrow(
      /no conformance fixtures found/,
    );
    put("README.md", "x");
    put("a/fixture.yaml", "x: 1");
    expect(() => discoverFixtures(dir)).toThrow(
      /no conformance fixtures found/,
    );
  });

  it("throws for a directory that does not exist (a wrong fixtures path)", () => {
    expect(() => discoverFixtures(join(dir, "no-such-dir"))).toThrow(/ENOENT/);
  });

  it("throws on a fixture that is not valid JSON instead of skipping it", () => {
    put("agent/valid-a.json", "{ not json");
    expect(() => discoverFixtures(dir)).toThrow(SyntaxError);
  });

  it("runs a stray non-fixture JSON file as a failing fixture", () => {
    // For example fixture.schema.json lying next to the fixtures.
    put("fixture.schema.json", JSON.stringify({ type: "object" }));
    const [only] = discoverFixtures(dir);
    expect(only && runFixture(only).passed).toBe(false);
  });
});

describe("the installed fixture set", () => {
  it("is the large set the pin promises: both levels, every kind, both outcomes", () => {
    const files = discoverFixtures();
    // 166 at the pinned @sirb/spec commit. A drop means fixtures were lost.
    expect(files.length).toBeGreaterThanOrEqual(166);
    expect(new Set(files.map((f) => f.name)).size).toBe(files.length);
    expect(files.map((f) => f.name)).toEqual(
      [...files.map((f) => f.name)].sort(),
    );
    const dirs = new Set(files.map((f) => f.name.split("/")[0]));
    for (const d of [
      "agent",
      "knowledgebase",
      "loader",
      "memory",
      "modelbinding",
      "policy",
      "resource",
      "tool",
      "uibinding",
      "workflow",
    ])
      expect(dirs).toContain(d);
    for (const level of ["schema", "loader"])
      for (const valid of [true, false])
        expect(
          files.some(
            (f) =>
              f.fixture.level === level && f.fixture.expect?.valid === valid,
          ),
        ).toBe(true);
  });

  it("every installed fixture file is JSON under the fixtures directory", () => {
    expect(fixturesDir()).toMatch(/conformance[\\/]fixtures$/);
    for (const f of discoverFixtures())
      expect(f.name).toMatch(/^[^/]+\/.+\.json$/);
  });
});

describe("scripts/conformance.mjs", () => {
  // The script imports ../dist/conformance.js relative to itself. Copy it next
  // to a stub dist so its exit-code logic is tested without a build.
  const script = fileURLToPath(
    new URL("../scripts/conformance.mjs", import.meta.url),
  );
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "sirb-core-script-"));
    mkdirSync(join(root, "scripts"));
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "package.json"), '{"type":"module"}');
    copyFileSync(script, join(root, "scripts", "conformance.mjs"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const run = (stub: string) => {
    writeFileSync(join(root, "dist", "conformance.js"), stub);
    return spawnSync(
      process.execPath,
      [join(root, "scripts", "conformance.mjs")],
      {
        encoding: "utf8",
        cwd: root,
      },
    );
  };

  it("exits 0 and prints the report when every fixture passed", () => {
    const r = run(
      `export const runConformance = () => ({ passed: 3, total: 3 });
       export const formatSummary = (s) => "report " + s.passed;`,
    );
    expect(r).toMatchObject({ status: 0, stdout: "report 3\n" });
  });

  it("exits 1 and still prints the report when any fixture failed", () => {
    const r = run(
      `export const runConformance = () => ({ passed: 2, total: 3 });
       export const formatSummary = (s) => "report " + s.passed;`,
    );
    expect(r).toMatchObject({ status: 1, stdout: "report 2\n" });
  });

  it("exits 1 when the runner throws (such as no fixtures found)", () => {
    const r = run(
      `export const runConformance = () => { throw new Error("no conformance fixtures found in x"); };
       export const formatSummary = () => "";`,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(
      "conformance: no conformance fixtures found in x",
    );
  });

  it("exits 1 when the runner throws something that is not an Error", () => {
    const r = run(
      `export const runConformance = () => { throw "boom"; };
       export const formatSummary = () => "";`,
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("conformance: boom");
  });
});
