/**
 * Runs the sirb-spec conformance fixtures through the public API of @sirb/core
 * (`validateSpec`, `loadSpec`, `defineAgent`), following conformance/README.md
 * and ADR-0006. Not re-exported from the package index: it is used by the test
 * suite and by `pnpm --filter @sirb/core conformance`.
 *
 * Failure messages name locators and codes only, never document content.
 */
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { defineAgent } from "./define-agent.js";
import { SirbSpecError, describeIssue, type SpecIssue } from "./issues.js";
import { loadSpec, validateSpec } from "./load.js";

export type Locator = Readonly<Record<string, unknown>>;

export interface Fixture {
  readonly description?: unknown;
  readonly requirements?: unknown;
  readonly level?: unknown;
  readonly expect?: {
    readonly valid?: unknown;
    readonly errors?: readonly Locator[];
    readonly warnings?: readonly Locator[];
  };
  readonly document?: unknown;
  readonly source?: unknown;
  readonly format?: unknown;
}

export interface FixtureFile {
  /** Path relative to the fixtures directory, with `/` separators. */
  readonly name: string;
  readonly fixture: Fixture;
}

export type ConformanceLevel = "schema" | "loader";

export interface FixtureResult {
  readonly name: string;
  readonly level: string;
  readonly passed: boolean;
  readonly failures: readonly string[];
  /** Set for schema-level fixtures whose document has `kind: Agent`. */
  readonly defineAgentParity?: boolean;
}

export interface ConformanceSummary {
  readonly total: number;
  readonly passed: number;
  readonly byLevel: Readonly<Record<string, { total: number; passed: number }>>;
  readonly defineAgentParity: {
    readonly total: number;
    readonly passed: number;
  };
  readonly results: readonly FixtureResult[];
}

const SPEC_PACKAGE = "@sirb/spec";

function resolveSpecEntry(): string {
  // `conformance/` ships in the package but is not in its `exports`, so resolve
  // the entry point and walk up to the package root.
  try {
    return fileURLToPath(import.meta.resolve(SPEC_PACKAGE));
  } catch {
    return createRequire(import.meta.url).resolve(SPEC_PACKAGE);
  }
}

/** The root directory of the installed `@sirb/spec` package. */
export function specPackageDir(): string {
  let dir = dirname(resolveSpecEntry());
  for (;;) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(dir, "package.json"), "utf8"),
      ) as { name?: unknown };
      if (pkg.name === SPEC_PACKAGE) return dir;
    } catch {
      // no package.json here; keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir)
      throw new Error(`cannot locate the ${SPEC_PACKAGE} package root`);
    dir = parent;
  }
}

/** Default fixtures directory: `conformance/fixtures` of the installed `@sirb/spec`. */
export function fixturesDir(): string {
  return join(specPackageDir(), "conformance", "fixtures");
}

/** Reads every `*.json` fixture below `dir`, sorted by name. Throws when there are none. */
export function discoverFixtures(dir: string = fixturesDir()): FixtureFile[] {
  const files = readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".json"))
    .sort();
  if (files.length === 0)
    throw new Error(`no conformance fixtures found in ${dir}`);
  return files.map((f) => ({
    name: relative(dir, join(dir, f)).split(sep).join("/"),
    fixture: JSON.parse(readFileSync(join(dir, f), "utf8")) as Fixture,
  }));
}

/** A locator matches an issue when every field it gives is equal (ADR-0006). */
export function locatorMatches(locator: Locator, issue: SpecIssue): boolean {
  const actual = issue as unknown as Record<string, unknown>;
  return Object.entries(locator).every(([key, value]) => actual[key] === value);
}

function checkLocators(
  kind: "error" | "warning",
  expected: readonly Locator[] | undefined,
  issues: readonly SpecIssue[],
  failures: string[],
): void {
  const pool = issues.filter((i) => i.severity === kind);
  for (const locator of expected ?? []) {
    if (!pool.some((i) => locatorMatches(locator, i))) {
      failures.push(
        `expected ${kind} ${JSON.stringify(locator)} not reported; got ${kind}s: ` +
          (pool.length ? pool.map(describeIssue).join(", ") : "none"),
      );
    }
  }
}

function checkVerdict(
  what: string,
  actual: boolean,
  expected: boolean,
  issues: readonly SpecIssue[],
  failures: string[],
): void {
  if (actual !== expected) {
    failures.push(
      `${what}: valid=${actual}, expected ${expected}; issues: ` +
        (issues.length ? issues.map(describeIssue).join(", ") : "none"),
    );
  }
}

/** True when the value and everything inside it is frozen (iterative). */
export function isDeepFrozen(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== "object") continue;
    if (!Object.isFrozen(node)) return false;
    for (const child of Object.values(node)) stack.push(child);
  }
  return true;
}

function isAgentDocument(
  document: unknown,
): document is Record<string, unknown> {
  return (
    document !== null &&
    typeof document === "object" &&
    !Array.isArray(document) &&
    (document as Record<string, unknown>).kind === "Agent"
  );
}

function tryDefineAgent(input: Record<string, unknown>): {
  defined?: unknown;
  error?: unknown;
} {
  try {
    // Fixture documents are untyped JSON; defineAgent validates at runtime.
    return { defined: defineAgent(input as never) };
  } catch (error) {
    return { error: error ?? new Error("defineAgent threw a nullish value") };
  }
}

/**
 * defineAgent parity: succeeds iff the fixture is valid, and then returns a
 * frozen object deep-equal to the fixture document that also round-trips
 * through `loadSpec`. On failure it reports the fixture's error locators.
 */
function checkDefineAgent(
  document: Record<string, unknown>,
  expectValid: boolean,
  expectedErrors: readonly Locator[] | undefined,
): string[] {
  const failures: string[] = [];
  const { defined, error } = tryDefineAgent(document);
  if (error !== undefined && !(error instanceof SirbSpecError)) {
    return [
      `defineAgent threw ${(error as Error)?.name ?? typeof error}, not SirbSpecError`,
    ];
  }
  const issues = error instanceof SirbSpecError ? error.issues : [];
  checkVerdict(
    "defineAgent",
    error === undefined,
    expectValid,
    issues,
    failures,
  );
  if (!expectValid) {
    checkLocators("error", expectedErrors, issues, failures);
    return failures;
  }
  if (error !== undefined) return failures;

  if (!isDeepStrictEqual(defined, document))
    failures.push(
      "defineAgent result is not deep-equal to the fixture document",
    );
  if (!isDeepFrozen(defined))
    failures.push("defineAgent result is not deeply frozen");
  const short = tryDefineAgent({
    metadata: document.metadata,
    spec: document.spec,
  });
  if (short.error !== undefined || !isDeepStrictEqual(short.defined, document))
    failures.push(
      "defineAgent({ metadata, spec }) is not deep-equal to the fixture document",
    );
  const reloaded = loadSpec(JSON.stringify(defined), { format: "json" });
  if (!reloaded.valid || !isDeepStrictEqual(reloaded.documents[0], document)) {
    failures.push(
      "JSON.stringify(defineAgent(...)) does not round-trip through loadSpec",
    );
  }
  return failures;
}

/** Runs one fixture. Unknown levels (such as the reserved `semantic`) fail. */
export function runFixture({ name, fixture }: FixtureFile): FixtureResult {
  const failures: string[] = [];
  const level =
    typeof fixture.level === "string" ? fixture.level : String(fixture.level);
  const expect = fixture.expect;
  if (typeof expect?.valid !== "boolean") {
    return {
      name,
      level,
      passed: false,
      failures: ["fixture has no boolean expect.valid"],
    };
  }
  const expectValid = expect.valid;
  if (!basename(name).startsWith(expectValid ? "valid-" : "invalid-")) {
    failures.push("file name prefix disagrees with expect.valid");
  }

  let defineAgentParity: boolean | undefined;
  if (level === "schema") {
    if (!("document" in fixture))
      failures.push("schema fixture has no document");
    const result = validateSpec(fixture.document);
    checkVerdict(
      "validateSpec",
      result.valid,
      expectValid,
      result.issues,
      failures,
    );
    checkLocators("error", expect.errors, result.issues, failures);
    // A schema fixture must get the same verdict from the loader for both
    // encodings. JSON is a subset of YAML 1.2, so the same text also runs
    // through the YAML parser.
    const text = JSON.stringify(fixture.document) ?? "";
    for (const format of ["json", "yaml"] as const) {
      const loaded = loadSpec(text, { format });
      checkVerdict(
        `loadSpec (${format} encoding)`,
        loaded.valid,
        expectValid,
        loaded.issues,
        failures,
      );
    }
    if (isAgentDocument(fixture.document)) {
      const parity = checkDefineAgent(
        fixture.document,
        expectValid,
        expect.errors,
      );
      defineAgentParity = parity.length === 0;
      failures.push(...parity);
    }
  } else if (level === "loader") {
    if (typeof fixture.source !== "string")
      failures.push("loader fixture has no string source");
    if (fixture.format !== "yaml" && fixture.format !== "json")
      failures.push("loader fixture has no yaml|json format");
    const result = loadSpec(String(fixture.source), {
      format: fixture.format as "yaml" | "json",
    });
    checkVerdict(
      "loadSpec",
      result.valid,
      expectValid,
      result.issues,
      failures,
    );
    checkLocators("error", expect.errors, result.issues, failures);
    checkLocators("warning", expect.warnings, result.issues, failures);
  } else {
    failures.push(
      `unknown fixture level "${level}"; this runner supports schema and loader`,
    );
  }

  return {
    name,
    level,
    passed: failures.length === 0,
    failures,
    ...(defineAgentParity !== undefined && { defineAgentParity }),
  };
}

/** Runs every fixture. Throws when `files` is empty. */
export function runConformance(
  files: readonly FixtureFile[] = discoverFixtures(),
): ConformanceSummary {
  if (files.length === 0) throw new Error("no conformance fixtures to run");
  const results = files.map(runFixture);
  const byLevel: Record<string, { total: number; passed: number }> = {};
  for (const r of results) {
    const entry = (byLevel[r.level] ??= { total: 0, passed: 0 });
    entry.total++;
    if (r.passed) entry.passed++;
  }
  const parity = results.filter((r) => r.defineAgentParity !== undefined);
  return {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    byLevel,
    defineAgentParity: {
      total: parity.length,
      passed: parity.filter((r) => r.defineAgentParity).length,
    },
    results,
  };
}

/** A plain-text report: one line per failing fixture, then the totals. */
export function formatSummary(summary: ConformanceSummary): string {
  const lines: string[] = [];
  for (const r of summary.results) {
    if (r.passed) continue;
    lines.push(`FAIL ${r.name}`);
    for (const f of r.failures) lines.push(`  - ${f}`);
  }
  for (const [level, { total, passed }] of Object.entries(
    summary.byLevel,
  ).sort()) {
    lines.push(`level ${level}: ${passed}/${total} passed`);
  }
  const { defineAgentParity: p } = summary;
  lines.push(`defineAgent parity: ${p.passed}/${p.total} passed`);
  lines.push(
    `${summary.passed === summary.total ? "PASS" : "FAIL"}: ${summary.passed}/${summary.total} fixtures passed`,
  );
  return lines.join("\n");
}
