import { rmSync } from 'node:fs';
import { fixture } from './mockfeed.mjs';
import { ingestFeed } from './poll.mjs';
import { counts } from './store.mjs';
import { signature, verifySignature } from './websub.mjs';
import { checkHealth, diagnoseAll, describeHealth, healthEvents } from './health.mjs';

const DEFAULT_DB = '/tmp/feedhub/feedhub.db';

function parseArgs(argv) {
  const args = { _: [], json: false, events: 20 };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      args._.push(token);
      continue;
    }
    const name = token.slice(2);
    if (name === 'json') {
      args.json = true;
      continue;
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`missing value for --${name}`);
    }
    i += 1;
    if (name === 'events') {
      const count = Number(value);
      if (!Number.isInteger(count) || count < 0) throw new Error('--events must be a non-negative integer');
      args.events = count;
    } else if (name === 'db' || name === 'feed' || name === 'now' || name === 'observed-at') {
      args[name === 'observed-at' ? 'observedAt' : name] = value;
    } else {
      throw new Error(`unknown option --${name}`);
    }
  }
  return args;
}

function runHealth(args) {
  const dbPath = args.db || DEFAULT_DB;
  const now = args.now;
  const options = now === undefined ? {} : { now };
  const report = args.feed
    ? [{
        feedId: args.feed,
        health: checkHealth(dbPath, args.feed, options),
      }]
    : diagnoseAll(dbPath, options);

  const withEvents = report.map((entry) => ({
    ...entry,
    events: args.feed && args.events > 0 ? healthEvents(dbPath, entry.feedId, args.events) : undefined,
  }));

  if (args.json) {
    console.log(JSON.stringify({
      db: dbPath,
      checkedAt: withEvents[0]?.health.now ?? null,
      feeds: withEvents,
    }, null, 2));
    return;
  }

  if (withEvents.length === 0) {
    console.log('没有已记录的源');
    return;
  }
  for (const entry of withEvents) {
    console.log(`[${entry.feedId}] ${describeHealth(entry.health)}`);
    if (entry.events) {
      for (const event of entry.events) {
        console.log(`  ${event.evaluated_at} ${event.status} ${event.reason} (observed=${event.observed_at ?? '—'})`);
      }
    }
  }
  const unhealthy = withEvents.filter((entry) => !entry.health.healthy).length;
  if (unhealthy > 0) process.exitCode = 1;
}

function runIngest(args) {
  // 便于诊断/重放：用显式时间窗口采集本地 fixture，写库与健康判定同源。
  const dbPath = args.db || DEFAULT_DB;
  const id = args.feed || 'local';
  const now = args.now ?? Date.now();
  const result = ingestFeed({
    id,
    url: 'file://fixture',
    raw: fixture,
    dbPath,
    now,
    observedAt: args.observedAt,
  });
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`[${id}] ingest: parsed=${result.parsed} fresh=${result.fresh} ` +
      `observed=${result.observedAt} seq=${result.observeSeq}`);
    console.log(`  ${result.health.status} (${result.health.reason}) healthy=${result.health.healthy}`);
  }
  if (result.hasProblem) process.exitCode = 1;
}

function runDemo() {
  rmSync('/tmp/feedhub', { recursive: true, force: true });
  const first = ingestFeed({ id: 'local', url: 'file://fixture', raw: fixture, dbPath: DEFAULT_DB, subscribers: ['warehouse', 'search'] });
  const second = ingestFeed({ id: 'local', url: 'file://fixture', raw: fixture, dbPath: DEFAULT_DB, subscribers: ['warehouse', 'search'] });
  const body = '<hub.challenge>ok</hub.challenge>';
  const health = checkHealth(DEFAULT_DB, 'local');
  console.log(JSON.stringify({
    first,
    second,
    counts: counts(DEFAULT_DB),
    signatureValid: verifySignature(body, signature(body, 'secret'), 'secret'),
    health: {
      status: health.status,
      healthy: health.healthy,
      reason: health.reason,
      observedAt: health.observedAt,
      now: health.now,
      detail: describeHealth(health),
    },
  }, null, 2));
}

let args;
try {
  args = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(`error: ${error.message}`);
  process.exit(2);
}

const command = args._[0];
switch (command) {
  case 'demo':
    runDemo();
    break;
  case 'health':
    try {
      runHealth(args);
    } catch (error) {
      console.error(`error: ${error.message}`);
      process.exit(2);
    }
    break;
  case 'ingest':
    try {
      runIngest(args);
    } catch (error) {
      console.error(`error: ${error.message}`);
      process.exit(2);
    }
    break;
  default:
    console.error(
      'usage: node src/cli.mjs demo | health [--db PATH] [--feed ID] [--now ISO] [--events N] [--json]\n' +
      '                         | ingest [--db PATH] [--feed ID] [--now ISO] [--observed-at ISO] [--json]',
    );
    process.exit(2);
}
