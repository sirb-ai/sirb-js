import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import * as api from "../src/index.js";
import { packageName } from "../src/index.js";

describe("@sirb/core", () => {
  it("exports a packageName matching package.json", () => {
    expect(packageName).toBe(pkg.name);
  });

  it("exports exactly the documented runtime API, and none of the test tooling", () => {
    // The conformance runner and plain-data helpers are internal.
    expect(Object.keys(api).sort()).toEqual([
      "SirbSpecError",
      "defineAgent",
      "loadSpec",
      "loadSpecFile",
      "loadSpecOrThrow",
      "packageName",
      "validateSpec",
    ]);
  });
});
