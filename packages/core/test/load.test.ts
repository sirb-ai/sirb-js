import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SirbSpecError,
  loadSpec,
  loadSpecFile,
  loadSpecOrThrow,
} from "../src/index.js";

const agentYaml = `apiVersion: sirb/v1alpha1
kind: Agent
metadata: { name: support-agent }
spec:
  modelBinding: claude-default
  instructions: Be helpful.
`;

const agentJson = JSON.stringify({
  apiVersion: "sirb/v1alpha1",
  kind: "Agent",
  metadata: { name: "support-agent" },
  spec: { modelBinding: "claude-default", instructions: "Be helpful." },
});

const fixture = (name: string): string =>
  fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));

describe("loadSpec", () => {
  it("loads a YAML Agent (yaml is the default format)", () => {
    const result = loadSpec(agentYaml);
    expect(result).toEqual({
      valid: true,
      issues: [],
      documents: [
        {
          apiVersion: "sirb/v1alpha1",
          kind: "Agent",
          metadata: { name: "support-agent" },
          spec: { modelBinding: "claude-default", instructions: "Be helpful." },
        },
      ],
    });
  });

  it("returns deeply frozen documents, like defineAgent", async () => {
    const yaml = `${agentYaml}  tools: [a, b]\n`;
    for (const result of [
      loadSpec(yaml),
      await loadSpecFile(fixture("support-agent.yaml")),
    ]) {
      expect(result.valid).toBe(true);
      const [doc] = result.documents;
      if (doc?.kind !== "Agent") return expect.unreachable("an Agent");
      expect(Object.isFrozen(result.documents)).toBe(true);
      expect(Object.isFrozen(doc)).toBe(true);
      expect(Object.isFrozen(doc.metadata)).toBe(true);
      expect(Object.isFrozen(doc.spec.tools)).toBe(true);
      expect(() => {
        (doc.spec as { instructions: string }).instructions = "changed";
      }).toThrow(TypeError);
    }
  });

  it("loads JSON text and UTF-8 bytes", () => {
    expect(loadSpec(agentJson, { format: "json" }).valid).toBe(true);
    const bytes = new TextEncoder().encode(agentJson);
    expect(loadSpec(bytes, { format: "json" }).valid).toBe(true);
  });

  it("infers the format from the filename", () => {
    // YAML 1.2 accepts this JSON too, but JSON-only strictness applies for .json.
    const trailingComma = agentJson.replace(/}$/, ",}");
    expect(loadSpec(trailingComma, { filename: "agent.json" })).toMatchObject({
      valid: false,
      issues: [{ code: "syntax", severity: "error" }],
    });
  });

  it("loads multi-document streams and narrows on kind", () => {
    const binding = `---
apiVersion: sirb/v1alpha1
kind: ModelBinding
metadata: { name: claude-default }
spec: { provider: anthropic, model: claude-x, mode: byok, credentials: { secretRef: { name: anthropic-key } } }
`;
    const result = loadSpec(`${agentYaml}${binding}`);
    expect(result.valid).toBe(true);
    const kinds = result.documents.map((d) => d.kind);
    expect(kinds).toEqual(["Agent", "ModelBinding"]);
    const [, second] = result.documents;
    if (second?.kind === "ModelBinding" && second.spec.mode === "byok") {
      expect(second.spec.credentials?.secretRef.name).toBe("anthropic-key");
    } else {
      expect.unreachable("second document should be a byok ModelBinding");
    }
  });

  it("reports schema issues with standard locators and no documents", () => {
    const result = loadSpec(agentYaml.replace("support-agent", "Support"));
    expect(result.valid).toBe(false);
    expect(result.documents).toEqual([]);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "schema",
        severity: "error",
        instancePath: "/metadata/name",
        keyword: "pattern",
        document: 0,
      }),
    );
  });

  it("reports property for additionalProperties failures", () => {
    const result = loadSpec(`${agentYaml}  temperature: 1\n`);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        instancePath: "/spec",
        keyword: "additionalProperties",
        property: "temperature",
      }),
    );
  });

  it("rejects a literal secret (SR-SPEC-04)", () => {
    const result = loadSpec(`${agentYaml}  apiKey: hunter2\n`);
    expect(result.valid).toBe(false);
    expect(result.issues).toContainEqual(
      expect.objectContaining({
        code: "literal-secret",
        severity: "error",
        instancePath: "/spec/apiKey",
      }),
    );
  });

  it("keeps a valid result valid when there are only warnings", () => {
    const result = loadSpec(
      `# token: ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE\n${agentYaml}`,
    );
    expect(result.valid).toBe(true);
    expect(result.documents).toHaveLength(1);
    expect(result.issues).toEqual([
      expect.objectContaining({
        code: "possible-secret",
        severity: "warning",
        line: 1,
        document: 0,
        location: "comment",
      }),
    ]);
  });

  it("never throws, even for bad input, unknown formats or YAML hazards", () => {
    expect(loadSpec(42 as unknown as string).issues[0]?.code).toBe(
      "invalid-input",
    );
    expect(
      loadSpec(agentYaml, { format: "toml" as "yaml" }).issues[0]?.code,
    ).toBe("invalid-format");
    expect(loadSpec("a: &x 1\nb: *x\n").issues.map((i) => i.code)).toContain(
      "yaml-alias",
    );
    expect(loadSpec("").issues[0]?.code).toBe("empty");
  });

  it("does not forward undocumented options such as limits", () => {
    const options = { maxBytes: 1 } as unknown as { format: "yaml" };
    expect(loadSpec(agentYaml, options).valid).toBe(true);
  });
});

describe("loadSpecOrThrow", () => {
  it("returns the documents when valid", () => {
    expect(loadSpecOrThrow(agentYaml)).toHaveLength(1);
  });

  it("throws SirbSpecError with the issues and a content-free message", () => {
    const secret = "hunter2-FAKE";
    let caught: unknown;
    try {
      loadSpecOrThrow(`${agentYaml}  apiKey: ${secret}\n`, {
        filename: "agent.yaml",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(SirbSpecError);
    const error = caught as SirbSpecError;
    expect(error.name).toBe("SirbSpecError");
    expect(error.message).toMatch(
      /^agent\.yaml: invalid Sirb spec: 2 error\(s\); first: \[/,
    );
    expect(error.message).not.toContain(secret);
    expect(error.errors.map((i) => i.code).sort()).toEqual([
      "literal-secret",
      "schema",
    ]);
    expect(Object.isFrozen(error.issues)).toBe(true);
  });
});

describe("loadSpecFile", () => {
  it("loads a file and infers the format from its extension", async () => {
    const result = await loadSpecFile(fixture("support-agent.yaml"));
    expect(result.valid).toBe(true);
    expect(result.documents[0]?.metadata.name).toBe("support-agent");
  });

  it("accepts an explicit format", async () => {
    const result = await loadSpecFile(fixture("support-agent.yaml"), {
      format: "json",
    });
    expect(result.valid).toBe(false);
    expect(result.issues[0]?.code).toBe("syntax");
  });

  it("reports read failures as an io issue", async () => {
    const result = await loadSpecFile(fixture("does-not-exist.yaml"));
    expect(result).toMatchObject({
      valid: false,
      documents: [],
      issues: [{ code: "io" }],
    });
  });
});
