import {
  createMcpInvokeTool,
  createToolSearchTool,
  modelInWhitelist,
  planMcpDisclosure,
  renderMcpToolSearchHintBlock,
  type McpDisclosureOptions,
  type McpModelIdentity,
  type McpToolEntry,
} from '@mavis/agent-tools';
// The benchmark must not change production code, so the two planner internals it
// reports on are imported from their modules instead of the package barrel.
import { MAX_INLINE_CONFIGURED_TOOLS } from '../../../agent-tools/src/mcp-disclosure/plan.js';
import { buildIndex } from '../../../agent-tools/src/mcp-disclosure/search-index.js';
import { createDefaultTokenEstimator, type TokenEstimator } from '@mavis/context-manager';
import {
  renderLocalSkillsCatalogResult,
  resolveLocalSkillCatalogBudgetTokens,
  type LocalSkillsCatalogEntry,
} from '../../../local-runtime/src/skills/catalog.js';
import { resolveLocalMcpDisclosureOptions } from '../../src/service/turn-system/agent-host/assembly/local-turn-tool-catalog.js';

// Measurement source of truth is the production token estimator used by the
// skills catalog budget itself (o200k_base BPE via gpt-tokenizer).
const estimator: TokenEstimator = createDefaultTokenEstimator();
const countTokens = (text: string): number => estimator.estimateTextTokens(text);
const chars4 = (text: string): number => Math.ceil(text.length / 4);

function toolJson(tools: readonly { def: { name: string; description: string; schema: unknown } }[]): string {
  if (tools.length === 0) return '';
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

/** Skill names the renderer actually put into the catalog. */
export function visibleSkillNames(catalog: string): string[] {
  const names: string[] = [];
  for (const line of catalog.split('\n')) {
    if (!line.startsWith('- ')) continue;
    const rest = line.slice(2);
    const separator = rest.indexOf(': ');
    names.push(separator === -1 ? rest : rest.slice(0, separator));
  }
  return names;
}

export interface SkillsCatalogRow {
  scenario: string;
  profile: string;
  contextWindowTokens: number;
  budgetTokens: number;
  skillsRequested: number;
  entriesRendered: number;
  visibleSkillNames: string[];
  catalogTokens: number;
  catalogChars4: number;
  softOverflow: boolean;
  hardOverflow: boolean;
  descriptionCapTruncated: boolean;
  renderMs: number;
}

export function measureSkillsCatalog(
  scenario: string,
  skills: readonly LocalSkillsCatalogEntry[],
  contextWindowTokens: number,
  renderRuns = 5,
  profile = 'n/a',
): { row: SkillsCatalogRow; catalog: string } {
  const render = (): string => renderLocalSkillsCatalogResult(skills, { contextWindowTokens }).catalog;
  const catalog = renderLocalSkillsCatalogResult(skills, { contextWindowTokens });
  const names = visibleSkillNames(catalog.catalog);
  const row: SkillsCatalogRow = {
    scenario,
    profile,
    contextWindowTokens,
    budgetTokens: resolveLocalSkillCatalogBudgetTokens(contextWindowTokens),
    skillsRequested: skills.length,
    entriesRendered: names.length,
    visibleSkillNames: names,
    catalogTokens: countTokens(catalog.catalog),
    catalogChars4: chars4(catalog.catalog),
    softOverflow: catalog.softOverflow,
    hardOverflow: catalog.hardOverflow,
    descriptionCapTruncated: catalog.descriptionCapTruncated,
    renderMs: medianOf(renderRuns, render),
  };
  return { row, catalog: catalog.catalog };
}

/**
 * Why the planner deferred (or why it did not). The guard order mirrors
 * `planMcpDisclosure` in `packages/agent-tools/src/mcp-disclosure/plan.ts`.
 */
export type DeferralStatus =
  | 'deferred-by-tool-count'
  | 'deferred-by-token-threshold'
  | 'deferred-by-tool-count-and-token-threshold'
  | 'not-deferred-disabled'
  | 'not-deferred-model-whitelist'
  | 'not-deferred-invalid-context-window'
  | 'not-deferred-below-min-defer-count'
  | 'not-deferred-within-budget';

export interface McpDisclosureRow {
  scenario: string;
  variant: string;
  contextWindowTokens: number;
  servers: number;
  toolsPerServer: number;
  configuredToolCount: number;
  inlineToolCap: number;
  deferred: boolean;
  status: DeferralStatus;
  inlineToolCount: number;
  inlineTokens: number;
  inlineChars4: number;
  discoveryToolTokens: number;
  systemHintTokens: number;
  totalContextTokens: number;
  searchResultTokens: number;
  fullCatalogTokens: number;
  fullCatalogChars4: number;
  plannerEstTokensChars4?: number;
  plannerThresholdChars4?: number;
  planMs: number;
  indexBuildMs: number;
  searchMs?: number;
}

export function measureMcpDisclosure(
  scenario: string,
  entries: readonly McpToolEntry[],
  variants: readonly { name: string; options: McpDisclosureOptions }[],
  contextWindowTokens = 131_072,
  shape: { servers: number; toolsPerServer: number } = { servers: 0, toolsPerServer: 0 },
): McpDisclosureRow[] {
  const fullJson = toolJson(entries.map((entry) => entry.tool));
  const fullCatalogTokens = countTokens(fullJson);
  const model: McpModelIdentity = { provider: 'bench', id: 'bench-model', contextWindow: contextWindowTokens };
  const configuredToolCount = entries.filter((entry) => entry.source === 'configured').length;
  const candidates = entries.filter((entry) => entry.source === 'configured');
  // `planMcpDisclosure` reuses a module-level BM25 index per candidate set, so the
  // first deferred plan of a fixture set pays the build and later plans hit the
  // cache. `buildIndex` is the uncached constructor: timing it separately yields
  // the cold build cost without disturbing the planner's own cache.
  const indexBuildMs = medianOf(3, () =>
    buildIndex(candidates, { maxSchemaTextLen: variants[0]?.options.maxSchemaTextLen ?? 4_096 }),
  );

  return variants.map((variant) => {
    const start = performance.now();
    const plan = planMcpDisclosure({ entries, model, options: variant.options });
    const planMs = Math.round((performance.now() - start) * 1000) / 1000;

    let inlineJson = toolJson(plan.inlineTools);
    let inlineTokens = countTokens(inlineJson);
    let inlineChars4 = chars4(inlineJson);
    let discoveryToolTokens = 0;
    let systemHintTokens = 0;
    let searchResultTokens = 0;
    let searchMs: number | undefined;

    if (plan.deferred) {
      const searchTool = createToolSearchTool(plan.index, {
        topKDefault: variant.options.topKDefault,
        topKMax: variant.options.topKMax,
      });
      const invokeTool = createMcpInvokeTool(plan.deferredRegistry);
      const discoveryJson = toolJson([searchTool, invokeTool]);
      discoveryToolTokens = countTokens(discoveryJson);
      inlineTokens += discoveryToolTokens;
      inlineChars4 += chars4(discoveryJson);
      if (variant.options.systemHint) {
        systemHintTokens = countTokens(renderMcpToolSearchHintBlock({}));
      }
      const query = 'create a github issue then export a report of the results';
      const hits = plan.index.search({ query, topK: variant.options.topKDefault });
      searchResultTokens = countTokens(JSON.stringify(hits));
      searchMs = medianOf(5, () =>
        plan.index.search({ query, topK: variant.options.topKDefault }),
      );
    }

    return {
      scenario,
      variant: variant.name,
      contextWindowTokens,
      servers: shape.servers,
      toolsPerServer: shape.toolsPerServer,
      configuredToolCount,
      inlineToolCap: MAX_INLINE_CONFIGURED_TOOLS,
      deferred: plan.deferred,
      status: deferralStatus({
        plan,
        options: variant.options,
        model,
        configuredToolCount,
      }),
      inlineToolCount: plan.inlineTools.length,
      inlineTokens,
      inlineChars4,
      discoveryToolTokens,
      systemHintTokens,
      totalContextTokens: inlineTokens + systemHintTokens,
      searchResultTokens,
      fullCatalogTokens,
      fullCatalogChars4: chars4(fullJson),
      plannerEstTokensChars4: plan.deferred ? plan.stats.estTokens : undefined,
      plannerThresholdChars4: plan.deferred ? plan.stats.thresholdTokens : undefined,
      planMs,
      indexBuildMs,
      searchMs,
    };
  });
}

function deferralStatus(input: {
  plan: ReturnType<typeof planMcpDisclosure>;
  options: McpDisclosureOptions;
  model: McpModelIdentity;
  configuredToolCount: number;
}): DeferralStatus {
  const { plan, options, model, configuredToolCount } = input;
  if (!options.enabled) return 'not-deferred-disabled';
  if (!modelInWhitelist(model.provider, model.id, options.modelWhitelist))
    return 'not-deferred-model-whitelist';
  if (!(Number.isFinite(model.contextWindow) && model.contextWindow > 0))
    return 'not-deferred-invalid-context-window';
  if (configuredToolCount < options.minDeferCount) return 'not-deferred-below-min-defer-count';
  if (!plan.deferred) return 'not-deferred-within-budget';
  const overToolCount = configuredToolCount > MAX_INLINE_CONFIGURED_TOOLS;
  const overTokenBudget = plan.stats.estTokens > plan.stats.thresholdTokens;
  if (overToolCount && overTokenBudget) return 'deferred-by-tool-count-and-token-threshold';
  if (overToolCount) return 'deferred-by-tool-count';
  return 'deferred-by-token-threshold';
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
    inlineToolCap: number;
    node: string;
    platform: string;
  };
  skills: SkillsCatalogRow[];
  mcp: McpDisclosureRow[];
}

export const BENCH_META = {
  estimator:
    'createDefaultTokenEstimator() from @mavis/context-manager (o200k_base BPE, gpt-tokenizer/model/gpt-4o) — the same estimator the skills catalog budget uses',
  chars4Note:
    'MCP disclosure planning estimates tokens as JSON chars/4 (defaultEstimate in @mavis/agent-tools); both real BPE and chars/4 are reported for calibration',
  disclosureNote:
    'resolveLocalMcpDisclosureOptions(undefined, {}) = production defaults: enabled=true, empty model whitelist, thresholdPct=0.15, minDeferCount=1',
  inlineToolCap: MAX_INLINE_CONFIGURED_TOOLS,
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
} as const;

export function formatSkillRows(rows: readonly SkillsCatalogRow[]): string {
  const header =
    'scenario'.padEnd(24) +
    'window'.padStart(9) +
    'budget'.padStart(8) +
    'skills'.padStart(9) +
    'render'.padStart(9) +
    'bpe-tok'.padStart(9) +
    'chars/4'.padStart(9) +
    'flags'.padStart(14);
  const lines = rows.map((row) =>
    row.scenario.padEnd(24) +
    String(row.contextWindowTokens).padStart(9) +
    String(row.budgetTokens).padStart(8) +
    `${row.entriesRendered}/${row.skillsRequested}`.padStart(9) +
    row.renderMs.toFixed(1).padStart(9) +
    String(row.catalogTokens).padStart(9) +
    String(row.catalogChars4).padStart(9) +
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
    'scenario'.padEnd(22) +
    'variant'.padEnd(22) +
    'window'.padStart(9) +
    'deferred'.padStart(9) +
    'inline'.padStart(7) +
    'bpe-tok'.padStart(9) +
    'disco'.padStart(7) +
    'hint'.padStart(6) +
    'full-tok'.padStart(9) +
    'plan-ms'.padStart(8) +
    'index-ms'.padStart(9) +
    'search-ms'.padStart(10);
  const lines = rows.map((row) =>
    row.scenario.padEnd(22) +
    row.variant.padEnd(22) +
    String(row.contextWindowTokens).padStart(9) +
    String(row.deferred).padStart(9) +
    String(row.inlineToolCount).padStart(7) +
    String(row.inlineTokens).padStart(9) +
    String(row.discoveryToolTokens).padStart(7) +
    String(row.systemHintTokens).padStart(6) +
    String(row.fullCatalogTokens).padStart(9) +
    row.planMs.toFixed(1).padStart(8) +
    row.indexBuildMs.toFixed(1).padStart(9) +
    (row.searchMs === undefined ? '-' : row.searchMs.toFixed(1)).padStart(10),
  );
  return [header, ...lines].join('\n');
}
