import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  SirbSpecError,
  defineAgent,
  loadSpec,
  type AgentDocument,
  type SpecIssue,
} from "../src/index.js";

const metadata = { name: "support-agent", labels: { team: "support" } };
const spec = {
  modelBinding: "claude-default",
  instructions: "You answer billing questions politely.",
  tools: ["ticket-lookup"],
  maxIterations: 5,
};

function thrown(fn: () => unknown): SirbSpecError {
  try {
    fn();
  } catch (e) {
    if (e instanceof SirbSpecError) return e;
    throw e;
  }
  throw new Error("expected SirbSpecError");
}

describe("defineAgent", () => {
  it("fills in apiVersion and kind and returns a plain Agent document", () => {
    const agent = defineAgent({ metadata, spec });
    expectTypeOf(agent).toEqualTypeOf<AgentDocument>();
    expect(agent).toEqual({
      apiVersion: "sirb/v1alpha1",
      kind: "Agent",
      metadata,
      spec,
    });
    expect(Object.keys(agent)).toEqual([
      "apiVersion",
      "kind",
      "metadata",
      "spec",
    ]);
    expect(Object.getPrototypeOf(agent)).toBe(Object.prototype);
  });

  it("returns a deep-frozen copy that later input mutation cannot change", () => {
    const input = { metadata: { name: "a" }, spec: { ...spec, tools: ["x"] } };
    const agent = defineAgent(input);
    input.spec.tools.push("y");
    expect(agent.spec.tools).toEqual(["x"]);
    expect(Object.isFrozen(agent)).toBe(true);
    expect(Object.isFrozen(agent.metadata)).toBe(true);
    expect(Object.isFrozen(agent.spec.tools)).toBe(true);
    expect(() => {
      (agent.spec as { instructions: string }).instructions = "changed";
    }).toThrow(TypeError);
  });

  it("round-trips through JSON.stringify and loadSpec", () => {
    const agent = defineAgent({ metadata, spec });
    const loaded = loadSpec(JSON.stringify(agent), { format: "json" });
    expect(loaded.valid).toBe(true);
    expect(loaded.documents[0]).toEqual(agent);
  });

  it("accepts a whole document, so loaded documents can be re-defined", () => {
    const [doc] = loadSpec(
      JSON.stringify({
        apiVersion: "sirb/v1alpha1",
        kind: "Agent",
        metadata,
        spec,
      }),
      {
        format: "json",
      },
    ).documents;
    expect(doc?.kind).toBe("Agent");
    expect(defineAgent(doc as AgentDocument)).toEqual(doc);
  });

  it("drops undefined optional fields like JSON does", () => {
    const agent = defineAgent({
      metadata,
      spec: { ...spec, description: undefined },
    });
    expect("description" in agent.spec).toBe(false);
  });

  it("throws SirbSpecError with the loader's schema locators", () => {
    const error = thrown(() =>
      defineAgent({
        metadata: { name: "Bad Name" },
        spec: { ...spec, maxIterations: 0 },
      }),
    );
    expect(error.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "schema",
          instancePath: "/metadata/name",
          keyword: "pattern",
        }),
        expect.objectContaining({
          code: "schema",
          instancePath: "/spec/maxIterations",
          keyword: "minimum",
        }),
      ]),
    );
    expect(error.errors.every((i) => i.document === undefined)).toBe(true);
  });

  it("is not a bypass for the literal-secret scan (SR-SPEC-04)", () => {
    const literal = "hunter2-FAKE";
    const input = { metadata, spec: { ...spec, apiKey: literal } };
    const error = thrown(() => defineAgent(input as never));
    expect(error.errors).toContainEqual(
      expect.objectContaining({
        code: "literal-secret",
        instancePath: "/spec/apiKey",
      }),
    );
    expect(error.message).not.toContain(literal);

    // The same document as YAML gives the same locators (plus the document index).
    const yaml = loadSpec(
      JSON.stringify({ apiVersion: "sirb/v1alpha1", kind: "Agent", ...input }),
      {
        format: "json",
      },
    );
    const strip = ({ document: _d, message: _m, ...locator }: SpecIssue) =>
      locator;
    expect(error.issues.map(strip)).toEqual(yaml.issues.map(strip));
  });

  it("reports possible secrets in free text as warnings, not failures", () => {
    const onWarning = vi.fn();
    const instructions =
      "Use sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE to call the API.";
    const agent = defineAgent(
      { metadata, spec: { ...spec, instructions } },
      { onWarning },
    );
    expect(agent.spec.instructions).toBe(instructions);
    expect(onWarning).toHaveBeenCalledTimes(1);
    expect(onWarning.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        code: "possible-secret",
        severity: "warning",
        instancePath: "/spec/instructions",
      }),
    ]);
    // Without a callback, warnings are simply not reported.
    expect(() =>
      defineAgent({ metadata, spec: { ...spec, instructions } }),
    ).not.toThrow();
  });

  it("does not call onWarning when there are no warnings", () => {
    const onWarning = vi.fn();
    defineAgent({ metadata, spec }, { onWarning });
    expect(onWarning).not.toHaveBeenCalled();
  });

  it("rejects a wrong apiVersion instead of replacing it", () => {
    const error = thrown(() =>
      defineAgent({ apiVersion: "sirb/v1" as "sirb/v1alpha1", metadata, spec }),
    );
    expect(error.errors).toContainEqual(
      expect.objectContaining({
        instancePath: "/apiVersion",
        keyword: "const",
      }),
    );
  });

  it("only defines Agents, even when the input is a valid document of another kind", () => {
    const memory = {
      kind: "Memory",
      metadata: { name: "buffer" },
      spec: { type: "buffer", scope: "session" },
    };
    const error = thrown(() => defineAgent(memory as never));
    expect(error.errors).toEqual([
      expect.objectContaining({
        code: "schema",
        instancePath: "/kind",
        keyword: "const",
      }),
    ]);
  });

  it("rejects extra top-level keys", () => {
    const error = thrown(() =>
      defineAgent({ metadata, spec, status: {} } as never),
    );
    expect(error.errors).toContainEqual(
      expect.objectContaining({
        instancePath: "",
        keyword: "additionalProperties",
        property: "status",
      }),
    );
  });

  it.each([
    ["null", null],
    ["an array", []],
    ["a string", "agent"],
  ])("rejects %s as input", (_label, input) => {
    const error = thrown(() => defineAgent(input as never));
    expect(error.errors[0]).toMatchObject({
      code: "invalid-input",
      instancePath: "",
    });
  });

  it("rejects values that are not JSON data", () => {
    const error = thrown(() =>
      defineAgent({ metadata, spec: { ...spec, timeoutSeconds: Number.NaN } }),
    );
    expect(error.errors).toEqual([
      expect.objectContaining({
        code: "invalid-input",
        instancePath: "/spec/timeoutSeconds",
      }),
    ]);
  });
});
