import { Type, type TSchema } from '@sinclair/typebox';
import type { RuntimeTool, ToolDefinition } from '@mavis/agent-core/tools';
import type { McpToolEntry } from '@mavis/agent-tools';
import type { LocalSkillsCatalogEntry } from '@mavis/local-runtime';

export type SkillFixtureProfile = 'short' | 'realistic' | 'cap';
export type SchemaFixtureProfile = 'compact' | 'realistic' | 'large';

// mulberry32: tiny deterministic PRNG so every run produces byte-identical
// fixtures on every platform, keeping BPE token counts comparable across runs.
function createRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SKILL_TOPICS = [
  'deploys', 'ci-cd', 'databases', 'git history', 'test suites', 'secrets rotation', 'docs sites',
  'billing anomalies', 'kubernetes clusters', 'observability dashboards', 'email deliverability',
  'pdf pipelines', 'spreadsheets', 'browser automation', 'web scraping', 'ml pipelines',
  'search indexes', 'cache layers', 'auth flows', 'translations', 'accessibility audits',
  'payment webhooks', 'structured logs', 'config drift', 'schema migrations', 'api contracts',
  'release notes', 'incident postmortems', 'dependency upgrades', 'permission reviews',
];
const SKILL_ACTIONS = [
  'manage', 'audit', 'migrate', 'refactor', 'troubleshoot', 'harden', 'document', 'automate',
  'validate', 'optimize',
];
const SKILL_DETAILS = [
  'staging and production rollouts', 'schema changes and rollbacks', 'flaky test triage',
  'credential rotation checklists', 'API contract drift', 'cost anomalies across providers',
  'release-note drafting from merged commits', 'incident postmortem timelines',
  'dependency upgrade fallout', 'permission drift between environments',
];
const SKILL_QUALIFIERS = [
  'with health checks at every step', 'without downtime', 'across monorepo workspaces',
  'under aggressive rate limits', 'with full audit trails', 'from partially failed states',
  'before release cuts are tagged', 'during active incidents',
];

function pick<T>(rng: () => number, list: readonly T[]): T {
  return list[Math.floor(rng() * list.length)] as T;
}

function skillDescription(rng: () => number, profile: SkillFixtureProfile): string {
  const action = pick(rng, SKILL_ACTIONS);
  const topic = pick(rng, SKILL_TOPICS);
  const detail = pick(rng, SKILL_DETAILS);
  const qualifier = pick(rng, SKILL_QUALIFIERS);
  if (profile === 'short') {
    return `${action.charAt(0).toUpperCase()}${action.slice(1)} ${topic} ${qualifier}.`;
  }
  const core =
    `Use when the user asks to ${action} ${topic} or runs into ${detail}. ` +
    `Covers ${qualifier} and reports structured findings back to the main model.`;
  if (profile === 'realistic') {
    return rng() > 0.5 ? `${core} ${detail.charAt(0).toUpperCase()}${detail.slice(1)} are treated as first-class inputs.` : core;
  }
  // 'cap': long-form instructions near the 1,024 code-point description cap so
  // some fixtures cross it and exercise the renderer's truncation path.
  let text = core;
  while (text.length < 900) {
    text +=
      ` Walk through ${detail} step by step ${qualifier}, recording every decision, ` +
      `including the rollback note for ${pick(rng, SKILL_DETAILS)}.`;
  }
  return text.slice(0, 900 + Math.floor(rng() * 180));
}

export function buildSkillCatalogFixtures(options: {
  count: number;
  profile: SkillFixtureProfile;
  seed?: number;
}): LocalSkillsCatalogEntry[] {
  const rng = createRng((options.seed ?? 20260929) + options.count);
  const skills: LocalSkillsCatalogEntry[] = [];
  for (let i = 0; i < options.count; i += 1) {
    const topic = pick(rng, SKILL_TOPICS).replace(/[^a-z0-9]+/gu, '-');
    const action = pick(rng, SKILL_ACTIONS);
    skills.push({
      name: `${topic}-${action}-${i}`,
      description: skillDescription(rng, options.profile),
      builtin: i % 5 === 0,
    });
  }
  return skills;
}

const MCP_SERVER_NAMES = [
  'github', 'filesystem', 'postgres', 'slack', 'browser', 'kubernetes', 'stripe', 'jira',
  'sentry', 'figma',
];
const MCP_TOOL_NAMES = [
  'create_item', 'list_items', 'get_details', 'update_fields', 'delete_resource',
  'search_records', 'run_query', 'upload_attachment', 'subscribe_events', 'export_report',
];

function stringProp(description: string) {
  return Type.String({ description });
}
function numberProp(description: string) {
  return Type.Number({ description });
}
function enumProp(description: string, values: string[]) {
  return Type.Union(
    values.map((value) => Type.Literal(value)),
    { description },
  );
}

function buildSchema(
  profile: SchemaFixtureProfile,
  serverName: string,
  toolName: string,
): TSchema {
  const props = {
    name: stringProp(`Human-readable identifier of the ${toolName} target on ${serverName}.`),
    limit: numberProp('Maximum number of records to return in one page.'),
    dry_run: Type.Boolean({ description: 'Validate the request without persisting any change.' }),
  };
  if (profile === 'compact') {
    return Type.Object(props, {
      description: `Arguments for ${serverName}.${toolName}.`,
    });
  }
  const extended = {
    ...props,
    kind: enumProp('Record kind to operate on.', ['issue', 'pull_request', 'discussion', 'note']),
    filter: Type.Object(
      { field: stringProp('Field to filter on.'), op: enumProp('Comparison.', ['eq', 'ne', 'gt', 'lt']) },
      { description: 'Optional structured filter applied server-side.' },
    ),
    tags: Type.Array(Type.String({ description: 'Tag to match.' }), {
      description: 'All tags must match.',
    }),
    since: stringProp('ISO-8601 lower bound for the operation window.'),
  };
  if (profile === 'realistic') {
    return Type.Object(extended, { description: `Arguments for ${serverName}.${toolName}.` });
  }
  return Type.Object(
    {
      ...extended,
      pagination: Type.Object(
        { cursor: stringProp('Opaque continuation cursor.'), page_size: numberProp('Items per page.') },
        { description: 'Cursor pagination state.' },
      ),
      metadata: Type.Record(Type.String(), Type.String(), {
        description: 'Free-form labels persisted alongside the record.',
      }),
      items: Type.Array(
        Type.Object(
          { title: stringProp('Item title.'), body: stringProp('Item body in markdown.') },
          { description: 'Batch entry.' },
        ),
        { description: 'Batch entries processed atomically.' },
      ),
      verbosity: enumProp('Response verbosity.', ['quiet', 'normal', 'verbose']),
      callback_uri: stringProp('HTTPS endpoint notified after completion.'),
      ttl_seconds: numberProp('How long the result stays queryable.'),
    },
    { description: `Arguments for ${serverName}.${toolName}.` },
  );
}

export function buildMcpToolFixtures(options: {
  servers: number;
  toolsPerServer: number;
  profile?: SchemaFixtureProfile;
  seed?: number;
}): McpToolEntry[] {
  const rng = createRng((options.seed ?? 20260929) + options.servers * 1000);
  const profile = options.profile ?? 'realistic';
  const entries: McpToolEntry[] = [];
  for (let s = 0; s < options.servers; s += 1) {
    const serverName = `${MCP_SERVER_NAMES[s % MCP_SERVER_NAMES.length]}${s >= MCP_SERVER_NAMES.length ? `-${Math.floor(s / MCP_SERVER_NAMES.length)}` : ''}`;
    for (let t = 0; t < options.toolsPerServer; t += 1) {
      const toolName = `${serverName}_${MCP_TOOL_NAMES[t % MCP_TOOL_NAMES.length]}${t >= MCP_TOOL_NAMES.length ? `_${Math.floor(t / MCP_TOOL_NAMES.length)}` : ''}`;
      const def: ToolDefinition = {
        name: toolName,
        description:
          `${toolName.replace(/_/g, ' ')} on the ${serverName} integration. ` +
          `${pick(rng, SKILL_DETAILS).charAt(0).toUpperCase()}${pick(rng, SKILL_DETAILS).slice(1)} are handled server-side; results are returned structured for agent consumption.`,
        schema: buildSchema(profile, serverName, toolName),
      };
      const tool: RuntimeTool = {
        def,
        impl: async () => ({ tool_name: toolName, text: 'ok', content: [] }),
        source: 'configured',
      };
      entries.push({ tool, source: 'configured', serverName });
    }
  }
  return entries;
}
