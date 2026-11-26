import { describe, expect, it } from "vitest";

import { evaluateSonarMetrics } from "../check-sonar-quality.mjs";

const passing = {
  coverage: "100.0",
  line_coverage: "100.0",
  branch_coverage: "100.0",
  duplicated_lines: "0",
  duplicated_lines_density: "0.0",
};

describe("Sonar quality guard", () => {
  it("accepts full coverage and zero duplication", () => {
    expect(evaluateSonarMetrics(passing)).toEqual([]);
  });

  it("rejects incomplete coverage", () => {
    expect(
      evaluateSonarMetrics({ ...passing, coverage: "99.1" }),
    ).toContain("coverage must be 100.0 (got 99.1)");
    expect(
      evaluateSonarMetrics({ ...passing, branch_coverage: "97.2" }),
    ).toContain("branch_coverage must be 100.0 (got 97.2)");
  });

  it("rejects any duplicated lines", () => {
    expect(
      evaluateSonarMetrics({
        ...passing,
        duplicated_lines: "30",
        duplicated_lines_density: "0.2",
      }),
    ).toEqual([
      "duplicated_lines must be 0 (got 30)",
      "duplicated_lines_density must be 0 (got 0.2)",
    ]);
  });

  it("rejects missing measures", () => {
    expect(evaluateSonarMetrics({})).toHaveLength(5);
  });
});
