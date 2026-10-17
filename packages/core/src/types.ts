/**
 * TypeScript types for Sirb Agent Spec `sirb/v1alpha1`, written by hand from
 * sirb-spec `schema/v1alpha1/*.schema.json` (commit f0221f7). The JSON Schemas are
 * the source of truth: these types describe the shape, while patterns, lengths,
 * ranges and most cross-field rules are enforced only by validation
 * (`validateSpec`, `loadSpec`, `defineAgent`). Comments quote the schema rule.
 *
 * Every type is deeply readonly: a spec document is data, not mutable state.
 */

/** `common.schema.json#/$defs/apiVersion`. */
export type ApiVersion = "sirb/v1alpha1";

/** The `kind` values accepted by `resource.schema.json`. */
export type ResourceKind =
  | "Agent"
  | "Workflow"
  | "Tool"
  | "Memory"
  | "KnowledgeBase"
  | "ModelBinding"
  | "UIBinding"
  | "Policy";

/** `common#/$defs/name`: `^[a-z0-9-]{1,63}$`. */
export type ResourceName = string;

/** `common#/$defs/ref`: a resource name in the same namespace. */
export type ResourceRef = ResourceName;

/** `common#/$defs/refList`: unique refs, at most 100. */
export type ResourceRefList = readonly ResourceRef[];

/**
 * `common#/$defs/labels`: at most 64 entries. Keys match
 * `^[a-z0-9]([a-z0-9./-]{0,61}[a-z0-9])?$`, values `^[A-Za-z0-9._-]{0,63}$`.
 */
export type Labels = Readonly<Record<string, string>>;

/** `common#/$defs/metadata`. */
export interface Metadata {
  readonly name: ResourceName;
  readonly namespace?: ResourceName;
  /** At most 1024 characters. */
  readonly description?: string;
  readonly labels?: Labels;
}

/** The envelope shared by every v1alpha1 document. */
export interface Resource<K extends ResourceKind, S> {
  readonly apiVersion: ApiVersion;
  readonly kind: K;
  readonly metadata: Metadata;
  readonly spec: S;
}

// ---------------------------------------------------------------------------
// Shared definitions (common.schema.json)
// ---------------------------------------------------------------------------

export type SecretStore =
  | "sirb"
  | "kubernetes"
  | "vault"
  | "aws-secrets-manager"
  | "gcp-secret-manager"
  | "azure-key-vault";

/** `common#/$defs/secretRef`: a pointer to a secret; never the value. */
export interface SecretRef {
  readonly name: ResourceName;
  /** `^[A-Za-z0-9._-]{1,128}$`, and must not look like a credential. */
  readonly key?: string;
  /** Defaults to `sirb`. */
  readonly store?: SecretStore;
}

/** `common#/$defs/secretSource`: the only accepted form of a secret field. */
export interface SecretSource {
  readonly secretRef: SecretRef;
}

/** `common#/$defs/embedding`. */
export interface Embedding {
  readonly modelBinding: ResourceRef;
  /** 1..8192. */
  readonly dimensions?: number;
}

/** `common#/$defs/httpHeaders`: non-secret headers (lower-case names). */
export type HttpHeaders = Readonly<Record<string, string>>;

/** `common#/$defs/envVars`: non-secret env vars (`^[A-Z_][A-Z0-9_]{0,127}$`). */
export type EnvVars = Readonly<Record<string, string>>;

/** `common#/$defs/secretEnv`: env vars injected from secrets. */
export type SecretEnv = Readonly<Record<string, SecretSource>>;

// ---------------------------------------------------------------------------
// Agent (agent.schema.json)
// ---------------------------------------------------------------------------

export interface AgentSpec {
  /** At most 2048 characters. */
  readonly description?: string;
  /** 1..32768 characters. */
  readonly instructions: string;
  readonly modelBinding: ResourceRef;
  readonly tools?: ResourceRefList;
  readonly memory?: ResourceRef;
  readonly knowledgeBases?: ResourceRefList;
  readonly policies?: ResourceRefList;
  /** 1..100; the schema default is 10. */
  readonly maxIterations?: number;
  /** 1..3600. */
  readonly timeoutSeconds?: number;
}

export type AgentDocument = Resource<"Agent", AgentSpec>;

// ---------------------------------------------------------------------------
// ModelBinding (modelbinding.schema.json)
// ---------------------------------------------------------------------------

export type ModelProvider =
  | "anthropic"
  | "openai"
  | "azure-openai"
  | "google"
  | "bedrock"
  | "mistral"
  | "ollama"
  | "openai-compatible";

export type BudgetCurrency =
  | "USD"
  | "EUR"
  | "GBP"
  | "EGP"
  | "SAR"
  | "AED"
  | "JPY"
  | "INR"
  | "CAD"
  | "AUD"
  | "CHF";

export interface ModelParameters {
  /** 0..2. */
  readonly temperature?: number;
  /** 0..1. */
  readonly topP?: number;
  /** 1..1000000. */
  readonly maxOutputTokens?: number;
}

export type FallbackTrigger =
  "error" | "timeout" | "rate-limit" | "budget-exceeded";

export interface ModelFallback {
  readonly ref: ResourceRef;
  /** Unique, at least one. */
  readonly triggers?: readonly FallbackTrigger[];
}

export interface Budget {
  readonly currency: BudgetCurrency;
  /** Positive decimal string, up to 12 integer and 6 fraction digits ("25.50"). */
  readonly limit: string;
  readonly period: "hour" | "day" | "week" | "month" | "total";
  /** `fallback` requires `fallbacks` on the binding. */
  readonly onExceeded: "block" | "fallback" | "notify";
  /** Unique values in (0, 1], at most 10. */
  readonly alertThresholds?: readonly number[];
}

interface ModelBindingSpecBase {
  readonly provider: ModelProvider;
  /** `^[A-Za-z0-9._:/@-]{1,128}$`. */
  readonly model: string;
  readonly parameters?: ModelParameters;
  /** 1..5 entries. */
  readonly fallbacks?: readonly ModelFallback[];
}

/**
 * `mode: byok`: the customer supplies credentials. `credentials` is required
 * unless the provider is `ollama`. `endpoint` is required for `azure-openai`,
 * `openai-compatible` and `ollama`; it is https, or loopback http for `ollama`.
 */
export interface ByokModelBindingSpec extends ModelBindingSpecBase {
  readonly mode: "byok";
  readonly endpoint?: string;
  readonly credentials?: SecretSource;
  readonly budget?: Budget;
}

/**
 * `mode: billable`: Sirb holds the provider keys and bills usage. A budget is
 * required; credentials and endpoint are forbidden; `ollama` is not allowed.
 */
export interface BillableModelBindingSpec extends ModelBindingSpecBase {
  readonly mode: "billable";
  readonly budget: Budget;
  readonly endpoint?: never;
  readonly credentials?: never;
}

export type ModelBindingSpec = ByokModelBindingSpec | BillableModelBindingSpec;

export type ModelBindingDocument = Resource<"ModelBinding", ModelBindingSpec>;

// ---------------------------------------------------------------------------
// Tool (tool.schema.json)
// ---------------------------------------------------------------------------

export type ToolAuth =
  | { readonly type: "none" }
  | { readonly type: "bearer"; readonly credentials: SecretSource }
  | {
      readonly type: "api-key";
      readonly credentials: SecretSource;
      readonly in: "header" | "query";
      /** `^[A-Za-z0-9_-]{1,128}$`. */
      readonly name: string;
    }
  | {
      readonly type: "oauth2-client-credentials";
      /** https URL. */
      readonly tokenUrl: string;
      readonly clientId: string;
      readonly clientSecret: SecretSource;
      readonly scopes?: readonly string[];
    };

export interface HttpToolConfig {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** https URL without credentials. */
  readonly url: string;
  readonly headers?: HttpHeaders;
  readonly auth?: ToolAuth;
  /** 1..86400. */
  readonly timeoutSeconds?: number;
}

interface McpToolConfigBase {
  readonly env?: EnvVars;
  readonly secretEnv?: SecretEnv;
  readonly headers?: HttpHeaders;
  readonly auth?: ToolAuth;
  /** Unique tool-name globs, `^[A-Za-z0-9_.*-]{1,128}$`. */
  readonly toolFilter?: readonly string[];
}

export interface StdioMcpToolConfig extends McpToolConfigBase {
  readonly transport: "stdio";
  /** Executable to start; no inline `VAR=value`. */
  readonly command: string;
  /** At most 64; secret-named flags are rejected. */
  readonly args?: readonly string[];
  readonly url?: never;
}

export interface StreamableHttpMcpToolConfig extends McpToolConfigBase {
  readonly transport: "streamable-http";
  /** https URL. */
  readonly url: string;
  readonly command?: never;
  readonly args?: never;
}

export type McpToolConfig = StdioMcpToolConfig | StreamableHttpMcpToolConfig;

export interface FunctionToolConfig {
  readonly runtime: {
    readonly language: "node" | "dotnet" | "python";
    /** `^[0-9]{1,3}(\.[0-9]{1,3})?$`. */
    readonly version: string;
  };
  /**
   * node: `path/to/module.mjs#exportName`; dotnet:
   * `Assembly::Namespace.Type.Method`; python: `package.module:function`.
   */
  readonly handler: string;
  readonly env?: EnvVars;
  readonly secretEnv?: SecretEnv;
}

interface ToolSpecBase {
  /** 1..2048 characters. */
  readonly description: string;
  /** A JSON Schema (draft 2020-12) object describing the tool input. */
  readonly inputSchema?: Readonly<Record<string, unknown>>;
}

export interface HttpToolSpec extends ToolSpecBase {
  readonly type: "http";
  readonly http: HttpToolConfig;
  readonly mcp?: never;
  readonly function?: never;
}

export interface McpToolSpec extends ToolSpecBase {
  readonly type: "mcp";
  readonly mcp: McpToolConfig;
  readonly http?: never;
  readonly function?: never;
}

export interface FunctionToolSpec extends ToolSpecBase {
  readonly type: "function";
  readonly function: FunctionToolConfig;
  readonly http?: never;
  readonly mcp?: never;
}

export type ToolSpec = HttpToolSpec | McpToolSpec | FunctionToolSpec;

export type ToolDocument = Resource<"Tool", ToolSpec>;

// ---------------------------------------------------------------------------
// Memory (memory.schema.json)
// ---------------------------------------------------------------------------

export type MemoryStore =
  | {
      readonly provider: "sirb-managed" | "in-memory";
      readonly connection?: never;
    }
  | {
      readonly provider: "redis" | "postgres" | "pgvector" | "qdrant";
      readonly connection: SecretSource;
    };

export interface MemorySpec {
  /** `vector` requires `embedding`. */
  readonly type: "buffer" | "summary" | "vector" | "key-value";
  readonly scope: "session" | "user" | "agent" | "global";
  /** 0..2147483647. */
  readonly ttlSeconds?: number;
  /** 1..2147483647. */
  readonly maxEntries?: number;
  /** 1..2147483647. */
  readonly maxTokens?: number;
  readonly store?: MemoryStore;
  readonly embedding?: Embedding;
}

export type MemoryDocument = Resource<"Memory", MemorySpec>;

// ---------------------------------------------------------------------------
// KnowledgeBase (knowledgebase.schema.json)
// ---------------------------------------------------------------------------

interface KnowledgeSourceBase {
  readonly credentials?: SecretSource;
}

export interface WebKnowledgeSource extends KnowledgeSourceBase {
  readonly type: "web";
  readonly web: {
    /** 1..100 https URLs. */
    readonly urls: readonly string[];
    /** 0..5. */
    readonly crawlDepth?: number;
  };
}

export interface S3KnowledgeSource extends KnowledgeSourceBase {
  readonly type: "s3";
  readonly s3: {
    readonly bucket: string;
    readonly prefix?: string;
    readonly region?: string;
  };
}

export interface GcsKnowledgeSource extends KnowledgeSourceBase {
  readonly type: "gcs";
  readonly gcs: { readonly bucket: string; readonly prefix?: string };
}

export interface GitKnowledgeSource extends KnowledgeSourceBase {
  readonly type: "git";
  readonly git: {
    /** https URL without credentials. */
    readonly url: string;
    readonly branch?: string;
    readonly paths?: readonly string[];
  };
}

export interface FilesKnowledgeSource extends KnowledgeSourceBase {
  readonly type: "files";
  readonly files: { readonly paths: readonly string[] };
}

export type KnowledgeSource =
  | WebKnowledgeSource
  | S3KnowledgeSource
  | GcsKnowledgeSource
  | GitKnowledgeSource
  | FilesKnowledgeSource;

export type KnowledgeIndex =
  | { readonly provider: "sirb-managed"; readonly connection?: never }
  | {
      readonly provider: "pgvector" | "qdrant" | "pinecone";
      readonly connection: SecretSource;
    };

export interface KnowledgeBaseSpec {
  readonly description?: string;
  /** 1..50 sources. */
  readonly sources: readonly KnowledgeSource[];
  readonly embedding: Embedding;
  readonly chunking?: {
    readonly strategy?: "fixed" | "recursive" | "semantic";
    /** 64..8192. */
    readonly size?: number;
    /** 0..2048. */
    readonly overlap?: number;
  };
  readonly index?: KnowledgeIndex;
  readonly refresh?: {
    /** Five space-separated cron fields. */
    readonly schedule: string;
  };
  readonly retrieval?: {
    /** 1..100. */
    readonly topK?: number;
    /** 0..1. */
    readonly scoreThreshold?: number;
  };
}

export type KnowledgeBaseDocument = Resource<
  "KnowledgeBase",
  KnowledgeBaseSpec
>;

// ---------------------------------------------------------------------------
// Policy (policy.schema.json)
// ---------------------------------------------------------------------------

export type PiiCategory =
  "email" | "phone" | "credit-card" | "iban" | "national-id" | "credential";

export interface PolicyMatch {
  readonly tools?: ResourceRefList;
  readonly pii?: readonly PiiCategory[];
  /** 1..50 patterns in the ReDoS-safe subset (ADR-0010). */
  readonly patterns?: readonly string[];
  /** Hostnames. */
  readonly domains?: readonly string[];
  /** Defaults to false. */
  readonly caseInsensitive?: boolean;
}

/**
 * `effect: require-approval` requires `approval`; `effect: redact` requires a
 * `match` with `pii` or `patterns`.
 */
export interface PolicyRule {
  readonly id: ResourceName;
  readonly description?: string;
  readonly target:
    | "tool-call"
    | "model-input"
    | "model-output"
    | "memory-write"
    | "knowledge-retrieval";
  readonly effect: "allow" | "deny" | "require-approval" | "redact" | "log";
  /** 0..1000. */
  readonly priority?: number;
  readonly match?: PolicyMatch;
  readonly approval?: {
    /** `user:<id>` or `group:<id>`, unique, 1..50. */
    readonly approvers: readonly string[];
    /** 1..86400. */
    readonly timeoutSeconds?: number;
  };
}

export interface PolicySpec {
  readonly description?: string;
  /** Defaults to `enforce`. */
  readonly enforcement?: "enforce" | "audit" | "disabled";
  /** 1..200 rules. */
  readonly rules: readonly PolicyRule[];
  readonly limits?: {
    readonly maxToolCallsPerRun?: number;
    readonly maxTokensPerRun?: number;
    readonly maxRunSeconds?: number;
  };
}

export type PolicyDocument = Resource<"Policy", PolicySpec>;

// ---------------------------------------------------------------------------
// Kinds not yet typed in @sirb/core
// ---------------------------------------------------------------------------

/**
 * `Workflow` and `UIBinding` are validated by the loader but their `spec` is not
 * typed yet (an Agent does not reference them). Narrow on `kind` before use.
 */
export type WorkflowDocument = Resource<
  "Workflow",
  Readonly<Record<string, unknown>>
>;
export type UIBindingDocument = Resource<
  "UIBinding",
  Readonly<Record<string, unknown>>
>;

/** Any document that passed validation. Discriminate on `kind`. */
export type SirbDocument =
  | AgentDocument
  | ModelBindingDocument
  | ToolDocument
  | MemoryDocument
  | KnowledgeBaseDocument
  | PolicyDocument
  | WorkflowDocument
  | UIBindingDocument;
