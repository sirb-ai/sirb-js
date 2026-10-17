// Edge cases of defineAgent: secrets, prototype pollution, cycles, getters and
// time-of-check/time-of-use, freezing, extra keys and wrong kind/apiVersion.
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  SirbSpecError,
  defineAgent,
  loadSpec,
  validateSpec,
  type AgentDocument,
  type SpecIssue,
} from "../src/index.js";

const FAKE = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";
const metadata = { name: "support-agent" };
const spec = { modelBinding: "claude-default", instructions: "Be helpful." };

function thrown(fn: () => unknown): SirbSpecError {
  try {
    fn();
  } catch (e) {
    if (e instanceof SirbSpecError) return e;
    throw e;
  }
  throw new Error("expected SirbSpecError");
}
const codes = (e: SirbSpecError): string[] => e.errors.map((i) => i.code);

/** Every object and array inside a value, including the value. */
function nodes(value: unknown): object[] {
  const out: object[] = [];
  const stack = [value];
  while (stack.length > 0) {
    const n = stack.pop();
    if (n !== null && typeof n === "object") {
      out.push(n);
      stack.push(...Object.values(n));
    }
  }
  return out;
}

afterAll(() => {
  // No test in this file may leave anything on Object.prototype.
  expect(Object.keys(Object.prototype)).toEqual([]);
  expect(({} as Record<string, unknown>).polluted).toBeUndefined();
});

describe("literal secrets (SR-SPEC-04)", () => {
  it.each([
    ["apiKey", { apiKey: FAKE }],
    ["password", { password: "hunter2-FAKE" }],
    ["token as a number", { token: 123456789 }],
    ["clientSecret", { clientSecret: "x-FAKE" }],
  ])("rejects a literal in spec.%s", (key, extra) => {
    const error = thrown(() =>
      defineAgent({ metadata, spec: { ...spec, ...extra } } as never),
    );
    expect(error.errors).toContainEqual(
      expect.objectContaining({
        code: "literal-secret",
        instancePath: `/spec/${key.split(" ")[0]}`,
      }),
    );
    // Neither the message nor any issue repeats the value.
    const dump = `${error.message}\n${JSON.stringify(error.issues)}`;
    for (const v of Object.values(extra)) expect(dump).not.toContain(String(v));
  });

  it("rejects secrets nested in objects and arrays under the spec", () => {
    const nested = thrown(() =>
      defineAgent({
        metadata,
        spec: { ...spec, tools: [{ token: FAKE }] },
      } as never),
    );
    // The schema rejects the object item; the secret scan also flags the leaf.
    expect(nested.errors).toContainEqual(
      expect.objectContaining({
        code: "literal-secret",
        instancePath: "/spec/tools/0/token",
      }),
    );
    expect(nested.errors.some((i) => i.code === "schema")).toBe(true);

    const deep = thrown(() =>
      defineAgent({
        metadata,
        spec: {
          ...spec,
          extra: { a: [{ b: [{ password: "hunter2-FAKE" }] }] },
        },
      } as never),
    );
    expect(deep.errors).toContainEqual(
      expect.objectContaining({
        code: "literal-secret",
        instancePath: "/spec/extra/a/0/b/0/password",
      }),
    );
    expect(JSON.stringify(deep.issues)).not.toContain("hunter2");
  });

  it("flags a literal array value under a secret-named field", () => {
    const error = thrown(() =>
      defineAgent({
        metadata,
        spec: { ...spec, apiKey: ["a-FAKE", "b-FAKE"] },
      } as never),
    );
    expect(error.errors.map((i) => i.instancePath)).toEqual(
      expect.arrayContaining(["/spec/apiKey/0", "/spec/apiKey/1"]),
    );
  });

  it("rejects a secret in metadata (the schema has no place for one)", () => {
    const error = thrown(() =>
      defineAgent({ metadata: { ...metadata, apiKey: FAKE }, spec } as never),
    );
    expect(error.errors).toContainEqual(
      expect.objectContaining({
        instancePath: "/metadata",
        keyword: "additionalProperties",
        property: "apiKey",
      }),
    );
    expect(error.message).not.toContain(FAKE);
  });

  it("metadata has no annotations in v1alpha1, so none can hold a secret", () => {
    const error = thrown(() =>
      defineAgent({
        metadata: { ...metadata, annotations: { note: FAKE } },
        spec,
      } as never),
    );
    expect(error.errors).toContainEqual(
      expect.objectContaining({
        instancePath: "/metadata",
        keyword: "additionalProperties",
        property: "annotations",
      }),
    );
    expect(JSON.stringify(error.issues)).not.toContain(FAKE);
  });

  it("warns, without failing, about a credential-shaped label value", () => {
    const onWarning = vi.fn<(w: readonly SpecIssue[]) => void>();
    const agent = defineAgent(
      { metadata: { ...metadata, labels: { build: FAKE } }, spec },
      { onWarning },
    );
    expect(agent.metadata.labels).toEqual({ build: FAKE });
    expect(onWarning).toHaveBeenCalledOnce();
    expect(onWarning.mock.calls[0]?.[0]).toEqual([
      expect.objectContaining({
        code: "possible-secret",
        severity: "warning",
        instancePath: "/metadata/labels/build",
      }),
    ]);
    expect(JSON.stringify(onWarning.mock.calls)).not.toContain(FAKE);
  });

  it("does not call onWarning when the definition is rejected", () => {
    const onWarning = vi.fn();
    expect(() =>
      defineAgent(
        {
          metadata,
          spec: { ...spec, instructions: FAKE, apiKey: "x-FAKE" },
        } as never,
        { onWarning },
      ),
    ).toThrow(SirbSpecError);
    expect(onWarning).not.toHaveBeenCalled();
  });

  it("accepts a secretRef where the schema allows one, and rejects it as an Agent field", () => {
    const binding = (credentials: unknown) => ({
      apiVersion: "sirb/v1alpha1",
      kind: "ModelBinding",
      metadata: { name: "claude" },
      spec: { provider: "anthropic", model: "x", mode: "byok", credentials },
    });
    const ok = validateSpec(
      binding({
        secretRef: { name: "anthropic-key", key: "api-key", store: "vault" },
      }),
    );
    expect(ok.valid).toBe(true);
    expect(ok.issues).toEqual([]);
    // A secretRef whose key looks like a credential is rejected, not accepted as a reference.
    const shaped = validateSpec(
      binding({ secretRef: { name: "k", key: FAKE } }),
    );
    expect(shaped.valid).toBe(false);

    // Agents carry no credentials: a secretRef is an unknown field there, but it is
    // reported as that, never as a literal secret.
    const error = thrown(() =>
      defineAgent({
        metadata,
        spec: { ...spec, apiKey: { secretRef: { name: "anthropic-key" } } },
      } as never),
    );
    expect(codes(error)).not.toContain("literal-secret");
    expect(error.errors).toContainEqual(
      expect.objectContaining({
        keyword: "additionalProperties",
        property: "apiKey",
      }),
    );
  });

  it("is also caught for the same document loaded as text (same locators)", () => {
    const input = { metadata, spec: { ...spec, apiKey: FAKE } };
    const fromCode = thrown(() => defineAgent(input as never));
    const fromText = loadSpec(
      JSON.stringify({ apiVersion: "sirb/v1alpha1", kind: "Agent", ...input }),
      { format: "json" },
    );
    const locator = ({ instancePath, keyword, code }: SpecIssue) =>
      `${code} ${instancePath} ${keyword}`;
    expect(fromCode.errors.map(locator).sort()).toEqual(
      fromText.issues
        .filter((i) => i.severity === "error")
        .map(locator)
        .sort(),
    );
  });
});

describe("prototype pollution", () => {
  it("rejects an own __proto__ key at every level and pollutes nothing", () => {
    const payload = '{"polluted": true}';
    const top = JSON.parse(
      `{"__proto__": ${payload}, "metadata": {"name":"a"}, "spec": {"modelBinding":"m","instructions":"i"}}`,
    ) as never;
    const inSpec = JSON.parse(
      `{"metadata": {"name":"a"}, "spec": {"modelBinding":"m","instructions":"i","__proto__": ${payload}}}`,
    ) as never;
    const inMeta = JSON.parse(
      `{"metadata": {"name":"a","__proto__": ${payload}}, "spec": {"modelBinding":"m","instructions":"i"}}`,
    ) as never;
    const inArray = JSON.parse(
      `{"metadata": {"name":"a"}, "spec": {"modelBinding":"m","instructions":"i","tools":[{"__proto__": ${payload}}]}}`,
    ) as never;
    for (const input of [top, inSpec, inMeta, inArray]) {
      const error = thrown(() => defineAgent(input));
      expect(codes(error)).toContain("forbidden-key");
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      expect(Object.getPrototypeOf({})).toBe(Object.prototype);
    }
  });

  it("does not treat a __proto__ object literal (a prototype, not a key) as data", () => {
    // `{ __proto__: x }` sets the prototype; it is not an own property.
    const inherited = {
      __proto__: { instructions: "inherited" },
      modelBinding: "m",
    };
    const error = thrown(() =>
      defineAgent({ metadata, spec: inherited } as never),
    );
    expect(codes(error)).toContain("invalid-input");
    expect(error.errors[0]?.instancePath).toBe("/spec");
  });

  it.each([
    "constructor",
    "prototype",
    "toString",
    "hasOwnProperty",
    "valueOf",
  ])("rejects %s as an unknown key without touching any prototype", (key) => {
    const error = thrown(() =>
      defineAgent({
        metadata,
        spec: { ...spec, [key]: { polluted: true } },
      } as never),
    );
    expect(error.errors).toContainEqual(
      expect.objectContaining({
        instancePath: "/spec",
        keyword: "additionalProperties",
        property: key,
      }),
    );
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(
      Object.prototype.hasOwnProperty.call(Object.prototype, "polluted"),
    ).toBe(false);
  });

  it("a constructor.prototype payload is only data and never merged", () => {
    const input = JSON.parse(
      '{"metadata":{"name":"a"},"spec":{"modelBinding":"m","instructions":"i","constructor":{"prototype":{"polluted":true}}}}',
    ) as never;
    expect(() => defineAgent(input)).toThrow(SirbSpecError);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("returns plain objects whose prototype is Object.prototype", () => {
    const agent = defineAgent({
      metadata: { ...metadata, labels: { a: "b" } },
      spec: { ...spec, tools: ["t"] },
    });
    for (const n of nodes(agent))
      expect(Object.getPrototypeOf(n)).toBe(
        Array.isArray(n) ? Array.prototype : Object.prototype,
      );
  });
});

describe("cycles and sizes", () => {
  it("rejects a cyclic object without overflowing the stack", () => {
    const cyclic: Record<string, unknown> = { ...spec };
    cyclic.self = cyclic;
    const error = thrown(() =>
      defineAgent({ metadata, spec: cyclic } as never),
    );
    expect(codes(error)).toEqual(["too-deep"]);
  });

  it("rejects a cycle through an array and through metadata", () => {
    const tools: unknown[] = [];
    tools.push(tools);
    expect(
      codes(
        thrown(() =>
          defineAgent({ metadata, spec: { ...spec, tools } } as never),
        ),
      ),
    ).toEqual(["too-deep"]);
    const meta: Record<string, unknown> = { name: "a" };
    meta.labels = { loop: meta };
    expect(
      codes(thrown(() => defineAgent({ metadata: meta, spec } as never))),
    ).toEqual(["too-deep"]);
  });

  it("rejects a self-referencing top-level document", () => {
    const doc: Record<string, unknown> = { metadata, spec };
    doc.again = doc;
    expect(codes(thrown(() => defineAgent(doc as never)))).toEqual([
      "too-deep",
    ]);
  });

  it("rejects an oversized instruction string", () => {
    const error = thrown(() =>
      defineAgent({
        metadata,
        spec: { ...spec, instructions: "x".repeat(32769) },
      }),
    );
    expect(error.errors).toContainEqual(
      expect.objectContaining({
        instancePath: "/spec/instructions",
        keyword: "maxLength",
      }),
    );
  });
});

describe("getters, proxies and time-of-check/time-of-use", () => {
  it("reads every getter exactly once and returns what it read", () => {
    const reads = { instructions: 0, name: 0, tool: 0 };
    const tools: string[] = [];
    Object.defineProperty(tools, 0, {
      enumerable: true,
      get() {
        reads.tool++;
        return reads.tool === 1 ? "first" : "second";
      },
    });
    const agent = defineAgent({
      metadata: {
        get name() {
          reads.name++;
          return reads.name === 1 ? "good-name" : "Bad Name!";
        },
      },
      spec: {
        modelBinding: "m",
        get instructions() {
          reads.instructions++;
          return reads.instructions === 1 ? "ok" : FAKE;
        },
        tools,
      },
    });
    expect(reads).toEqual({ instructions: 1, name: 1, tool: 1 });
    expect(agent.metadata.name).toBe("good-name");
    expect(agent.spec.instructions).toBe("ok");
    expect(agent.spec.tools).toEqual(["first"]);
    // The result holds data properties, not the input's getters.
    for (const n of nodes(agent))
      for (const d of Object.values(Object.getOwnPropertyDescriptors(n)))
        expect(d.get ?? d.set).toBeUndefined();
    expect(reads).toEqual({ instructions: 1, name: 1, tool: 1 });
  });

  it("what is returned is what was validated, even if a getter changes its answer", () => {
    // First read is valid; any later read would not be. The result must pass the loader.
    let n = 0;
    const agent = defineAgent({
      metadata,
      spec: {
        modelBinding: "m",
        get instructions() {
          return n++ === 0 ? "valid" : 12345;
        },
      } as never,
    });
    expect(loadSpec(JSON.stringify(agent), { format: "json" }).valid).toBe(
      true,
    );
  });

  it("a getter that is invalid on the first read is rejected, whatever it returns later", () => {
    let n = 0;
    const error = thrown(() =>
      defineAgent({
        metadata,
        spec: {
          modelBinding: "m",
          get instructions() {
            return n++ === 0 ? 12345 : "valid";
          },
        } as never,
      }),
    );
    expect(error.errors).toContainEqual(
      expect.objectContaining({
        instancePath: "/spec/instructions",
        keyword: "type",
      }),
    );
  });

  it("mutating the input from onWarning (after validation) cannot change the result", () => {
    const input = {
      metadata: { name: "a", labels: { build: FAKE } },
      spec: { modelBinding: "m", instructions: "original", tools: ["t1"] },
    };
    const agent = defineAgent(input, {
      onWarning: () => {
        input.spec.instructions = "changed";
        input.spec.tools.push("evil");
        input.metadata.name = "Bad Name";
        (input.spec as Record<string, unknown>).apiKey = FAKE;
      },
    });
    expect(agent.spec).toEqual({
      modelBinding: "m",
      instructions: "original",
      tools: ["t1"],
    });
    expect(agent.metadata.name).toBe("a");
    expect(Object.keys(agent.spec)).not.toContain("apiKey");
  });

  it("mutating the input after the call cannot change the result, at any depth", () => {
    const input = {
      metadata: { name: "a", labels: { team: "x" } },
      spec: { modelBinding: "m", instructions: "i", tools: ["t1"] },
    };
    const agent = defineAgent(input);
    const before = JSON.stringify(agent);
    input.metadata.labels.team = "y";
    input.spec.tools[0] = "t9";
    input.spec.tools.length = 0;
    expect(JSON.stringify(agent)).toBe(before);
    // No node of the result is shared with the input.
    const inputNodes = new Set(nodes(input));
    for (const n of nodes(agent)) expect(inputNodes.has(n)).toBe(false);
  });

  it("does not freeze or otherwise modify the input", () => {
    const input = {
      metadata: { name: "a" },
      spec: { modelBinding: "m", instructions: "i" },
    };
    const snapshot = JSON.stringify(input);
    defineAgent(input);
    expect(JSON.stringify(input)).toBe(snapshot);
    for (const n of nodes(input)) expect(Object.isFrozen(n)).toBe(false);
    expect(Object.keys(input)).toEqual(["metadata", "spec"]);
  });

  it("reports a throwing getter as invalid-input, without its error text", () => {
    const error = thrown(() =>
      defineAgent({
        metadata,
        spec: {
          modelBinding: "m",
          get instructions(): string {
            throw new RangeError(`getter failed ${FAKE}`);
          },
        },
      }),
    );
    expect(error.errors).toEqual([
      {
        code: "invalid-input",
        severity: "error",
        instancePath: "/spec",
        message: "value could not be read as JSON data",
      },
    ]);
    expect(`${error.message}${JSON.stringify(error.issues)}`).not.toContain(
      "FAKE",
    );
  });

  it("reports a revoked Proxy as invalid-input from defineAgent and validateSpec", () => {
    const { proxy, revoke } = Proxy.revocable({ name: "a" }, {});
    revoke();
    const error = thrown(() => defineAgent({ metadata: proxy, spec }));
    expect(error.errors[0]).toMatchObject({
      code: "invalid-input",
      instancePath: "/metadata",
    });
    expect(validateSpec(proxy)).toMatchObject({
      valid: false,
      issues: [{ code: "invalid-input", instancePath: "" }],
    });
  });

  it("copies a Proxy by reading each property once", () => {
    const gets: Record<string, number> = {};
    const target = { ...spec };
    const proxy = new Proxy(target, {
      get(t, key, receiver) {
        gets[String(key)] = (gets[String(key)] ?? 0) + 1;
        return Reflect.get(t, key, receiver);
      },
    });
    const agent = defineAgent({ metadata, spec: proxy });
    expect(agent.spec).toEqual(spec);
    expect(gets.instructions).toBe(1);
    expect(gets.modelBinding).toBe(1);
  });

  it("ignores symbol keys and non-enumerable properties like JSON does", () => {
    const hidden = Object.defineProperty({ ...spec }, "hidden", {
      value: "x",
      enumerable: false,
    });
    const withSymbol = { ...hidden, [Symbol("s")]: "y" };
    const agent = defineAgent({ metadata, spec: withSymbol });
    expect(agent.spec).toEqual(spec);
    expect(Object.getOwnPropertySymbols(agent.spec)).toEqual([]);
    expect(Object.getOwnPropertyNames(agent.spec)).not.toContain("hidden");
  });
});

describe("freezing", () => {
  const full = () =>
    defineAgent({
      metadata: {
        name: "a",
        namespace: "ns",
        description: "d",
        labels: { team: "x" },
      },
      spec: {
        modelBinding: "m",
        instructions: "i",
        tools: ["t1", "t2"],
        knowledgeBases: ["kb"],
        policies: ["p"],
        memory: "mem",
        maxIterations: 5,
        timeoutSeconds: 60,
      },
    });

  it("freezes every object and array in the result", () => {
    const agent = full();
    const all = nodes(agent);
    expect(all.length).toBeGreaterThan(6);
    for (const n of all) expect(Object.isFrozen(n)).toBe(true);
  });

  it.each<[string, (a: AgentDocument) => void]>([
    [
      "add a key to the document",
      (a) => ((a as never as Record<string, unknown>).x = 1),
    ],
    [
      "replace a spec value",
      (a) => ((a.spec as { instructions: string }).instructions = "z"),
    ],
    ["push to an array", (a) => (a.spec.tools as string[]).push("t3")],
    ["write an array element", (a) => ((a.spec.tools as string[])[0] = "z")],
    [
      "edit a label",
      (a) => ((a.metadata.labels as Record<string, string>).team = "z"),
    ],
    ["delete a key", (a) => delete (a.spec as { memory?: string }).memory],
    [
      "redefine a property",
      (a) => Object.defineProperty(a.metadata, "name", { value: "z" }),
    ],
    ["set the prototype", (a) => Object.setPrototypeOf(a.spec, null)],
  ])("cannot %s", (_label, mutate) => {
    const agent = full();
    const before = JSON.stringify(agent);
    expect(() => mutate(agent)).toThrow(TypeError);
    expect(JSON.stringify(agent)).toBe(before);
  });

  it("returns a new frozen object each call", () => {
    const input = { metadata, spec };
    const a = defineAgent(input);
    const b = defineAgent(input);
    expect(a).not.toBe(b);
    expect(a.spec).not.toBe(b.spec);
    expect(a).toEqual(b);
  });
});

describe("no extra keys and JSON round trip", () => {
  it("has exactly apiVersion, kind, metadata and spec (apiVersion and kind first)", () => {
    const agent = defineAgent({ spec, metadata });
    expect(Object.keys(agent).slice(0, 2)).toEqual(["apiVersion", "kind"]);
    expect(Object.keys(agent).sort()).toEqual([
      "apiVersion",
      "kind",
      "metadata",
      "spec",
    ]);
    expect(Object.keys(agent.spec)).toEqual(["modelBinding", "instructions"]);
  });

  it.each([
    ["top level", { status: "x" }, ""],
    ["a second kind-like key", { Kind: "Agent" }, ""],
  ])("rejects an extra key at the %s", (_l, extra, path) => {
    const error = thrown(() =>
      defineAgent({ metadata, spec, ...extra } as never),
    );
    expect(error.errors).toContainEqual(
      expect.objectContaining({
        instancePath: path,
        keyword: "additionalProperties",
      }),
    );
  });

  it("rejects extra keys in spec and metadata with the key named", () => {
    const e1 = thrown(() =>
      defineAgent({ metadata, spec: { ...spec, model: "x" } } as never),
    );
    expect(e1.errors).toContainEqual(
      expect.objectContaining({ instancePath: "/spec", property: "model" }),
    );
    const e2 = thrown(() =>
      defineAgent({ metadata: { ...metadata, owner: "x" }, spec } as never),
    );
    expect(e2.errors).toContainEqual(
      expect.objectContaining({ instancePath: "/metadata", property: "owner" }),
    );
  });

  it("serialises to JSON that loads back to an equal, valid document", () => {
    const agent = defineAgent({
      metadata: {
        name: "a",
        namespace: "ns",
        description: "Support",
        labels: { team: "x" },
      },
      spec: {
        modelBinding: "m",
        instructions: "Answer in Arabic: مرحبا بالعالم, and in English.",
        tools: ["t1"],
        knowledgeBases: ["kb"],
        policies: ["p"],
        memory: "mem",
        maxIterations: 7,
        timeoutSeconds: 120,
        description: "d",
      },
    });
    const text = JSON.stringify(agent);
    expect(JSON.parse(text)).toEqual(agent);
    const asJson = loadSpec(text, { format: "json" });
    const asYaml = loadSpec(text, { format: "yaml" });
    const asBytes = loadSpec(new TextEncoder().encode(text), {
      format: "json",
    });
    for (const loaded of [asJson, asYaml, asBytes]) {
      expect(loaded.valid).toBe(true);
      expect(loaded.documents).toEqual([agent]);
    }
    // And defining the loaded document again is a fixed point.
    expect(defineAgent(asJson.documents[0] as AgentDocument)).toEqual(agent);
  });

  it("drops undefined optional values so JSON and the result agree", () => {
    const agent = defineAgent({
      metadata: { ...metadata, labels: undefined },
      spec: { ...spec, tools: undefined, memory: undefined },
    });
    expect(agent).toEqual({
      apiVersion: "sirb/v1alpha1",
      kind: "Agent",
      metadata,
      spec,
    });
    expect(JSON.parse(JSON.stringify(agent))).toEqual(agent);
  });
});

describe("kind and apiVersion", () => {
  it("accepts the explicit correct values", () => {
    const agent = defineAgent({
      apiVersion: "sirb/v1alpha1",
      kind: "Agent",
      metadata,
      spec,
    });
    expect(agent.kind).toBe("Agent");
    expect(agent.apiVersion).toBe("sirb/v1alpha1");
  });

  it.each([
    "sirb/v1",
    "sirb/v1alpha2",
    "SIRB/V1ALPHA1",
    "sirb/v1alpha1 ",
    "",
    1,
    null,
    true,
    {},
  ])("rejects apiVersion %j", (apiVersion) => {
    const error = thrown(() =>
      defineAgent({ apiVersion, metadata, spec } as never),
    );
    expect(error.errors).toContainEqual(
      expect.objectContaining({
        instancePath: "/apiVersion",
        keyword: "const",
      }),
    );
  });

  it.each([
    "Tool",
    "agent",
    "AGENT",
    "Agent ",
    "Gadget",
    "",
    1,
    null,
    ["Agent"],
    {},
  ])("rejects kind %j", (kind) => {
    const error = thrown(() => defineAgent({ kind, metadata, spec } as never));
    expect(error.errors.some((i) => i.instancePath === "/kind")).toBe(true);
  });

  it("reports a wrong kind and an invalid spec together", () => {
    const error = thrown(() =>
      defineAgent({
        kind: "Tool",
        metadata,
        spec: { instructions: "i" },
      } as never),
    );
    expect(error.errors.some((i) => i.instancePath === "/kind")).toBe(true);
    expect(error.errors.length).toBeGreaterThan(1);
  });

  it("fills in the defaults when the fields are undefined", () => {
    const agent = defineAgent({
      apiVersion: undefined,
      kind: undefined,
      metadata,
      spec,
    } as never);
    expect(agent).toMatchObject({ apiVersion: "sirb/v1alpha1", kind: "Agent" });
  });

  it("reports a missing metadata or spec", () => {
    expect(thrown(() => defineAgent({ spec } as never)).errors).toContainEqual(
      expect.objectContaining({ keyword: "required", property: "metadata" }),
    );
    expect(
      thrown(() => defineAgent({ metadata } as never)).errors,
    ).toContainEqual(
      expect.objectContaining({ keyword: "required", property: "spec" }),
    );
    expect(thrown(() => defineAgent({} as never)).errors.length).toBe(2);
  });
});
