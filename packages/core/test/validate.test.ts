import { describe, expect, it } from "vitest";
import { validateSpec } from "../src/index.js";
import { cloneAsJson, deepFreeze } from "../src/plain-data.js";

const agent = () => ({
  apiVersion: "sirb/v1alpha1",
  kind: "Agent",
  metadata: { name: "support-agent" },
  spec: { modelBinding: "claude-default", instructions: "Be helpful." },
});

describe("validateSpec", () => {
  it("accepts a valid document and returns a plain copy", () => {
    const input = agent();
    const result = validateSpec(input);
    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.document).toEqual(input);
    expect(result.document).not.toBe(input);
    expect(result.issues).toEqual([]);
  });

  it("returns a deeply frozen document and leaves the input unfrozen", () => {
    const input = agent();
    const result = validateSpec(input);
    if (!result.valid) return expect.unreachable("valid input");
    expect(Object.isFrozen(result.document)).toBe(true);
    expect(Object.isFrozen(result.document.metadata)).toBe(true);
    expect(Object.isFrozen(result.document.spec)).toBe(true);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(input.spec)).toBe(false);
  });

  it("reports schema locators without a document index", () => {
    const result = validateSpec({ ...agent(), spec: { instructions: "x" } });
    expect(result.valid).toBe(false);
    expect(result.issues).toEqual([
      {
        code: "schema",
        severity: "error",
        instancePath: "/spec",
        keyword: "required",
        property: "modelBinding",
        message: expect.any(String),
      },
    ]);
  });

  it("validates every kind, and unknown kinds against the resource envelope", () => {
    const binding = {
      apiVersion: "sirb/v1alpha1",
      kind: "ModelBinding",
      metadata: { name: "claude" },
      spec: { provider: "anthropic", model: "m", mode: "billable" },
    };
    expect(validateSpec(binding).issues).toContainEqual(
      expect.objectContaining({
        instancePath: "/spec",
        keyword: "required",
        property: "budget",
      }),
    );
    expect(validateSpec({ ...agent(), kind: "Gadget" }).issues).toContainEqual(
      expect.objectContaining({ instancePath: "/kind", keyword: "enum" }),
    );
  });

  it("runs the loader's literal-secret scan and policy-pattern check", () => {
    const tool = {
      apiVersion: "sirb/v1alpha1",
      kind: "Tool",
      metadata: { name: "t" },
      spec: {
        type: "http",
        description: "d",
        http: { method: "GET", url: "https://example.com" },
        inputSchema: {
          type: "object",
          properties: { password: { type: "string", default: "hunter2-FAKE" } },
        },
      },
    };
    expect(validateSpec(tool).issues).toContainEqual(
      expect.objectContaining({
        code: "literal-secret",
        instancePath: "/spec/inputSchema/properties/password/default",
      }),
    );
    const policy = {
      apiVersion: "sirb/v1alpha1",
      kind: "Policy",
      metadata: { name: "p" },
      spec: {
        rules: [
          {
            id: "r",
            target: "model-output",
            effect: "redact",
            match: { patterns: ["[a-z]{0,1000}[0-9]{0,1000}x{0,1000}"] },
          },
        ],
      },
    };
    expect(validateSpec(policy).issues).toContainEqual(
      expect.objectContaining({
        code: "invalid-regex",
        instancePath: "/spec/rules/0/match/patterns/0",
      }),
    );
  });

  it("rejects an own __proto__ key like the loader does", () => {
    const doc = JSON.parse(
      '{"apiVersion":"sirb/v1alpha1","kind":"Agent","metadata":{"name":"a","__proto__":{}},"spec":{"modelBinding":"m","instructions":"i"}}',
    ) as unknown;
    expect(validateSpec(doc).issues.map((i) => i.code)).toContain(
      "forbidden-key",
    );
  });

  it("reports a non-object document as not-an-object", () => {
    expect(validateSpec("Agent").issues[0]?.code).toBe("not-an-object");
  });

  it.each([
    ["a function", () => 1, "function is not JSON data"],
    ["a Date", new Date(0), "a Date instance is not JSON data"],
    ["NaN", Number.NaN, "NaN is not JSON data"],
    ["a bigint", 1n, "bigint is not JSON data"],
    ["a symbol", Symbol("s"), "symbol is not JSON data"],
    ["undefined in an array", [undefined], "undefined is not JSON data"],
  ])("rejects %s with invalid-input at its path", (_label, value, message) => {
    const doc = { ...agent(), spec: { ...agent().spec, extra: value } };
    const result = validateSpec(doc);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual({
      code: "invalid-input",
      severity: "error",
      instancePath: Array.isArray(value) ? "/spec/extra/0" : "/spec/extra",
      message,
    });
  });
});

describe("cloneAsJson", () => {
  it("omits undefined properties and keeps key order", () => {
    const result = cloneAsJson({
      b: 1,
      a: undefined,
      c: [true, null, "s"],
      d: { "x/y~": 2 },
    });
    expect(result).toEqual({
      ok: true,
      value: { b: 1, c: [true, null, "s"], d: { "x/y~": 2 } },
    });
    if (result.ok)
      expect(Object.keys(result.value as object)).toEqual(["b", "c", "d"]);
  });

  it("escapes JSON Pointer paths", () => {
    expect(cloneAsJson({ "a/b~c": Number.POSITIVE_INFINITY })).toMatchObject({
      ok: false,
      issues: [{ instancePath: "/a~1b~0c" }],
    });
  });

  it("reads each getter once, so the result cannot change after validation", () => {
    let reads = 0;
    const input = {
      get name() {
        reads++;
        return `n${reads}`;
      },
    };
    expect(cloneAsJson(input)).toEqual({ ok: true, value: { name: "n1" } });
    expect(reads).toBe(1);
  });

  it("accepts null-prototype objects and rejects exotic ones", () => {
    const bare = Object.assign(Object.create(null) as object, { a: 1 });
    expect(cloneAsJson(bare)).toEqual({ ok: true, value: { a: 1 } });
    class Point {
      x = 1;
    }
    expect(cloneAsJson(new Point())).toMatchObject({
      ok: false,
      issues: [{ message: "a Point instance is not JSON data" }],
    });
    const anonymous = Object.create(Object.create(null) as object) as object;
    expect(cloneAsJson(anonymous)).toMatchObject({
      ok: false,
      issues: [{ message: "an exotic object is not JSON data" }],
    });
  });

  it("rejects array holes", () => {
    // eslint-disable-next-line no-sparse-arrays
    expect(cloneAsJson([1, , 3])).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-input", instancePath: "/1" }],
    });
  });

  it("stops cycles and deep nesting at the loader's depth limit", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(cloneAsJson(cyclic)).toMatchObject({
      ok: false,
      issues: [{ code: "too-deep" }],
    });
    let deep: unknown = {};
    for (let i = 0; i < 63; i++) deep = { a: deep };
    expect(cloneAsJson(deep).ok).toBe(true);
    expect(cloneAsJson({ a: deep })).toMatchObject({
      ok: false,
      issues: [{ code: "too-deep" }],
    });
  });

  it("stops shared-reference blow-ups and huge values at the size limit", () => {
    let dag: unknown = "leaf";
    for (let i = 0; i < 40; i++) dag = [dag, dag];
    expect(cloneAsJson(dag)).toMatchObject({
      ok: false,
      issues: [{ code: "too-large" }],
    });
    expect(cloneAsJson(new Array(2_000_000))).toMatchObject({
      ok: false,
      issues: [{ code: "too-large" }],
    });
    expect(cloneAsJson(["x".repeat(1024 * 1024 + 1)])).toMatchObject({
      ok: false,
      issues: [{ code: "too-large" }],
    });
  });
});

describe("deepFreeze", () => {
  it("freezes nested objects and arrays", () => {
    const value = deepFreeze({ a: { b: [1, { c: 2 }] } });
    expect(Object.isFrozen(value.a.b[1])).toBe(true);
    expect(Object.isFrozen(value.a.b)).toBe(true);
  });
});
