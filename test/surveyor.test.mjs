import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  calculateGrowth,
  decideDownload,
  rankCandidates,
  safeArchiveName,
  weeklyBaseline,
  runSurvey,
} from '../weekly-surveyor.mjs';

test('calculateGrowth reports weekly delta and daily rate from two valid snapshots', () => {
  const result = calculateGrowth(
    { stargazers_count: 1_140 },
    { stargazers_count: 1_000, fetched_at: '2026-11-12T09:00:00.000Z' },
    '2026-11-19T09:00:00.000Z',
  );

  assert.deepEqual(result, { delta: 140, days: 7, perDay: 20 });
});

test('calculateGrowth marks a first observation as baseline', () => {
  assert.deepEqual(calculateGrowth({ stargazers_count: 100 }, null, '2026-11-19T09:00:00.000Z'), {
    delta: null,
    days: null,
    perDay: null,
  });
});

test('calculateGrowth uses the snapshot timestamp stored on each entry', () => {
  const result = calculateGrowth(
    { stargazers_count: 1_010 },
    { stargazers_count: 1_000, fetched_at: '2026-11-18T09:00:00.000Z' },
    '2026-11-19T09:00:00.000Z',
  );
  assert.equal(result.delta, 10);
  assert.equal(result.perDay, 10);
});

test('weekly baseline chooses the closest live sample to seven days and excludes same-day reruns', () => {
  const asOf = '2026-11-19T09:00:00.000Z';
  const entry = (stargazers_count, extra = {}) => ({ full_name: 'Example/Tool', stargazers_count, ...extra });
  const snapshot = (fetched_at, entries) => ({ fetched_at, entries });
  const compared = weeklyBaseline([
    snapshot('2026-11-11T09:00:00.000Z', [entry(480)]),
    snapshot('2026-11-12T08:00:00.000Z', [entry(500)]),
    snapshot('2026-11-12T09:00:00.000Z', [entry(50, { stale: true })]),
    snapshot('2026-11-19T08:55:00.000Z', [entry(580)]),
  ], asOf);
  assert.equal(calculateGrowth(entry(584), compared.get('example/tool'), asOf).delta, 84);
});

test('decideDownload rejects missing licenses and oversized archives', () => {
  const base = { stars: 10_000, forks: 500, pushed_at: '2026-11-18T00:00:00.000Z', license: 'MIT' };
  const now = Date.parse('2026-11-19T09:00:00.000Z');
  assert.equal(decideDownload(base, { now, archiveBytes: 50 * 1024 * 1024 }).download, true);
  assert.equal(decideDownload({ ...base, stars: undefined, forks: undefined, stargazers_count: 10_000, forks_count: 500 }, { now }).download, true);
  assert.equal(decideDownload({ ...base, license: null }, { now }).download, false);
  assert.equal(decideDownload({ ...base, feedback: 'ignore' }, { now }).download, false);
  assert.equal(decideDownload(base, { now, archiveBytes: 300 * 1024 * 1024 }).download, false);
  assert.equal(decideDownload(base, { now, requireTrend: true }).download, false);
  assert.equal(decideDownload({ ...base, growth: { delta: 42, perDay: 6 } }, { now, requireTrend: true }).download, true);
  assert.equal(decideDownload({ ...base, feedback: 'useful' }, { now, requireTrend: true }).download, true);
});

test('rankCandidates combines growth and feedback without trusting raw descriptions as code', () => {
  const ranked = rankCandidates([
    { full_name: 'slow/project', stargazers_count: 20_000, growth: { perDay: 2 }, feedback: null },
    { full_name: 'useful/project', stargazers_count: 2_000, growth: { perDay: 40 }, feedback: 'useful' },
  ]);

  assert.equal(ranked[0].full_name, 'useful/project');
  assert.equal(ranked[0].rank_score > ranked[1].rank_score, true);
});

test('safeArchiveName cannot produce a path traversal segment', () => {
  assert.equal(safeArchiveName('owner/repo', 'abc123'), 'owner--repo-abc123.tar.gz');
  assert.equal(safeArchiveName('../../evil', 'sha/with/slash'), 'evil-shawithslash.tar.gz');
});

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'surveyor-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('complete GitHub outage reports cached data without replacing the live baseline or downloading', async (t) => {
  const root = await temporaryRoot(t);
  await fs.mkdir(path.join(root, 'state'));
  const latest = path.join(root, 'state', 'latest.json');
  const original = JSON.stringify({ fetched_at: '2026-11-12T08:00:00.000Z', entries: [{
    full_name: 'Example/OldTool', stargazers_count: 25, categories: ['视觉与画质'],
  }] });
  await fs.writeFile(latest, original);
  const requests = t.mock.method(globalThis, 'fetch', async () => new Response(null, {
    status: 403, headers: { 'x-ratelimit-remaining': '0' },
  }));
  const result = await runSurvey({ root, now: new Date('2026-11-19T09:00:00.000Z') });
  assert.equal(await fs.readFile(latest, 'utf8'), original);
  assert.equal(result.snapshotFile, null);
  assert.equal(result.downloads.length, 0);
  assert.equal(requests.mock.callCount(), 2);
  assert.match(await fs.readFile(result.reportFile, 'utf8'), /历史缓存/);
});

test('first run during an outage does not invent data or write a snapshot', async (t) => {
  const root = await temporaryRoot(t);
  t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 429 }));
  const result = await runSurvey({ root });
  assert.equal(result.snapshotFile, null);
  assert.deepEqual(result.candidates, []);
  await assert.rejects(fs.access(path.join(root, 'state', 'latest.json')), { code: 'ENOENT' });
  assert.match(await fs.readFile(result.reportFile, 'utf8'), /暂无实时数据/);
});

test('default survey never downloads even when an active repository is marked useful', async (t) => {
  const root = await temporaryRoot(t);
  await fs.mkdir(path.join(root, 'state'));
  await fs.writeFile(path.join(root, 'state', 'feedback.json'), JSON.stringify({ 'example/tool': { status: 'useful' } }));
  const repo = { full_name: 'Example/Tool', private: false, stargazers_count: 2000, forks_count: 200,
    pushed_at: '2026-11-18T10:00:00Z', license: { spdx_id: 'MIT' } };
  const sha = 'a'.repeat(40);
  const requests = t.mock.method(globalThis, 'fetch', async (url) => {
    if (url.includes('/search/repositories')) return Response.json({ items: [repo] });
    if (url.includes('/commits/')) return Response.json({ sha });
    if (url.startsWith('https://codeload.github.com/')) {
      const response = new Response(Uint8Array.of(0x1f, 0x8b, 0x08, 0x00), { status: 200 });
      Object.defineProperty(response, 'url', { value: url });
      return response;
    }
    return new Response(null, { status: 404 });
  });
  const now = new Date('2026-11-19T09:00:00Z');
  const dry = await runSurvey({ root, now });
  assert.deepEqual(dry.downloads, []);
  assert.ok(!requests.mock.calls.some(({ arguments: [url] }) => url.includes('/commits/')));
  const optIn = await runSurvey({ root, now: new Date(now.getTime() + 60_000), download: true });
  assert.equal(optIn.downloads.length, 1);
  assert.equal(optIn.downloads[0].commit, sha);
  assert.match(optIn.downloads[0].sha256, /^[a-f0-9]{64}$/);
});
