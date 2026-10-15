import { describe, expect, it } from "vitest";
import pkg from "../package.json" with { type: "json" };
import { packageName } from "../src/index.js";

describe("@sirb/gateway-client", () => {
  it("exports a packageName matching package.json", () => {
    expect(packageName).toBe(pkg.name);
  });
});
