import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  BENCH_META,
  disclosureVariants,
  formatMcpRows,
  formatSkillRows,
  measureMcpDisclosure,
  measureSkillsCatalog,
  type CapabilityBenchReport,
} from './capability-catalog-overhead.js';
import { buildMcpToolFixtures, buildSkillCatalogFixtures } from './capability-fixtures.js';

// Default: fast reduced matrix that still exercises every contract.
// CAPABILITY_BENCH=full runs the full matrix for the published numbers.
// CAPABILITY_BENCH_OUT=<path> additionally writes the JSON report (never written by default).
const FULL = process.env.CAPABILITY_BENCH === 'full';

const SKILL_COUNTS = FULL ? [10, 50, 100, 200] : [10, 50];
const SKILL_PROFILES = ['short', 'realistic', 'cap'] as const;
const CONTEXT_WINDOWS = [16_384, 131_072, 262_144];
const MCP_SERVER_COUNTS = FULL ? [5, 20, 50] : [5, 20];

let report: CapabilityBenchReport;

beforeAll(() => {
  const skills = [];
  for (const count of SKILL_COUNTS) {
    for (const profile of SKILL_PROFILES) {
      // cap-profile fixtures at 200 skills make the renderer's binary search
      // tokenize megabytes; they only pay off in the opt-in full run.
      if (profile === 'cap' && count > 100 && !FULL) continue;
      for (const window of CONTEXT_WINDOWS) {
        const scenario = `skills-${profile}-${count}`;
        skills.push(
          measureSkillsCatalog(
            scenario,
            buildSkillCatalogFixtures({ count, profile }),
            window,
          ).row,
        );
      }
    }
  }

  const mcp = [];
  for (const servers of MCP_SERVER_COUNTS) {
    const entries = buildMcpToolFixtures({ servers, toolsPerServer: 10, profile: 'realistic' });
    const scenario = `mcp-realistic-${servers}x10`;
    mcp.push(...measureMcpDisclosure(scenario, entries, disclosureVariants()));
  }

  report = { meta: { ...BENCH_META }, skills, mcp };
});

describe('capability catalog overhead bench', () => {
  it('rendered skill catalogs never exceed the context budget (renderer contract)', () => {
    for (const row of report.skills) {
      expect(
        row.catalogTokens,
        `${row.scenario} @ ${row.contextWindowTokens} exceeded budget ${row.budgetTokens}`,
      ).toBeLessThanOrEqual(row.budgetTokens);
      expect(row.renderMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('skill rendering is deterministic for identical fixtures', () => {
    const skills = buildSkillCatalogFixtures({ count: 50, profile: 'realistic' });
    const first = measureSkillsCatalog('determinism', skills, 131_072);
    const second = measureSkillsCatalog('determinism', skills, 131_072);
    expect(second.catalog).toBe(first.catalog);
    expect(second.row.catalogTokens).toBe(first.row.catalogTokens);
    expect(second.row.entriesRendered).toBe(first.row.entriesRendered);
  });

  it('production default disclosure defers nothing (empty whitelist baseline)', () => {
    for (const row of report.mcp.filter((entry) => entry.variant === 'production-default')) {
      expect(row.deferred).toBe(false);
      expect(row.inlineTokens).toBe(row.fullCatalogTokens);
    }
  });

  it('enabled disclosure defers large catalogs and cuts the inline token surface', () => {
    for (const row of report.mcp.filter((entry) => entry.variant === 'enabled-whitelist-*')) {
      const full = report.mcp.find(
        (entry) => entry.scenario === row.scenario && entry.variant === 'off',
      );
      expect(full).toBeDefined();
      if (row.deferred) {
        expect(row.discoveryToolTokens).toBeGreaterThan(0);
        expect(row.inlineTokens).toBeLessThan(full!.fullCatalogTokens / 2);
        expect(row.searchMs).toBeGreaterThanOrEqual(0);
      } else {
        // Small catalogs stay inline by design (threshold not reached).
        expect(row.inlineTokens).toBe(full!.fullCatalogTokens);
      }
    }
  });

  it('emits the report', () => {
    expect(report.skills.length).toBeGreaterThan(0);
    expect(report.mcp.length).toBeGreaterThan(0);
    if (FULL || process.env.CAPABILITY_BENCH_OUT) {
      process.stdout.write(`\n${formatSkillRows(report.skills)}\n\n${formatMcpRows(report.mcp)}\n`);
    }
    const outPath = process.env.CAPABILITY_BENCH_OUT;
    if (outPath) {
      const absolute = resolve(outPath);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`);
    }
  });
});
