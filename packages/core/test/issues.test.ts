import { describe, expect, it } from "vitest";
import {
  SirbSpecError,
  describeIssue,
  isError,
  type SpecIssue,
} from "../src/issues.js";

const error = (extra: Partial<SpecIssue> = {}): SpecIssue => ({
  code: "schema",
  severity: "error",
  message: "must NOT have additional properties FAKE-message",
  ...extra,
});
const warning = (extra: Partial<SpecIssue> = {}): SpecIssue => ({
  code: "possible-secret",
  severity: "warning",
  message: "value looks like a credential",
  ...extra,
});

describe("describeIssue", () => {
  it("names the code and every locator field, in a fixed order", () => {
    expect(
      describeIssue(
        error({
          document: 2,
          line: 7,
          instancePath: "/spec/tools/0",
          keyword: "type",
        }),
      ),
    ).toBe("[schema] document 2 line 7 /spec/tools/0 type");
  });

  it("masks credential-shaped and non-plain pointer segments in the message only", () => {
    const tok = "sk-ant-api03-FAKEFAKEFAKEFAKEFAKEFAKE";
    const issue = error({
      instancePath: `/spec/inputSchema/properties/${tok}/type`,
      keyword: "type",
    });
    expect(describeIssue(issue)).toBe(
      "[schema] /spec/inputSchema/properties/*/type type",
    );
    // Long, escaped (~0 ~1), empty, spaced or non-ASCII segments are masked;
    // indices and plain names stay.
    expect(
      describeIssue(
        error({
          instancePath: `/a/${"x".repeat(65)}/b~1c/d~0e//f g/ключ/0/$ref/x.y-z_1`,
        }),
      ),
    ).toBe("[schema] /a/*/*/*/*/*/*/0/$ref/x.y-z_1");
    // A short segment that is still credential-shaped (32-hex key).
    expect(
      describeIssue(
        error({ instancePath: "/h/0123456789abcdef0123456789abcdef" }),
      ),
    ).toBe("[schema] /h/*");

    const e = new SirbSpecError([issue]);
    expect(e.message).not.toContain("FAKE");
    expect(e.stack ?? "").not.toContain("FAKE");
    expect(e.issues[0]?.instancePath).toBe(
      `/spec/inputSchema/properties/${tok}/type`,
    );
  });

  it("prints the root as (root) and skips missing fields", () => {
    expect(describeIssue(error({ instancePath: "" }))).toBe("[schema] (root)");
    expect(describeIssue(error())).toBe("[schema]");
    expect(describeIssue(error({ document: 0 }))).toBe("[schema] document 0");
  });

  it("never prints the message or the property name", () => {
    const text = describeIssue(
      error({
        instancePath: "/spec",
        keyword: "additionalProperties",
        property: "FAKE-key",
      }),
    );
    expect(text).not.toContain("FAKE");
  });
});

describe("SirbSpecError", () => {
  it("is an Error with a stable name", () => {
    const e = new SirbSpecError([error()]);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(SirbSpecError);
    expect(e.name).toBe("SirbSpecError");
  });

  it("counts errors only and names the first error, not an earlier warning", () => {
    const e = new SirbSpecError([
      warning({ instancePath: "/w" }),
      error({ instancePath: "/a" }),
      error({ instancePath: "/b" }),
    ]);
    expect(e.message).toBe("invalid Sirb spec: 2 error(s); first: [schema] /a");
    expect(e.issues).toHaveLength(3);
    expect(e.errors.map((i) => i.instancePath)).toEqual(["/a", "/b"]);
  });

  it("falls back to the first issue when there are only warnings, and to nothing when empty", () => {
    expect(new SirbSpecError([warning({ instancePath: "/w" })]).message).toBe(
      "invalid Sirb spec: 0 error(s); first: [possible-secret] /w",
    );
    const none = new SirbSpecError([]);
    expect(none.message).toBe("invalid Sirb spec: 0 error(s)");
    expect(none.errors).toEqual([]);
  });

  it("prefixes the filename, and skips an empty one", () => {
    expect(new SirbSpecError([error()], "agents/a.yaml").message).toMatch(
      /^agents\/a\.yaml: invalid Sirb spec: 1 error\(s\)/,
    );
    expect(new SirbSpecError([error()], "").message).toMatch(
      /^invalid Sirb spec/,
    );
  });

  it("copies and freezes the issues, so later changes to the input do not leak in", () => {
    const input = [error({ instancePath: "/a" })];
    const e = new SirbSpecError(input);
    input.push(error({ instancePath: "/b" }));
    expect(e.issues).toHaveLength(1);
    expect(Object.isFrozen(e.issues)).toBe(true);
    expect(() => (e.issues as SpecIssue[]).push(error())).toThrow(TypeError);
  });

  it("never copies issue messages into its own message", () => {
    const e = new SirbSpecError([
      error({ instancePath: "/spec", keyword: "type", property: "FAKE-prop" }),
    ]);
    expect(e.message).not.toContain("FAKE");
  });

  it("isError is true for errors only", () => {
    expect(isError(error())).toBe(true);
    expect(isError(warning())).toBe(false);
  });
});
