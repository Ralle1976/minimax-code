import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { MAX_INLINE_CONFIGURED_TOOLS } from '../../../agent-tools/src/mcp-disclosure/plan.js';
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
const MCP_TOOLS_PER_SERVER = 10;
// A 1M window isolates the configured-tool count cap from the token threshold:
// at that size the token budget never triggers, so only the count rule can defer.
const MCP_CONTEXT_WINDOWS = [16_384, 131_072, 262_144, 1_048_576];

let report: CapabilityBenchReport;

// The full matrix renders up to 200 long-form skill catalogs and plans 48 MCP
// disclosure variants. That exceeds Vitest's default 10s hook timeout on a
// loaded machine, so the matrix gets its own budget.
const MATRIX_TIMEOUT_MS = 600_000;

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
            profile === 'cap' && count >= 100 ? 3 : 5,
            profile,
          ).row,
        );
      }
    }
  }

  const mcp = [];
  for (const servers of MCP_SERVER_COUNTS) {
    const entries = buildMcpToolFixtures({ servers, toolsPerServer: MCP_TOOLS_PER_SERVER, profile: 'realistic' });
    const scenario = `mcp-realistic-${servers}x${MCP_TOOLS_PER_SERVER}`;
    for (const window of MCP_CONTEXT_WINDOWS) {
      mcp.push(
        ...measureMcpDisclosure(scenario, entries, disclosureVariants(), window, {
          servers,
          toolsPerServer: MCP_TOOLS_PER_SERVER,
        }),
      );
    }
  }

  report = { meta: { ...BENCH_META }, skills, mcp };
}, MATRIX_TIMEOUT_MS);

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
    expect(second.row.visibleSkillNames).toEqual(first.row.visibleSkillNames);
  });

  it('production default disclosure defers nothing (empty whitelist baseline)', () => {
    const rows = report.mcp.filter((entry) => entry.variant === 'production-default');
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.deferred).toBe(false);
      expect(row.status).toBe('not-deferred-model-whitelist');
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

  it('the configured-tool count cap defers even when the token budget would allow inline tools', () => {
    // 20 servers x 10 tools = 200 configured tools, above the cap of 64, while a
    // 1M context window raises the token threshold far above the catalog size.
    const rows = report.mcp.filter(
      (entry) =>
        entry.variant === 'enabled-whitelist-*' &&
        entry.contextWindowTokens === 1_048_576 &&
        entry.configuredToolCount > MAX_INLINE_CONFIGURED_TOOLS,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.deferred).toBe(true);
      const fitsTokenBudget = (row.plannerEstTokensChars4 ?? 0) <= (row.plannerThresholdChars4 ?? 0);
      // With the token threshold out of reach, only the count rule can defer.
      expect(row.status).toBe(
        fitsTokenBudget
          ? 'deferred-by-tool-count'
          : 'deferred-by-tool-count-and-token-threshold',
      );
    }
    // At least one catalog in the matrix must be deferred by the count rule alone.
    expect(
      rows.some((row) => row.status === 'deferred-by-tool-count'),
      'no catalog was deferred by the configured-tool count cap alone',
    ).toBe(true);
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
