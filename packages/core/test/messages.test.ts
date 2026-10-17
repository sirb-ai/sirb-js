// Issue messages are an allowlist: only `schema` and `possible-secret` keep the
// reference loader's wording; every other code gets a fixed message.
import { describe, expect, it } from "vitest";
import { safeMessage } from "../src/messages.js";

const FAKE = "FAKE-s3cr3t-VALUE";
const raw = (code: string, message: string) =>
  ({ code, severity: "error", message }) as const;

describe("safeMessage", () => {
  it.each([
    ["syntax", `Unknown directive %${FAKE}`],
    ["syntax", `Block scalar header includes extra characters: |${FAKE}`],
    ["internal", `loader failure: ${FAKE}`],
    ["internal", `parser failure: ${FAKE}`],
    ["yaml-tag", `Unresolved tag: !${FAKE}`],
    ["yaml-alias", `anchors are not allowed (&${FAKE})`],
    ["duplicate-key", `duplicate key "${FAKE}"`],
    ["invalid-regex", `invalid nested repetition operator: \`${FAKE}**\``],
    ["literal-secret", `"${FAKE}" holds a secret; use a secretRef`],
    ["invalid-format", `unsupported format: ${FAKE}`],
    ["io", `cannot read /home/${FAKE}/a.yaml: ENOENT`],
    ["a-future-code", FAKE],
    ["constructor", FAKE],
  ])("never repeats source text for %s", (code, message) => {
    const out = safeMessage(raw(code, message));
    expect(out).not.toContain("FAKE");
    expect(out.length).toBeGreaterThan(0);
  });

  it("gives every documented code its own fixed message", () => {
    expect(safeMessage(raw("internal", "x"))).toBe("unexpected loader failure");
    expect(safeMessage(raw("a-future-code", "x"))).toBe("invalid document");
    expect(safeMessage(raw("too-deep", "x"))).toBe("nesting exceeds 64 levels");
  });

  it("keeps only digits from a position", () => {
    expect(
      safeMessage(raw("syntax", `"${FAKE}" at position 12 (line 3 column 4)`)),
    ).toBe("the text is not well-formed YAML 1.2 or JSON at line 3, column 4");
    expect(safeMessage(raw("syntax", `${FAKE} at position 12`))).toBe(
      "the text is not well-formed YAML 1.2 or JSON at position 12",
    );
    expect(safeMessage(raw("syntax", `${FAKE} at line 2, column 9:`))).toBe(
      "the text is not well-formed YAML 1.2 or JSON at line 2, column 9",
    );
  });

  it("passes schema and possible-secret wording through", () => {
    expect(safeMessage(raw("schema", 'must match pattern "^a$"'))).toBe(
      'must match pattern "^a$"',
    );
    const warning = "value looks like a credential (known credential prefix)";
    expect(
      safeMessage({ ...raw("possible-secret", warning), severity: "warning" }),
    ).toBe(warning);
  });
});
