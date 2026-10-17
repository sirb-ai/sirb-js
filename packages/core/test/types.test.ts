// Compile-time checks of the v1alpha1 types (run by `tsc --noEmit` in lint).
import { describe, expectTypeOf, it } from "vitest";
import type {
  AgentInput,
  ModelBindingSpec,
  SirbDocument,
  ToolSpec,
} from "../src/index.js";

describe("v1alpha1 types", () => {
  it("encode the byok | billable rules of ModelBinding (SR-SPEC-02)", () => {
    const byok: ModelBindingSpec = {
      provider: "anthropic",
      model: "claude-x",
      mode: "byok",
      credentials: { secretRef: { name: "anthropic-key", key: "api-key" } },
    };
    const billable: ModelBindingSpec = {
      provider: "anthropic",
      model: "claude-x",
      mode: "billable",
      budget: {
        currency: "USD",
        limit: "25.50",
        period: "month",
        onExceeded: "block",
      },
    };
    // @ts-expect-error billable bindings must not carry credentials
    const withCredentials: ModelBindingSpec = {
      ...billable,
      credentials: byok.credentials,
    };
    // @ts-expect-error billable bindings need a budget
    const noBudget: ModelBindingSpec = {
      provider: "openai",
      model: "x",
      mode: "billable",
    };
    expectTypeOf([withCredentials, noBudget]).toBeArray();
  });

  it("discriminate Tool configs on type", () => {
    const tool: ToolSpec = {
      type: "mcp",
      description: "Orders",
      mcp: { transport: "stdio", command: "orders-mcp" },
    };
    // @ts-expect-error an http tool needs its http block, not mcp
    const wrong: ToolSpec = { type: "http", description: "x", mcp: tool.mcp };
    expectTypeOf(wrong).toEqualTypeOf<ToolSpec>();
  });

  it("narrow documents on kind", () => {
    const narrow = (doc: SirbDocument) =>
      doc.kind === "Agent" ? doc.spec.instructions : undefined;
    expectTypeOf(narrow).returns.toEqualTypeOf<string | undefined>();
  });

  it("reject unknown Agent fields and accept readonly input", () => {
    const tools = ["a"] as const;
    const input: AgentInput = {
      metadata: { name: "a" },
      spec: { modelBinding: "m", instructions: "i", tools },
    };
    const extra: AgentInput = {
      metadata: { name: "a" },
      // @ts-expect-error not an Agent field
      spec: { modelBinding: "m", instructions: "i", model: "x" },
    };
    expectTypeOf([input, extra]).toBeArray();
  });
});
