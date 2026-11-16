import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export function tempDb(label = 'feedhub') {
  const dir = mkdtempSync(join(tmpdir(), `${label}-`));
  return {
    dir,
    path: join(dir, 'feedhub.db'),
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function rss(items, channelExtra = '') {
  const body = items
    .map((item) => {
      const guid = item.guid === undefined ? '' : `<guid>${item.guid}</guid>`;
      const published = item.published ? `<pubDate>${item.published}</pubDate>` : '';
      return `<item>${guid}<title>${item.title ?? ''}</title><link>${item.link ?? ''}</link>${published}<description>${item.summary ?? ''}</description></item>`;
    })
    .join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>${channelExtra}${body}</channel></rss>`;
}

export function emptyRss() {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title></channel></rss>`;
}

/**
 * Run a snippet in a separate Node process. Used for tests that need real
 * process-level concurrency (separate SQLite connections), which cannot be
 * simulated reliably in one event loop, and for crash injection.
 */
export function runChild(source, { env = {}, timeout = 30_000 } = {}) {
  const result = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', source], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout,
    env: { ...process.env, ...env },
  });
  if (result.error) throw result.error;
  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

export function runChildConcurrently(sources, options = {}) {
  return Promise.all(
    sources.map(
      (source) =>
        new Promise((resolveP, rejectP) => {
          const child = spawn(process.execPath, ['--no-warnings', '--input-type=module', '-e', source], {
            cwd: ROOT,
            env: { ...process.env, ...(options.env ?? {}) },
          });
          let stdout = '';
          let stderr = '';
          const timer = setTimeout(() => {
            child.kill('SIGKILL');
            rejectP(new Error(`child timed out: ${stderr}`));
          }, options.timeout ?? 30_000);
          child.stdout.on('data', (chunk) => (stdout += chunk));
          child.stderr.on('data', (chunk) => (stderr += chunk));
          child.on('error', (error) => {
            clearTimeout(timer);
            rejectP(error);
          });
          child.on('close', (status) => {
            clearTimeout(timer);
            resolveP({ status, stdout, stderr });
          });
        }),
    ),
  );
}

export function childScript(body) {
  return `
import { ingestFeed } from './src/ingest.mjs';
import { openDb } from './src/db.mjs';
import { deliveryStateCounts, claimDeliveries, confirmDelivery, recoverExpiredLeases } from './src/delivery.mjs';
import { rss, emptyRss } from './test/helpers.mjs';
${body}
`;
}
