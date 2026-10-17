// Loader edge cases: format detection, multi-document streams, bytes, limits,
// loadSpecFile on real temp files, and "error text never carries source content".
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  SirbSpecError,
  loadSpec,
  loadSpecFile,
  loadSpecOrThrow,
  type SpecIssue,
} from "../src/index.js";

const agentObj = {
  apiVersion: "sirb/v1alpha1",
  kind: "Agent",
  metadata: { name: "support-agent" },
  spec: { modelBinding: "claude-default", instructions: "Be helpful." },
};
const agentJson = JSON.stringify(agentObj);
const agentYaml = `apiVersion: sirb/v1alpha1
kind: Agent
metadata: { name: support-agent }
spec:
  modelBinding: claude-default
  instructions: Be helpful.
`;
const FAKE = "FAKE-hunter2-secret-zzz";
const GH = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE";

const codes = (issues: readonly SpecIssue[]): string[] =>
  issues.map((i) => i.code);

describe("YAML and JSON give the same documents", () => {
  it("loads the same document from YAML text, JSON text, and bytes of each", () => {
    const encode = (s: string) => new TextEncoder().encode(s);
    const results = [
      loadSpec(agentYaml),
      loadSpec(agentYaml, { format: "yaml" }),
      loadSpec(agentJson, { format: "json" }),
      loadSpec(agentJson, { format: "yaml" }),
      loadSpec(encode(agentYaml)),
      loadSpec(encode(agentJson), { format: "json" }),
      loadSpec(Buffer.from(agentJson), { filename: "a.json" }),
    ];
    for (const r of results) {
      expect(r.valid).toBe(true);
      expect(r.documents).toEqual([agentObj]);
      expect(r.issues).toEqual([]);
    }
  });

  it("round-trips non-ASCII text (Arabic) through strings and bytes", () => {
    const arabic = {
      ...agentObj,
      spec: { ...agentObj.spec, instructions: "مرحبا، كيف يمكنني مساعدتك؟" },
    };
    const text = JSON.stringify(arabic);
    for (const input of [text, new TextEncoder().encode(text)]) {
      const r = loadSpec(input, { format: "json" });
      expect(r.documents).toEqual([arabic]);
    }
  });

  it("accepts a UTF-8 byte order mark", () => {
    const r = loadSpec(Buffer.from(`﻿${agentYaml}`));
    expect(r.valid).toBe(true);
  });
});

describe("format detection from filename", () => {
  it.each(["agent.json", "AGENT.JSON", "dir.d/agent.Json"])(
    "%s is parsed as strict JSON",
    (filename) => {
      expect(loadSpec(agentJson, { filename }).valid).toBe(true);
      const r = loadSpec(agentYaml, { filename });
      expect(r.valid).toBe(false);
      expect(codes(r.issues)).toEqual(["syntax"]);
    },
  );

  it.each([
    "agent.yaml",
    "agent.yml",
    "AGENT.YML",
    "agent.txt",
    "agent",
    "agent.json.bak",
    ".json",
  ])("%s is parsed as YAML", (filename) => {
    expect(loadSpec(agentYaml, { filename }).valid).toBe(true);
  });

  it("an explicit format wins over the filename, both ways", () => {
    expect(
      loadSpec(agentYaml, { filename: "a.json", format: "yaml" }).valid,
    ).toBe(true);
    const r = loadSpec(agentYaml, { filename: "a.yaml", format: "json" });
    expect(codes(r.issues)).toEqual(["syntax"]);
  });

  it("never reads the file named by filename", () => {
    const missing = join(tmpdir(), "sirb-core-definitely-missing", "a.yaml");
    expect(loadSpec(agentYaml, { filename: missing }).valid).toBe(true);
  });

  it("rejects an unknown format, even when the filename has a known extension", () => {
    const r = loadSpec(agentYaml, {
      format: "toml" as "yaml",
      filename: "a.yaml",
    });
    expect(codes(r.issues)).toEqual(["invalid-format"]);
  });

  it("strict JSON rejects JSON5-style input that YAML accepts", () => {
    const loose =
      "{ apiVersion: 'sirb/v1alpha1', kind: Agent, metadata: {name: a}, spec: {modelBinding: m, instructions: i} }";
    expect(loadSpec(loose, { format: "yaml" }).valid).toBe(true);
    expect(codes(loadSpec(loose, { format: "json" }).issues)).toEqual([
      "syntax",
    ]);
  });
});

describe("multi-document streams", () => {
  const binding = `apiVersion: sirb/v1alpha1
kind: ModelBinding
metadata: { name: claude-default }
spec: { provider: anthropic, model: claude-x, mode: byok, credentials: { secretRef: { name: anthropic-key } } }
`;

  it("loads documents in order, with and without a leading separator or end marker", () => {
    for (const stream of [
      `${agentYaml}---\n${binding}`,
      `---\n${agentYaml}---\n${binding}`,
      `${agentYaml}...\n---\n${binding}...\n`,
    ]) {
      const r = loadSpec(stream);
      expect(r.valid).toBe(true);
      expect(r.documents.map((d) => d.kind)).toEqual(["Agent", "ModelBinding"]);
    }
  });

  it("one bad document makes the whole stream invalid and returns none of them", () => {
    const bad = binding.replace("claude-default", "Claude Default");
    const r = loadSpec(`${agentYaml}---\n${bad}---\n${agentYaml}`);
    expect(r.valid).toBe(false);
    expect(r.documents).toEqual([]);
    const errors = r.issues.filter((i) => i.severity === "error");
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((i) => i.document === 1)).toBe(true);
  });

  it("reports an empty document between separators as not-an-object", () => {
    const r = loadSpec(`${agentYaml}---\n---\n${agentYaml}`);
    expect(r.valid).toBe(false);
    expect(r.issues).toContainEqual(
      expect.objectContaining({ code: "not-an-object", document: 1 }),
    );
  });

  it("rejects non-mapping documents of every shape", () => {
    for (const text of [
      "- a\n- b\n",
      "plain scalar\n",
      "42\n",
      "null\n",
      "true\n",
    ]) {
      expect(codes(loadSpec(text).issues)).toEqual(["not-an-object"]);
    }
  });

  it("allows exactly 100 documents and rejects 101", () => {
    const stream = (n: number) =>
      Array.from({ length: n }, () => agentYaml).join("---\n");
    const ok = loadSpec(stream(100));
    expect(ok.valid).toBe(true);
    expect(ok.documents).toHaveLength(100);
    expect(codes(loadSpec(stream(101)).issues)).toEqual(["too-many-documents"]);
  });

  it("JSON text holds one document: two concatenated objects are a syntax error", () => {
    const r = loadSpec(`${agentJson}${agentJson}`, { format: "json" });
    expect(codes(r.issues)).toEqual(["syntax"]);
    const jsonArray = loadSpec(`[${agentJson}]`, { format: "json" });
    expect(codes(jsonArray.issues)).toEqual(["not-an-object"]);
  });
});

describe("input types and limits", () => {
  it("rejects invalid UTF-8 bytes, an ArrayBuffer, and non-text values as invalid-input", () => {
    expect(codes(loadSpec(new Uint8Array([0xff, 0xfe, 0x41])).issues)).toEqual([
      "invalid-input",
    ]);
    for (const bad of [
      new ArrayBuffer(8),
      42,
      null,
      undefined,
      {},
      [],
      Symbol.iterator,
      () => 1,
    ]) {
      const r = loadSpec(bad as unknown as string);
      expect(r.valid).toBe(false);
      expect(codes(r.issues)).toEqual(["invalid-input"]);
    }
  });

  it("rejects empty and whitespace-only input", () => {
    expect(codes(loadSpec("").issues)).toEqual(["empty"]);
    expect(loadSpec("  \n").valid).toBe(false);
    expect(loadSpec(new Uint8Array()).valid).toBe(false);
    expect(loadSpec("# only a comment\n").valid).toBe(false);
  });

  it("counts bytes, not characters, against the 1 MiB limit", () => {
    // 600k two-byte characters is 1.2 MB but fewer than 1 MiB characters.
    const text = `# ${"é".repeat(600_000)}\n${agentYaml}`;
    expect(text.length).toBeLessThan(1024 * 1024);
    expect(codes(loadSpec(text).issues)).toEqual(["too-large"]);
    expect(codes(loadSpec(new TextEncoder().encode(text)).issues)).toEqual([
      "too-large",
    ]);
    // Just under the limit is fine.
    const padding = "a".repeat(1024 * 1024 - agentYaml.length - 4);
    expect(loadSpec(`# ${padding}\n${agentYaml}`).valid).toBe(true);
  });

  it("rejects deeply nested flow collections without exhausting the stack", () => {
    const deep = `a: ${"[".repeat(5000)}${"]".repeat(5000)}\n`;
    expect(codes(loadSpec(deep).issues)).toEqual(["too-deep"]);
    const deepJson = `${"[".repeat(5000)}${"]".repeat(5000)}`;
    expect(codes(loadSpec(deepJson, { format: "json" }).issues)).toEqual([
      "too-deep",
    ]);
  });

  it("rejects YAML hazards: aliases, anchors, merge keys, tags, non-string and duplicate keys", () => {
    const cases: Array<[string, string]> = [
      ["a: &x 1\nb: *x\n", "yaml-alias"],
      ["a: &x 1\n", "yaml-alias"],
      ["a: {b: 1}\nc:\n  <<: {d: 2}\n", "yaml-merge-key"],
      ["a: !!binary AAAA\n", "yaml-tag"],
      ["a: !custom x\n", "yaml-tag"],
      ["1: a\n", "non-string-key"],
      ["true: a\n", "non-string-key"],
      ["a: 1\na: 2\n", "duplicate-key"],
      ["__proto__: {x: 1}\n", "forbidden-key"],
    ];
    for (const [text, code] of cases) {
      const r = loadSpec(text);
      expect(r.valid).toBe(false);
      expect(codes(r.issues)).toContain(code);
    }
  });

  it("a billion-laughs document is rejected without expanding", () => {
    const laughs = ["a: &a [x, x, x, x, x, x, x, x, x]"];
    for (const [prev, next] of [
      ["a", "b"],
      ["b", "c"],
      ["c", "d"],
      ["d", "e"],
    ] as const)
      laughs.push(
        `${next}: &${next} [${Array(9).fill(`*${prev}`).join(", ")}]`,
      );
    const r = loadSpec(`${laughs.join("\n")}\n`);
    expect(r.valid).toBe(false);
    expect(codes(r.issues)).toContain("yaml-alias");
    expect(r.documents).toEqual([]);
  });
});

describe("loadSpecFile", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "sirb-core-files-"));
    writeFileSync(join(dir, "agent.yaml"), agentYaml);
    writeFileSync(join(dir, "agent.yml"), agentYaml);
    writeFileSync(join(dir, "agent.json"), agentJson);
    writeFileSync(join(dir, "agent.txt"), agentYaml);
    writeFileSync(join(dir, "yaml-in-json.json"), agentYaml);
    writeFileSync(join(dir, "bad-bytes.yaml"), Buffer.from([0xff, 0xfe, 0xfd]));
    writeFileSync(join(dir, "secret.yaml"), `${agentYaml}  apiKey: ${FAKE}\n`);
    writeFileSync(join(dir, "empty.yaml"), "");
    mkdirSync(join(dir, "a-directory.yaml"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it.each(["agent.yaml", "agent.yml", "agent.json", "agent.txt"])(
    "loads %s",
    async (name) => {
      const r = await loadSpecFile(join(dir, name));
      expect(r).toMatchObject({ valid: true, issues: [] });
      expect(r.documents).toEqual([agentObj]);
    },
  );

  it("uses the extension for the format and lets an explicit format override it", async () => {
    expect(
      codes((await loadSpecFile(join(dir, "yaml-in-json.json"))).issues),
    ).toEqual(["syntax"]);
    expect(
      (await loadSpecFile(join(dir, "yaml-in-json.json"), { format: "yaml" }))
        .valid,
    ).toBe(true);
    expect(
      (await loadSpecFile(join(dir, "agent.json"), { format: "yaml" })).valid,
    ).toBe(true);
  });

  it("returns an io issue, and never rejects, for a missing file or a directory", async () => {
    for (const name of [
      "no-such-file.yaml",
      "a-directory.yaml",
      "no/such/dir/x.yaml",
    ]) {
      const r = await loadSpecFile(join(dir, name));
      expect(r).toMatchObject({ valid: false, documents: [] });
      expect(codes(r.issues)).toEqual(["io"]);
      expect(r.issues[0]?.severity).toBe("error");
    }
  });

  it("reports invalid bytes and empty files as issues", async () => {
    expect(
      codes((await loadSpecFile(join(dir, "bad-bytes.yaml"))).issues),
    ).toEqual(["invalid-input"]);
    expect(codes((await loadSpecFile(join(dir, "empty.yaml"))).issues)).toEqual(
      ["empty"],
    );
  });

  it("does not put file content in any issue message", async () => {
    const r = await loadSpecFile(join(dir, "secret.yaml"));
    expect(r.valid).toBe(false);
    expect(codes(r.issues)).toContain("literal-secret");
    expect(JSON.stringify(r.issues)).not.toContain(FAKE);
  });
});

describe("error text never contains source content", () => {
  // The secret sits in a value in each document. Parsers quote source in some
  // messages, so each case checks the SirbSpecError message and every issue.
  const secretYaml = (extra: string) => `${agentYaml}${extra}`;
  const cases: Array<[string, string, "yaml" | "json"]> = [
    ["a literal secret in a field", secretYaml(`  apiKey: ${FAKE}\n`), "yaml"],
    [
      "a literal secret in an array",
      secretYaml(`  token: [${FAKE}]\n`),
      "yaml",
    ],
    ["a wrong-typed value", secretYaml(`  maxIterations: ${FAKE}\n`), "yaml"],
    ["a wrong enum value", agentYaml.replace("support-agent", FAKE), "yaml"],
    ["an unterminated string", `apiKey: "${FAKE}\nx: 1\n`, "yaml"],
    ["a YAML syntax error after the value", `a: [${FAKE}\nb: ]]\n`, "yaml"],
    ["a stray YAML token", `${FAKE}\n: ${FAKE}\n`, "yaml"],
    [
      "a JSON syntax error after the value",
      `{"apiKey": "${FAKE}" oops}`,
      "json",
    ],
    ["a JSON trailing comma", `{"apiKey": "${FAKE}",}`, "json"],
    ["a JSON bare word", `{"a": ${FAKE}}`, "json"],
    ["a JSON error right after the value", `["${FAKE}", ]`, "json"],
    // The YAML parser echoes these tokens in its own messages.
    ["a literal block scalar header", `x: |${FAKE}\n  a\n`, "yaml"],
    ["a folded block scalar header", `x: >-${FAKE}\n  a\n`, "yaml"],
    ["an unknown directive", `%${FAKE} x\n---\na: b\n`, "yaml"],
    ["an unresolved tag", `x: !${FAKE} v\n`, "yaml"],
    ["a tag with a handle", `x: !e!${FAKE} v\n`, "yaml"],
    ["an anchor name", `x: &${FAKE} v\n`, "yaml"],
    ["an alias name", `x: *${FAKE}\n`, "yaml"],
    [
      "a duplicate key that is the secret",
      `a: 1\n${FAKE}: 2\n${FAKE}: 3\n`,
      "yaml",
    ],
    [
      "a JSON duplicate key that is the secret",
      `{"${FAKE}": 1, "${FAKE}": 2}`,
      "json",
    ],
    ["a JSON document that is only the secret", FAKE, "json"],
    ["a JSON array document", `["${FAKE}"]`, "json"],
    ["a YAML scalar document", `${FAKE}\n`, "yaml"],
    ["an alias", `a: ${FAKE}\nb: *x\n`, "yaml"],
    [
      "a duplicate key with the secret as value",
      `a: ${FAKE}\na: ${FAKE}\n`,
      "yaml",
    ],
    ["a merge key", `a: ${FAKE}\nb:\n  <<: {c: 1}\n`, "yaml"],
    ["a non-string key", `1: ${FAKE}\n`, "yaml"],
    [
      "a credential-shaped comment",
      `# ${GH}\n${agentYaml}  apiKey: x\n`,
      "yaml",
    ],
    [
      "a credential-shaped value in free text",
      agentYaml.replace("Be helpful.", `use ${GH}`) + "  bogus: 1\n",
      "yaml",
    ],
  ];

  it.each(cases)("%s", (_label, source, format) => {
    // Every fake credential in this file carries the marker FAKE, so a partial
    // quote of one (a parser excerpt) is caught too, not only a full copy.
    for (const secret of ["FAKE", FAKE, GH]) {
      let error: unknown;
      try {
        loadSpecOrThrow(source, { format, filename: "agent.yaml" });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(SirbSpecError);
      const e = error as SirbSpecError;
      expect(e.message).not.toContain(secret);
      expect(e.stack ?? "").not.toContain(secret);
      for (const issue of e.issues) {
        expect(issue.message).not.toContain(secret);
        expect(JSON.stringify(issue)).not.toContain(secret);
      }
    }
  });

  it("keeps the secret out of loadSpec results too, not just the thrown error", () => {
    for (const [, source, format] of cases) {
      const r = loadSpec(source, { format });
      expect(JSON.stringify(r)).not.toContain("FAKE");
    }
  });

  it("the thrown message names only locators, even for a secret in a key, tag or anchor", () => {
    // Keys, tags and anchors may be echoed by the parser, but the thrown message must not.
    for (const source of [
      `a: 1\n${FAKE}: 1\n${FAKE}: 2\n`,
      `a: !${FAKE} x\n`,
      `a: &${FAKE} x\n`,
      `${agentYaml}  ${FAKE}: 1\n`,
    ]) {
      expect(() => loadSpecOrThrow(source)).toThrow(SirbSpecError);
      try {
        loadSpecOrThrow(source);
      } catch (e) {
        expect((e as Error).message).not.toContain(FAKE);
        expect((e as Error).message).toMatch(
          /^invalid Sirb spec: \d+ error\(s\); first: \[/,
        );
      }
    }
  });

  it("parser-facing codes get one fixed message each, plus a position for syntax", () => {
    const SYNTAX = "the text is not well-formed YAML 1.2 or JSON";
    expect(loadSpec(`{"a": ${FAKE}}`, { format: "json" }).issues).toEqual([
      expect.objectContaining({ code: "syntax", message: SYNTAX }),
    ]);
    expect(loadSpec(`${FAKE}\n: x\n`).issues.map((i) => i.message)).toEqual([
      SYNTAX,
      SYNTAX,
    ]);
    // A position or line/column is kept: digits only, no source text.
    expect(
      loadSpec('{"a":1 "b":2}', { format: "json" }).issues[0]?.message,
    ).toBe(`${SYNTAX} at line 1, column 8`);
    const message = (source: string) => loadSpec(source).issues[0]?.message;
    expect(message(`x: !${FAKE} v\n`)).toBe("explicit tags are not allowed");
    expect(message(`x: &${FAKE} v\n`)).toBe(
      "anchors and aliases are not allowed",
    );
    expect(message(`a: 1\n${FAKE}: 2\n${FAKE}: 3\n`)).toBe(
      "duplicate mapping key",
    );
  });
});
