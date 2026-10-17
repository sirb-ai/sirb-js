// Compile-time tests of the discriminated unions. They are checked by
// `tsc --noEmit` (the lint script); at run time the bodies only exercise the
// narrowing functions. Negative cases use `.not.toExtend`, which fails for the
// stated reason only, unlike `// @ts-expect-error` (any error satisfies it).
import { describe, expectTypeOf, it } from "vitest";
import type {
  AgentDocument,
  Budget,
  BillableModelBindingSpec,
  ByokModelBindingSpec,
  FunctionToolSpec,
  HttpToolSpec,
  KnowledgeBaseDocument,
  McpToolConfig,
  McpToolSpec,
  MemoryDocument,
  ModelBindingDocument,
  ModelBindingSpec,
  PolicyDocument,
  SecretSource,
  SirbDocument,
  StdioMcpToolConfig,
  StreamableHttpMcpToolConfig,
  ToolDocument,
  ToolSpec,
  UIBindingDocument,
  WorkflowDocument,
} from "../src/index.js";

type Anthropic = { provider: "anthropic"; model: string };
type Creds = { credentials: SecretSource };
type Bud = { budget: Budget };
type Http = { http: { method: "GET"; url: string } };
type Fn = {
  function: { runtime: { language: "node"; version: string }; handler: string };
};
type Desc = { description: string };

describe("ModelBinding: byok | billable (SR-SPEC-02)", () => {
  it("accepts the legal shapes", () => {
    expectTypeOf<
      Anthropic & { mode: "byok" } & Creds
    >().toExtend<ModelBindingSpec>();
    expectTypeOf<Anthropic & { mode: "byok" }>().toExtend<ModelBindingSpec>(); // ollama needs none
    expectTypeOf<
      Anthropic & { mode: "byok" } & Creds & Bud
    >().toExtend<ModelBindingSpec>();
    expectTypeOf<
      Anthropic & { mode: "billable" } & Bud
    >().toExtend<ModelBindingSpec>();
  });

  it("a billable binding cannot carry credentials or an endpoint", () => {
    expectTypeOf<
      Anthropic & { mode: "billable" } & Bud & Creds
    >().not.toExtend<ModelBindingSpec>();
    expectTypeOf<
      Anthropic & { mode: "billable" } & Bud & { endpoint: string }
    >().not.toExtend<ModelBindingSpec>();
    expectTypeOf<
      BillableModelBindingSpec["credentials"]
    >().toEqualTypeOf<undefined>();
    expectTypeOf<
      BillableModelBindingSpec["endpoint"]
    >().toEqualTypeOf<undefined>();
  });

  it("a billable binding needs a budget; mode is required", () => {
    expectTypeOf<
      Anthropic & { mode: "billable" }
    >().not.toExtend<ModelBindingSpec>();
    expectTypeOf<BillableModelBindingSpec["budget"]>().toEqualTypeOf<Budget>();
    expectTypeOf<Anthropic & Bud & Creds>().not.toExtend<ModelBindingSpec>();
    expectTypeOf<
      Anthropic & { mode: "free" } & Bud
    >().not.toExtend<ModelBindingSpec>();
  });

  it("credentials are a secretRef, never a literal", () => {
    expectTypeOf<
      Anthropic & { mode: "byok"; credentials: string }
    >().not.toExtend<ModelBindingSpec>();
    expectTypeOf<
      Anthropic & { mode: "byok"; credentials: { apiKey: string } }
    >().not.toExtend<ModelBindingSpec>();
    expectTypeOf<ByokModelBindingSpec["credentials"]>().toEqualTypeOf<
      SecretSource | undefined
    >();
    expectTypeOf<SecretSource>().toEqualTypeOf<{
      readonly secretRef: SecretSource["secretRef"];
    }>();
    expectTypeOf<SecretSource["secretRef"]["name"]>().toBeString();
  });

  it("narrows on mode", () => {
    const f = (spec: ModelBindingSpec) => {
      if (spec.mode === "billable") {
        expectTypeOf(spec).toEqualTypeOf<BillableModelBindingSpec>();
        expectTypeOf(spec.budget).toEqualTypeOf<Budget>();
        expectTypeOf(spec.credentials).toEqualTypeOf<undefined>();
      } else {
        expectTypeOf(spec).toEqualTypeOf<ByokModelBindingSpec>();
        expectTypeOf(spec.credentials).toEqualTypeOf<
          SecretSource | undefined
        >();
        expectTypeOf(spec.budget).toEqualTypeOf<Budget | undefined>();
      }
    };
    f({ provider: "ollama", model: "llama", mode: "byok" });
  });
});

describe("Tool: discriminated on type", () => {
  it("each type needs its own block and forbids the others", () => {
    expectTypeOf<Desc & { type: "http" } & Http>().toExtend<ToolSpec>();
    expectTypeOf<Desc & { type: "function" } & Fn>().toExtend<ToolSpec>();
    expectTypeOf<
      Desc & { type: "mcp"; mcp: { transport: "stdio"; command: string } }
    >().toExtend<ToolSpec>();

    expectTypeOf<Desc & { type: "http" }>().not.toExtend<ToolSpec>();
    expectTypeOf<Desc & { type: "mcp" }>().not.toExtend<ToolSpec>();
    expectTypeOf<Desc & { type: "function" }>().not.toExtend<ToolSpec>();
    // The block must match the type.
    expectTypeOf<Desc & { type: "http" } & Fn>().not.toExtend<ToolSpec>();
    expectTypeOf<Desc & { type: "function" } & Http>().not.toExtend<ToolSpec>();
    expectTypeOf<Desc & { type: "mcp" } & Http>().not.toExtend<ToolSpec>();
    // A second block is not allowed.
    expectTypeOf<
      Desc & { type: "http" } & Http & Fn
    >().not.toExtend<ToolSpec>();
    expectTypeOf<
      Desc & { type: "http" } & Http & { mcp: McpToolConfig }
    >().not.toExtend<ToolSpec>();
    // Unknown and missing discriminants.
    expectTypeOf<Desc & { type: "grpc" } & Http>().not.toExtend<ToolSpec>();
    expectTypeOf<Desc & Http>().not.toExtend<ToolSpec>();
    expectTypeOf<{ type: "http" } & Http>().not.toExtend<ToolSpec>(); // description is required
  });

  it("is exactly the three specs", () => {
    expectTypeOf<ToolSpec>().toEqualTypeOf<
      HttpToolSpec | McpToolSpec | FunctionToolSpec
    >();
    expectTypeOf<ToolSpec["type"]>().toEqualTypeOf<
      "http" | "mcp" | "function"
    >();
  });

  it("narrows on type", () => {
    const f = (spec: ToolSpec) => {
      switch (spec.type) {
        case "http":
          expectTypeOf(spec).toEqualTypeOf<HttpToolSpec>();
          expectTypeOf(spec.http.method).toEqualTypeOf<
            "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
          >();
          expectTypeOf(spec.mcp).toEqualTypeOf<undefined>();
          return;
        case "mcp":
          expectTypeOf(spec).toEqualTypeOf<McpToolSpec>();
          expectTypeOf(spec.mcp).toEqualTypeOf<McpToolConfig>();
          expectTypeOf(spec.http).toEqualTypeOf<undefined>();
          return;
        case "function":
          expectTypeOf(spec).toEqualTypeOf<FunctionToolSpec>();
          expectTypeOf(spec.function.handler).toBeString();
          return;
        default:
          expectTypeOf(spec).toEqualTypeOf<never>();
      }
    };
    f({
      type: "http",
      description: "d",
      http: { method: "GET", url: "https://example.com" },
    });
  });
});

describe("MCP tool config: discriminated on transport", () => {
  it("stdio needs a command and forbids a url", () => {
    expectTypeOf<{
      transport: "stdio";
      command: string;
    }>().toExtend<McpToolConfig>();
    expectTypeOf<{
      transport: "stdio";
      command: string;
      args: readonly string[];
    }>().toExtend<McpToolConfig>();
    expectTypeOf<{ transport: "stdio" }>().not.toExtend<McpToolConfig>();
    expectTypeOf<{
      transport: "stdio";
      command: string;
      url: string;
    }>().not.toExtend<McpToolConfig>();
    expectTypeOf<{
      transport: "stdio";
      url: string;
    }>().not.toExtend<McpToolConfig>();
  });

  it("streamable-http needs a url and forbids command and args", () => {
    expectTypeOf<{
      transport: "streamable-http";
      url: string;
    }>().toExtend<McpToolConfig>();
    expectTypeOf<{
      transport: "streamable-http";
    }>().not.toExtend<McpToolConfig>();
    expectTypeOf<{
      transport: "streamable-http";
      url: string;
      command: string;
    }>().not.toExtend<McpToolConfig>();
    expectTypeOf<{
      transport: "streamable-http";
      url: string;
      args: readonly string[];
    }>().not.toExtend<McpToolConfig>();
  });

  it("rejects an unknown or missing transport", () => {
    expectTypeOf<{
      transport: "sse";
      url: string;
    }>().not.toExtend<McpToolConfig>();
    expectTypeOf<{
      transport: "websocket";
      command: string;
    }>().not.toExtend<McpToolConfig>();
    expectTypeOf<{ command: string }>().not.toExtend<McpToolConfig>();
    expectTypeOf<McpToolConfig["transport"]>().toEqualTypeOf<
      "stdio" | "streamable-http"
    >();
  });

  it("narrows on transport", () => {
    const f = (config: McpToolConfig) => {
      if (config.transport === "stdio") {
        expectTypeOf(config).toEqualTypeOf<StdioMcpToolConfig>();
        expectTypeOf(config.command).toBeString();
        expectTypeOf(config.url).toEqualTypeOf<undefined>();
      } else {
        expectTypeOf(config).toEqualTypeOf<StreamableHttpMcpToolConfig>();
        expectTypeOf(config.url).toBeString();
        expectTypeOf(config.command).toEqualTypeOf<undefined>();
        expectTypeOf(config.args).toEqualTypeOf<undefined>();
      }
    };
    f({ transport: "stdio", command: "orders-mcp" });
  });

  it("secrets reach an MCP config only as secretRefs", () => {
    expectTypeOf<{
      transport: "stdio";
      command: string;
      secretEnv: Record<string, string>;
    }>().not.toExtend<McpToolConfig>();
    expectTypeOf<{
      transport: "stdio";
      command: string;
      secretEnv: Record<string, SecretSource>;
    }>().toExtend<McpToolConfig>();
  });
});

describe("SirbDocument: discriminated on kind", () => {
  it("narrows to one document type per kind and is exhaustive", () => {
    const f = (doc: SirbDocument) => {
      switch (doc.kind) {
        case "Agent":
          expectTypeOf(doc).toEqualTypeOf<AgentDocument>();
          return;
        case "ModelBinding":
          expectTypeOf(doc).toEqualTypeOf<ModelBindingDocument>();
          return;
        case "Tool":
          expectTypeOf(doc).toEqualTypeOf<ToolDocument>();
          return;
        case "Memory":
          expectTypeOf(doc).toEqualTypeOf<MemoryDocument>();
          return;
        case "KnowledgeBase":
          expectTypeOf(doc).toEqualTypeOf<KnowledgeBaseDocument>();
          return;
        case "Policy":
          expectTypeOf(doc).toEqualTypeOf<PolicyDocument>();
          return;
        case "Workflow":
          expectTypeOf(doc).toEqualTypeOf<WorkflowDocument>();
          return;
        case "UIBinding":
          expectTypeOf(doc).toEqualTypeOf<UIBindingDocument>();
          return;
        default:
          expectTypeOf(doc).toEqualTypeOf<never>();
      }
    };
    expectTypeOf(f).parameter(0).toEqualTypeOf<SirbDocument>();
  });

  it("every document has the v1alpha1 apiVersion, and a spec only valid for its kind", () => {
    expectTypeOf<SirbDocument["apiVersion"]>().toEqualTypeOf<"sirb/v1alpha1">();
    expectTypeOf<AgentDocument["kind"]>().toEqualTypeOf<"Agent">();
    expectTypeOf<
      AgentDocument["apiVersion"]
    >().toEqualTypeOf<"sirb/v1alpha1">();
    expectTypeOf<{
      apiVersion: "sirb/v1";
      kind: "Agent";
      metadata: { name: string };
      spec: AgentDocument["spec"];
    }>().not.toExtend<AgentDocument>();
    expectTypeOf<{
      apiVersion: "sirb/v1alpha1";
      kind: "Agent";
      metadata: { name: string };
      spec: ToolSpec;
    }>().not.toExtend<AgentDocument>();
    expectTypeOf<{
      apiVersion: "sirb/v1alpha1";
      kind: "Tool";
      metadata: { name: string };
      spec: AgentDocument["spec"];
    }>().not.toExtend<ToolDocument>();
  });
});
