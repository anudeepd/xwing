#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const DEFAULT_HOST = "https://sonarcloud.io";
const DEFAULT_PROJECT = "anudeepd_xwing";
const METRICS = [
  "coverage",
  "line_coverage",
  "branch_coverage",
  "duplicated_lines",
  "duplicated_lines_density",
];

/**
 * Compare Sonar measures with X-wing's required quality threshold.
 *
 * @param {Record<string, number | string | null | undefined>} measures
 * @returns {string[]}
 */
export function evaluateSonarMetrics(measures) {
  const failures = [];
  const requireFull = (metric) => {
    const value = Number(measures[metric]);
    if (!Number.isFinite(value) || value < 100) {
      failures.push(`${metric} must be 100.0 (got ${measures[metric] ?? "missing"})`);
    }
  };
  const requireZero = (metric) => {
    const value = Number(measures[metric]);
    if (!Number.isFinite(value) || value !== 0) {
      failures.push(`${metric} must be 0 (got ${measures[metric] ?? "missing"})`);
    }
  };

  for (const metric of ["coverage", "line_coverage", "branch_coverage"]) {
    requireFull(metric);
  }
  for (const metric of ["duplicated_lines", "duplicated_lines_density"]) {
    requireZero(metric);
  }
  return failures;
}

/**
 * @param {{host: string, project: string, token?: string, fetcher?: typeof fetch}} options
 * @returns {Promise<Record<string, string>>}
 */
export async function fetchSonarMetrics({
  host,
  project,
  token,
  fetcher = fetch,
}) {
  const url = new URL("/api/measures/component", host);
  url.searchParams.set("component", project);
  url.searchParams.set("metricKeys", METRICS.join(","));
  const headers = { Accept: "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetcher(url, { headers });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Sonar metrics request failed (${response.status})${detail ? `: ${detail.slice(0, 300)}` : ""}`,
    );
  }
  const payload = await response.json();
  return Object.fromEntries(
    (payload?.component?.measures ?? []).map((measure) => [
      measure.metric,
      measure.value,
    ]),
  );
}

export async function main() {
  const measures = await fetchSonarMetrics({
    host: process.env.SONAR_HOST_URL || DEFAULT_HOST,
    project: process.env.SONAR_PROJECT_KEY || DEFAULT_PROJECT,
    token: process.env.SONAR_TOKEN,
  });
  const failures = evaluateSonarMetrics(measures);
  if (failures.length) {
    console.error("Sonar quality guard failed:");
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log(
    "Sonar quality guard passed: coverage 100%, branch coverage 100%, duplicated lines 0.",
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(`Sonar quality guard failed: ${error.message}`);
    process.exitCode = 1;
  });
}
