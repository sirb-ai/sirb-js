// Can the defineAgent parity check fail? `defineAgent` is replaced by a wrapper
// that either calls the real one or returns a tampered result, and the runner
// must notice each kind of tampering.
import { describe, expect, it, vi } from "vitest";
import { SirbSpecError } from "../src/issues.js";
import {
  runFixture,
  type Fixture,
  type FixtureFile,
} from "../src/conformance.js";

type Define = (input: unknown, options?: unknown) => unknown;
const hooks = vi.hoisted(() => ({ override: undefined as Define | undefined }));

vi.mock("../src/define-agent.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/define-agent.js")>();
  return {
    ...actual,
    defineAgent: (input: never, options?: never) =>
      hooks.override
        ? hooks.override(input, options)
        : actual.defineAgent(input, options),
  };
});

const agentDoc = {
  apiVersion: "sirb/v1alpha1",
  kind: "Agent",
  metadata: { name: "a", labels: { team: "x" } },
  spec: { modelBinding: "m", instructions: "i", tools: ["t1"] },
};
const validFixture: FixtureFile = {
  name: "agent/valid-a.json",
  fixture: { level: "schema", document: agentDoc, expect: { valid: true } },
};
const invalidFixture: FixtureFile = {
  name: "agent/invalid-a.json",
  fixture: {
    level: "schema",
    document: { ...agentDoc, spec: { instructions: "i" } },
    expect: {
      valid: false,
      errors: [{ instancePath: "/spec", keyword: "required" }],
    },
  } satisfies Fixture,
};

const freezeDeep = <T>(v: T): T => {
  if (v !== null && typeof v === "object") {
    Object.values(v).forEach(freezeDeep);
    Object.freeze(v);
  }
  return v;
};
const clone = (v: unknown): Record<string, any> =>
  JSON.parse(JSON.stringify(v)) as Record<string, any>;

function run(file: FixtureFile, override?: Define) {
  hooks.override = override;
  try {
    return runFixture(file);
  } finally {
    hooks.override = undefined;
  }
}
const text = (r: { failures: readonly string[] }): string =>
  r.failures.join("\n");

describe("the unmodified defineAgent passes the parity check (control)", () => {
  it("valid and invalid Agent fixtures", () => {
    expect(run(validFixture)).toMatchObject({
      passed: true,
      defineAgentParity: true,
    });
    expect(run(invalidFixture)).toMatchObject({
      passed: true,
      defineAgentParity: true,
    });
  });
});

describe("parity mismatches on a valid fixture make the runner fail", () => {
  // Every tamper returns a deep-frozen result so only the named defect shows.
  const tampered = (change: (doc: Record<string, any>) => void): Define => {
    return () => {
      const doc = clone(agentDoc);
      change(doc);
      return freezeDeep(doc);
    };
  };

  it.each<[string, (doc: Record<string, any>) => void]>([
    ["an extra top-level key", (d) => (d.status = {})],
    ["an extra spec key", (d) => (d.spec.extra = 1)],
    ["an extra metadata key", (d) => (d.metadata.annotations = {})],
    ["a wrong apiVersion", (d) => (d.apiVersion = "sirb/v1")],
    ["a wrong kind", (d) => (d.kind = "Tool")],
    ["a missing key", (d) => delete d.metadata.labels],
    ["a changed value", (d) => (d.spec.instructions = "other")],
    ["a changed array", (d) => d.spec.tools.push("t2")],
  ])("%s", (_label, change) => {
    const result = run(validFixture, tampered(change));
    expect(result.passed).toBe(false);
    expect(result.defineAgentParity).toBe(false);
    expect(text(result)).toMatch(/defineAgent result is not deep-equal/);
    expect(text(result)).toMatch(/defineAgent\(\{ metadata, spec \}\)/);
  });

  it("a result with a different prototype", () => {
    const result = run(validFixture, () =>
      freezeDeep(Object.assign(Object.create(null), clone(agentDoc))),
    );
    expect(text(result)).toMatch(/not deep-equal/);
  });

  it("a result that is not frozen at all", () => {
    const result = run(validFixture, () => clone(agentDoc));
    expect(result.passed).toBe(false);
    expect(text(result)).toMatch(/not deeply frozen/);
  });

  it("a result that is only frozen at the top level", () => {
    const result = run(validFixture, () => Object.freeze(clone(agentDoc)));
    expect(result.passed).toBe(false);
    expect(text(result)).toMatch(/not deeply frozen/);
  });

  it("a result that is deep-equal but does not survive a JSON round trip", () => {
    const result = run(validFixture, () => {
      const doc = clone(agentDoc);
      // Non-enumerable, so deep equality ignores it; JSON.stringify calls it.
      Object.defineProperty(doc, "toJSON", {
        value: () => ({ ...doc, kind: "Tool" }),
      });
      return freezeDeep(doc);
    });
    expect(result.passed).toBe(false);
    expect(text(result)).toMatch(/does not round-trip through loadSpec/);
  });

  it("only the shorthand call is wrong", () => {
    const result = run(validFixture, (input) => {
      const given = input as Record<string, unknown>;
      // Correct when the whole document is passed, wrong for { metadata, spec }.
      return freezeDeep(
        "apiVersion" in given
          ? clone(agentDoc)
          : { ...clone(agentDoc), kind: "Tool" },
      );
    });
    expect(text(result)).toBe(
      "defineAgent({ metadata, spec }) is not deep-equal to the fixture document",
    );
  });

  it("defineAgent rejects a valid document", () => {
    const result = run(validFixture, () => {
      throw new SirbSpecError([
        { code: "schema", severity: "error", message: "m", instancePath: "/x" },
      ]);
    });
    expect(result.passed).toBe(false);
    expect(text(result)).toMatch(/defineAgent: valid=false, expected true/);
  });

  it.each([
    [
      "a TypeError",
      () => new TypeError("boom"),
      /threw TypeError, not SirbSpecError/,
    ],
    ["undefined", () => undefined, /threw Error, not SirbSpecError/],
    ["a string", () => "boom", /threw (String|string|Error)/],
  ])("defineAgent throws %s instead of SirbSpecError", (_l, make, pattern) => {
    const result = run(validFixture, () => {
      throw make();
    });
    expect(result.passed).toBe(false);
    expect(text(result)).toMatch(pattern);
  });
});

describe("parity mismatches on an invalid fixture make the runner fail", () => {
  it("defineAgent accepts an invalid document", () => {
    const result = run(invalidFixture, () => freezeDeep(clone(agentDoc)));
    expect(result.passed).toBe(false);
    expect(result.defineAgentParity).toBe(false);
    expect(text(result)).toMatch(/defineAgent: valid=true, expected false/);
  });

  it("defineAgent rejects it with the wrong locators", () => {
    const result = run(invalidFixture, () => {
      throw new SirbSpecError([
        {
          code: "schema",
          severity: "error",
          message: "m",
          instancePath: "/else",
          keyword: "type",
        },
      ]);
    });
    expect(result.passed).toBe(false);
    expect(text(result)).toMatch(
      /expected error .*"\/spec".* not reported; got errors: \[schema\] \/else type/,
    );
  });

  it("defineAgent rejects it with only a warning", () => {
    const result = run(invalidFixture, () => {
      throw new SirbSpecError([
        {
          code: "possible-secret",
          severity: "warning",
          message: "m",
          instancePath: "/spec",
        },
      ]);
    });
    expect(result.passed).toBe(false);
    expect(text(result)).toMatch(/not reported; got errors: none/);
  });
});
