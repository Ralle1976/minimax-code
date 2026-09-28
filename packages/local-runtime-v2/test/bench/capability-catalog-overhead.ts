import {
  createMcpInvokeTool,
  createToolSearchTool,
  planMcpDisclosure,
  type McpDisclosureOptions,
  type McpModelIdentity,
  type McpToolEntry,
} from '@mavis/agent-tools';
import { createDefaultTokenEstimator, type TokenEstimator } from '@mavis/context-manager';
import {
  renderLocalSkillsCatalogResult,
  resolveLocalSkillCatalogBudgetTokens,
  type LocalSkillsCatalogEntry,
} from '@mavis/local-runtime';
import { resolveLocalMcpDisclosureOptions } from '../../src/service/turn-system/agent-host/assembly/local-turn-tool-catalog.js';

// Measurement source of truth is the production token estimator used by the
// skills catalog budget itself (o200k_base BPE via gpt-tokenizer).
const estimator: TokenEstimator = createDefaultTokenEstimator();
const countTokens = (text: string): number => estimator.estimateTextTokens(text);
const chars4 = (text: string): number => Math.ceil(text.length / 4);

function toolJson(tools: readonly { def: { name: string; description: string; schema: unknown } }[]): string {
  return JSON.stringify(
    tools.map((tool) => ({ name: tool.def.name, description: tool.def.description, schema: tool.def.schema })),
  );
}

function medianMs(runs: readonly number[]): number {
  if (runs.length === 0) return 0;
  const sorted = [...runs].sort((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)] * 1000) / 1000;
}

function medianOf(runs: number, run: () => void): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    run();
    samples.push(performance.now() - start);
  }
  return medianMs(samples);
}

export interface SkillsCatalogRow {
  scenario: string;
  contextWindowTokens: number;
  budgetTokens: number;
  skillsRequested: number;
  entriesRendered: number;
  catalogTokens: number;
  chars4Tokens: number;
  softOverflow: boolean;
  hardOverflow: boolean;
  descriptionCapTruncated: boolean;
  renderMs: number;
}

export function measureSkillsCatalog(
  scenario: string,
  skills: readonly LocalSkillsCatalogEntry[],
  contextWindowTokens: number,
  renderRuns = 7,
): { row: SkillsCatalogRow; catalog: string } {
  const render = (): string => renderLocalSkillsCatalogResult(skills, { contextWindowTokens }).catalog;
  const catalog = renderLocalSkillsCatalogResult(skills, { contextWindowTokens });
  const row: SkillsCatalogRow = {
    scenario,
    contextWindowTokens,
    budgetTokens: resolveLocalSkillCatalogBudgetTokens(contextWindowTokens),
    skillsRequested: skills.length,
    entriesRendered: catalog.catalog ? catalog.catalog.split('\n').filter((l) => l.startsWith('- ')).length : 0,
    catalogTokens: countTokens(catalog.catalog),
    chars4Tokens: chars4(catalog.catalog),
    softOverflow: catalog.softOverflow,
    hardOverflow: catalog.hardOverflow,
    descriptionCapTruncated: catalog.descriptionCapTruncated,
    renderMs: medianOf(renderRuns, render),
  };
  return { row, catalog: catalog.catalog };
}

export interface McpDisclosureRow {
  scenario: string;
  variant: string;
  contextWindowTokens: number;
  deferred: boolean;
  inlineToolCount: number;
  inlineTokens: number;
  discoveryToolTokens: number;
  fullCatalogTokens: number;
  fullCatalogChars4: number;
  plannerEstTokensChars4?: number;
  plannerThresholdChars4?: number;
  planMs: number;
  searchMs?: number;
}

export function measureMcpDisclosure(
  scenario: string,
  entries: readonly McpToolEntry[],
  variants: readonly { name: string; options: McpDisclosureOptions }[],
  contextWindowTokens = 131_072,
): McpDisclosureRow[] {
  const fullJson = toolJson(entries.map((entry) => entry.tool));
  const fullCatalogTokens = countTokens(fullJson);
  const model: McpModelIdentity = { provider: 'bench', id: 'bench-model', contextWindow: contextWindowTokens };

  return variants.map((variant) => {
    const start = performance.now();
    const plan = planMcpDisclosure({ entries, model, options: variant.options });
    const planMs = Math.round((performance.now() - start) * 1000) / 1000;
    let inlineTokens = countTokens(toolJson(plan.inlineTools));
    let discoveryToolTokens = 0;
    let searchMs: number | undefined;
    if (plan.deferred) {
      const searchTool = createToolSearchTool(plan.index, {
        topKDefault: variant.options.topKDefault,
        topKMax: variant.options.topKMax,
      });
      const invokeTool = createMcpInvokeTool(plan.deferredRegistry);
      discoveryToolTokens = countTokens(toolJson([searchTool, invokeTool]));
      inlineTokens += discoveryToolTokens;
      const searchStart = performance.now();
      plan.index.search({
        query: 'create a github issue then export a report of the results',
        topK: variant.options.topKDefault,
      });
      searchMs = medianOf(5, () =>
        plan.index.search({
          query: 'create a github issue then export a report of the results',
          topK: variant.options.topKDefault,
        }),
      );
    }
    return {
      scenario,
      variant: variant.name,
      contextWindowTokens,
      deferred: plan.deferred,
      inlineToolCount: plan.inlineTools.length,
      inlineTokens,
      discoveryToolTokens,
      fullCatalogTokens,
      fullCatalogChars4: chars4(fullJson),
      plannerEstTokensChars4: plan.deferred ? plan.stats.estTokens : undefined,
      plannerThresholdChars4: plan.deferred ? plan.stats.thresholdTokens : undefined,
      planMs,
      searchMs,
    };
  });
}

// resolveLocalMcpDisclosureOptions(undefined, {}) is the production baseline:
// enabled=true, but the default model whitelist is empty, so nothing defers
// unless a user configures mcpToolSearch.modelWhitelist.
export function disclosureVariants(): { name: string; options: McpDisclosureOptions }[] {
  const productionDefault = resolveLocalMcpDisclosureOptions(undefined, {});
  return [
    { name: 'off', options: { ...productionDefault, enabled: false } },
    { name: 'production-default', options: productionDefault },
    { name: 'enabled-whitelist-*', options: { ...productionDefault, modelWhitelist: ['*'] } },
    {
      name: 'aggressive-2pct',
      options: { ...productionDefault, modelWhitelist: ['*'], thresholdPct: 0.02 },
    },
  ];
}

export interface CapabilityBenchReport {
  meta: {
    estimator: string;
    chars4Note: string;
    disclosureNote: string;
  };
  skills: SkillsCatalogRow[];
  mcp: McpDisclosureRow[];
}

export const BENCH_META = {
  estimator: 'createDefaultTokenEstimator() from @mavis/context-manager (o200k_base BPE, gpt-tokenizer/model/gpt-4o) — the same estimator the skills catalog budget uses',
  chars4Note:
    'MCP disclosure planning estimates tokens as JSON chars/4 (defaultEstimate in @mavis/agent-tools); both real BPE and chars/4 are reported for calibration',
  disclosureNote:
    'resolveLocalMcpDisclosureOptions(undefined, {}) = production defaults: enabled=true, empty model whitelist, thresholdPct=0.15, minDeferCount=1',
} as const;

export function formatSkillRows(rows: readonly SkillsCatalogRow[]): string {
  const header =
    'scenario'.padEnd(24) +
    'window'.padStart(8) +
    'budget'.padStart(8) +
    'skills'.padStart(8) +
    'render'.padStart(8) +
    'bpe-tok'.padStart(10) +
    'chars/4'.padStart(10) +
    'flags'.padStart(14);
  const lines = rows.map((row) =>
    row.scenario.padEnd(24) +
    String(row.contextWindowTokens).padStart(8) +
    String(row.budgetTokens).padStart(8) +
    `${row.entriesRendered}/${row.skillsRequested}`.padStart(8) +
    row.renderMs.toFixed(1).padStart(8) +
    String(row.catalogTokens).padStart(10) +
    String(row.chars4Tokens).padStart(10) +
    [
      row.softOverflow ? 'soft' : '',
      row.hardOverflow ? 'hard' : '',
      row.descriptionCapTruncated ? 'descCap' : '',
    ].filter(Boolean).join(',').padStart(14),
  );
  return [header, ...lines].join('\n');
}

export function formatMcpRows(rows: readonly McpDisclosureRow[]): string {
  const header =
    'scenario'.padEnd(18) +
    'variant'.padEnd(22) +
    'deferred'.padStart(9) +
    'inline'.padStart(7) +
    'bpe-tok'.padStart(10) +
    'disco-tok'.padStart(10) +
    'full-tok'.padStart(10) +
    'plan-ms'.padStart(9) +
    'search-ms'.padStart(10);
  const lines = rows.map((row) =>
    row.scenario.padEnd(18) +
    row.variant.padEnd(22) +
    String(row.deferred).padStart(9) +
    String(row.inlineToolCount).padStart(7) +
    String(row.inlineTokens).padStart(10) +
    String(row.discoveryToolTokens).padStart(10) +
    String(row.fullCatalogTokens).padStart(10) +
    row.planMs.toFixed(1).padStart(9) +
    (row.searchMs === undefined ? '-' : row.searchMs.toFixed(1)).padStart(10),
  );
  return [header, ...lines].join('\n');
}
