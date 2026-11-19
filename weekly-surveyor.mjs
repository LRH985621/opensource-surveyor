#!/usr/bin/env node

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const API_BASE = 'https://api.github.com';
const USER_AGENT = 'weekly-open-source-surveyor/1.0';
const DAY_MS = 24 * 60 * 60 * 1000;
const REPORT_TIME_ZONE = process.env.SURVEY_TIME_ZONE || Intl.DateTimeFormat().resolvedOptions().timeZone;
const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const MAX_TOTAL_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;
const REPO_NAME = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9_][A-Za-z0-9_.-]{0,99}$/;
const OPEN_LICENSES = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'MPL-2.0', 'GPL-2.0', 'GPL-3.0', 'LGPL-2.1', 'LGPL-3.0', 'AGPL-3.0', 'ISC', 'Unlicense', '0BSD']);
const TRIAL_NOTES = new Map([
  ['pbakaus/impeccable', '视觉：适合前端界面审查，可先选一页做修改前后对比。'],
  ['comfy-org/comfyui', '视觉：用同一输入对比不同工作流的成图质量、耗时和显存。'],
  ['ggml-org/llama.cpp', '成本：适合用小型量化模型对比本地推理和付费 API；先测质量、延迟与内存，再考虑部署。'],
  ['berriai/litellm', '成本：多模型 API 的费用追踪候选；GitHub 没有明确识别仓库许可证，需逐项核对。'],
  ['astral-sh/uv', '效率：先在一个非生产 Python 项目比较依赖解析和环境创建耗时。'],
  ['mem0ai/mem0', '记忆：先用非敏感样本测试跨会话召回，核对模型调用和存储成本。'],
  ['letta-ai/letta', '记忆：适合测试能否跨会话保留任务状态，需单独评估维护成本。'],
  ['thedotmack/claude-mem', '记忆：会采集会话内容；接入真实工作记录前先审查采集范围和留存设置。'],
]);
const DEFAULT_ROOT = path.resolve(process.env.SURVEY_DATA_DIR || path.join(os.homedir(), '.opensource-surveyor'));

export const SEARCH_GROUPS = [
  {
    name: '视觉与画质',
    queries: ['topic:image-generation stars:>200', 'topic:computer-vision stars:>500'],
  },
  {
    name: '成本控制与推理',
    queries: ['topic:llm quantization in:description,readme stars:>200', '"llm gateway" in:description stars:>100'],
  },
  {
    name: '运行效率',
    queries: ['topic:package-manager stars:>200', 'topic:inference-engine stars:>200'],
  },
  {
    name: '记忆与自我学习',
    queries: ['topic:agentic-memory stars:>50', '"agent memory" in:description stars:>50'],
  },
];

export const SEED_REPOS = [
  ['Comfy-Org/ComfyUI', '视觉与画质'],
  ['xinntao/Real-ESRGAN', '视觉与画质'],
  ['astral-sh/uv', '运行效率'],
  ['BerriAI/litellm', '成本控制与推理'],
  ['ggml-org/llama.cpp', '成本控制与推理'],
  ['mem0ai/mem0', '记忆与自我学习'],
  ['letta-ai/letta', '记忆与自我学习'],
  ['thedotmack/claude-mem', '记忆与自我学习'],
  ['pbakaus/impeccable', '视觉与画质'],
];

function round(value, digits = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export function calculateGrowth(current, previous, fetchedAt) {
  if (!previous || current.stale || previous.stale || !Number.isFinite(current.stargazers_count) || !Number.isFinite(previous.stargazers_count)) {
    return { delta: null, days: null, perDay: null };
  }
  const currentTime = Date.parse(fetchedAt);
  const previousTime = Date.parse(previous.fetched_at);
  if (!Number.isFinite(currentTime) || !Number.isFinite(previousTime) || currentTime <= previousTime) {
    return { delta: null, days: null, perDay: null };
  }
  const days = (currentTime - previousTime) / DAY_MS;
  const delta = Number(current.stargazers_count) - Number(previous.stargazers_count);
  return { delta, days: round(days, 2), perDay: round(delta / days, 2) };
}

export function weeklyBaseline(snapshots, fetchedAt) {
  const target = Date.parse(fetchedAt);
  const comparisons = new Map();
  for (const snapshot of snapshots) {
    for (const entry of snapshot.entries || []) {
      if (entry.stale || !Number.isFinite(entry.stargazers_count)) continue;
      const fetched_at = entry.fetched_at || snapshot.fetched_at;
      const days = (target - Date.parse(fetched_at)) / DAY_MS;
      if (!(days >= 5 && days <= 9)) continue;
      const key = entry.full_name.toLowerCase();
      if (Math.abs(days - 7) < (comparisons.get(key)?.distance ?? Infinity)) {
        comparisons.set(key, { ...entry, fetched_at, distance: Math.abs(days - 7) });
      }
    }
  }
  return comparisons;
}

export function safeArchiveName(fullName, sha) {
  const parts = String(fullName)
    .split(/[\\/]/)
    .filter((part) => part && part !== '.' && part !== '..')
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, ''))
    .filter(Boolean);
  const repoPart = parts.join('--') || 'repo';
  const shaPart = String(sha).replace(/[^a-zA-Z0-9]/g, '') || 'unknown';
  return `${repoPart}-${shaPart}.tar.gz`;
}

export function decideDownload(repo, { archiveBytes = null, maxArchiveBytes = MAX_ARCHIVE_BYTES, now = Date.now(), requireTrend = false } = {}) {
  const hasLicense = OPEN_LICENSES.has(repo.license);
  const activeRecently = repo.pushed_at && (now - Date.parse(repo.pushed_at)) <= 365 * DAY_MS;
  const stars = Number(repo.stars ?? repo.stargazers_count);
  const forks = Number(repo.forks ?? repo.forks_count);
  const hasSignal = stars >= 1_000 || forks >= 100 || Number(repo.growth?.perDay) >= 5;
  const sizeOk = archiveBytes == null || (Number.isFinite(archiveBytes) && archiveBytes <= maxArchiveBytes);
  const reasons = [];
  if (repo.stale) reasons.push('使用缓存/首轮基线，等待实时 API 数据');
  if (!hasLicense) reasons.push('许可证未列入源码自动归档名单');
  if (repo.archived || repo.fork) reasons.push('归档仓库或 fork');
  if (repo.feedback === 'ignore' || repo.feedback === 'installed') reasons.push('反馈标记为忽略或已安装');
  if (requireTrend && repo.feedback !== 'useful' && !(repo.growth?.delta > 0 && repo.growth?.perDay >= 5)) {
    reasons.push('尚无日均至少净增 5 星的周样本，也未标记为有用');
  }
  if (!activeRecently) reasons.push('最近一年没有明显维护活动');
  if (!hasSignal) reasons.push('星标、fork 或周增速信号不足');
  if (!sizeOk) reasons.push(`源码归档超过 ${Math.round(maxArchiveBytes / 1024 / 1024)} MB 上限`);
  return {
    download: !reasons.length,
    reasons,
    automaticInstall: false,
  };
}

export function rankCandidates(candidates) {
  return [...candidates]
    .map((candidate) => {
      const growth = Number(candidate.growth?.perDay) || 0;
      const stars = Math.log10(Math.max(Number(candidate.stargazers_count) || Number(candidate.stars) || 0, 0) + 1);
      const forks = Math.log10(Math.max(Number(candidate.forks_count) || Number(candidate.forks) || 0, 0) + 1);
      const feedback = candidate.feedback === 'useful' ? 100 : candidate.feedback === 'installed' ? 120 : candidate.feedback === 'ignore' ? -100 : 0;
      const rank_score = round(growth * 10 + stars * 5 + forks * 2 + feedback, 2);
      return { ...candidate, rank_score };
    })
    .sort((a, b) => b.rank_score - a.rank_score || (b.stargazers_count ?? b.stars ?? 0) - (a.stargazers_count ?? a.stars ?? 0));
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

async function atomicWrite(file, content) {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
    await fs.rename(temp, file);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

async function atomicWriteJson(file, value) {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

function apiHeaders() {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.github+json',
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
  return headers;
}

async function githubFetch(endpoint) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetch(`${API_BASE}${endpoint}`, {
        headers: apiHeaders(),
        redirect: 'error',
        signal: AbortSignal.timeout(12_000),
      });
      if (response.ok) return await response.json();
      await response.body?.cancel();
      const limited = response.status === 429 || (response.status === 403 && (
        response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after')
      ));
      lastError = Object.assign(new Error(`GitHub API ${response.status}${limited ? '（限流）' : ''}`), { status: response.status, limited });
      if (response.status < 500) throw lastError;
    } catch (error) {
      lastError = error;
      if (error.status || attempt === 2) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
  }
  throw lastError;
}

function normaliseRepo(item, category) {
  return {
    full_name: item.full_name,
    name: item.name,
    html_url: `https://github.com/${item.full_name}`,
    description: item.description || '',
    stargazers_count: Number(item.stargazers_count) || 0,
    forks_count: Number(item.forks_count) || 0,
    open_issues_count: Number(item.open_issues_count) || 0,
    language: item.language || null,
    license: item.license?.spdx_id || null,
    pushed_at: item.pushed_at || null,
    updated_at: item.updated_at || null,
    default_branch: item.default_branch || 'main',
    archived: item.archived === true,
    fork: item.fork === true,
    topics: Array.isArray(item.topics) ? item.topics : [],
    categories: [category],
  };
}

async function searchCandidates() {
  const byName = new Map();
  const warnings = [];
  const queryDays = new Date(Date.now() - 120 * DAY_MS).toISOString().slice(0, 10);
  const rotated = [...SEARCH_GROUPS];
  const offset = Math.floor(Date.now() / (7 * DAY_MS)) % rotated.length;
  rotated.push(...rotated.splice(0, offset));
  search: for (const group of rotated) {
    for (const query of group.queries) {
      try {
        const recent = query === group.queries[1] ? ` created:>=${queryDays}` : '';
        const data = await githubFetch(`/search/repositories?q=${encodeURIComponent(query + recent + ' is:public archived:false fork:false')}&sort=stars&order=desc&per_page=30`);
        if (data.incomplete_results) warnings.push(`搜索 ${query} 返回不完整结果`);
        for (const item of data.items || []) {
          if (!isPublicCandidate(item)) continue;
          const existing = byName.get(item.full_name);
          const candidate = normaliseRepo(item, group.name);
          if (existing) existing.categories = [...new Set([...existing.categories, group.name])];
          else byName.set(item.full_name, candidate);
        }
      } catch (error) {
        warnings.push(`搜索 ${query} 失败：${error.message}`);
        if (error.limited || error.status === 401 || !error.status) break search;
      }
    }
  }
  for (const [fullName, category] of SEED_REPOS) {
    if (!byName.has(fullName)) {
      try {
        const item = await githubFetch(`/repos/${fullName}`);
        if (isPublicCandidate(item)) {
          byName.set(fullName, normaliseRepo(item, category));
        }
      } catch (error) {
        warnings.push(`读取种子 ${fullName} 失败：${error.message}`);
        if (error.limited || error.status === 401 || !error.status) break;
      }
    } else {
      byName.get(fullName).categories = [...new Set([...byName.get(fullName).categories, category])];
    }
  }
  if (!byName.size) {
    warnings.push('GitHub API 没有返回可用数据，本次不会更新基线或下载归档。');
    return { candidates: [], warnings, stale: true };
  }
  return { candidates: [...byName.values()], warnings, stale: false };
}

function isPublicCandidate(item) {
  return item.private === false && !item.disabled && !item.archived && !item.fork &&
    REPO_NAME.test(item.full_name) && Number.isSafeInteger(item.stargazers_count);
}

async function getCommitSha(repo) {
  if (!REPO_NAME.test(repo.full_name)) throw new Error('拒绝无效仓库名');
  const encodedBranch = encodeURIComponent(repo.default_branch || 'main');
  const commit = await githubFetch(`/repos/${repo.full_name}/commits/${encodedBranch}`);
  if (!/^[a-f0-9]{40}$/i.test(commit.sha)) throw new Error('拒绝无效提交哈希');
  return commit.sha;
}

async function downloadArchive(repo, sha, archiveDir, maxBytes) {
  await ensureDir(archiveDir);
  const fileName = safeArchiveName(repo.full_name, sha);
  const target = path.join(archiveDir, fileName);
  const temp = `${target}.${process.pid}.part`;
  const url = `https://codeload.github.com/${repo.full_name}/tar.gz/${sha}`;
  const response = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT },
    redirect: 'error',
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`源码归档下载失败 ${response.status}: ${repo.full_name}`);
  if (!response.url.startsWith('https://codeload.github.com/')) throw new Error('拒绝非 codeload.github.com 的重定向');
  const expectedLength = Number(response.headers.get('content-length')) || null;
  if (!response.body || (expectedLength && expectedLength > maxBytes)) {
    await response.body?.cancel();
    throw new Error('归档为空或超过剩余容量');
  }
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  try {
    const file = await fs.open(temp, 'wx');
    try {
      for await (const chunk of response.body) {
        const buffer = Buffer.from(chunk);
        if (!bytes && (buffer[0] !== 0x1f || buffer[1] !== 0x8b)) throw new Error('响应不是 gzip 归档');
        bytes += buffer.length;
        if (bytes > maxBytes) throw new Error('归档超过本次容量上限');
        hash.update(buffer);
        await file.writeFile(buffer);
      }
      if (!bytes) throw new Error('归档为空');
    } finally {
      await file.close();
    }
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return { file: target, sha256: hash.digest('hex'), bytes, url, commit: sha };
}

async function totalArchiveBytes(archiveDir) {
  let total = 0;
  for (const name of await fs.readdir(archiveDir).catch(() => [])) {
    const item = await fs.lstat(path.join(archiveDir, name));
    if (item.isFile()) total += item.size;
  }
  return total;
}

function formatNumber(value) {
  return Number.isFinite(value) ? value.toLocaleString('en-US') : '—';
}

function formatGrowth(growth) {
  if (growth?.delta == null) return '暂无周环比';
  const sign = growth.delta > 0 ? '+' : '';
  return `${sign}${formatNumber(growth.delta)}（${sign}${growth.perDay}/天，${growth.days} 天）`;
}

function cell(value) {
  return String(value ?? '未知').replace(/[\r\n]/g, ' ').replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[|`\[\]\\]/g, '\\$&');
}

function reportMarkdown({ now, candidates, selected, downloads, stale, root, warnings }) {
  const recommendations = rankCandidates(candidates.filter((repo) => repo.feedback !== 'ignore'));
  const ranked = candidates.filter((repo) => repo.growth.delta > 0)
    .sort((a, b) => b.growth.perDay - a.growth.perDay || b.growth.delta - a.growth.delta).slice(0, 20);
  const lines = [
    '# 每周开源项目调查报告',
    '',
    `生成时间：${new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full', timeStyle: 'long', timeZone: REPORT_TIME_ZONE }).format(now)}`,
    `数据源：${stale ? (candidates.length ? '历史缓存（非本次实测，不写入星标基线）' : '暂无实时数据或历史快照') : 'GitHub REST API'}；覆盖 ${candidates.length} 个样本${warnings.length ? '，详见末尾警告' : ''}。`,
    '',
    '## 本周涨星最快的样本',
    '',
    '| 排名 | 项目 | 方向 | 星标 | 周变化 | fork | 许可证 | 维护时间 | 决策 |',
    '|---:|---|---|---:|---:|---:|---|---|---|',
  ];
  if (!ranked.length) lines.splice(7, 2, '暂无可比较的上涨样本。首周、刚发现的仓库、或没有约七天前的有效快照时，不列入涨星榜。');
  ranked.forEach((repo, index) => {
    const decision = selected.some((item) => item.full_name === repo.full_name) ? '进入下载评估' : '仅观察';
    lines.push(`| ${index + 1} | [${repo.full_name}](${repo.html_url}) | ${repo.categories.join('、')} | ${formatNumber(repo.stargazers_count)} | ${formatGrowth(repo.growth)} | ${formatNumber(repo.forks_count)} | ${cell(repo.license)} | ${cell(repo.pushed_at)} | ${decision} |`);
  });
  lines.push('', '## 四个方向值得跟踪的项目', '', '| 方向 | 项目 | 星标 | 周变化 | 许可证 | 用途 |', '|---|---|---:|---:|---|---|');
  for (const { name } of SEARCH_GROUPS) {
    for (const repo of recommendations.filter((item) => item.categories.includes(name)).slice(0, 4)) {
      lines.push(`| ${name} | [${repo.full_name}](${repo.html_url}) | ${formatNumber(repo.stargazers_count)} | ${stale ? '缓存' : formatGrowth(repo.growth)} | ${cell(repo.license)} | ${cell(repo.description?.slice(0, 155) || '暂无简介')} |`);
    }
  }
  lines.push('', '## 适合本机试用的候选', '');
  for (const repo of recommendations) {
    const note = TRIAL_NOTES.get(repo.full_name.toLowerCase());
    if (note) lines.push(`- [${repo.full_name}](${repo.html_url})：${note}`);
  }
  lines.push('', '## 自动下载与安装决策', '', '| 项目 | 下载 | 原因 | 归档 |', '|---|---|---|---|');
  for (const item of selected) {
    const download = downloads.find((entry) => entry.full_name === item.full_name);
    const reason = item.decision.reasons.length ? item.decision.reasons.join('；') : download ? '归档规则和容量检查通过' : '符合候选规则，归档未完成';
    const archiveText = download ? `${download.bytes} bytes，SHA-256 ` + '`' + download.sha256 + '`' : '未下载';
    lines.push(`| ${item.full_name} | ${download ? '已归档' : item.decision.download ? '未完成' : '否'} | ${reason} | ${archiveText} |`);
  }
  lines.push('', '自动安装：**关闭**。归档是固定提交的源码，未解压、未执行；SHA-256 只记录此次下载内容，不能证明源码安全。', '', `隔离目录：\`${path.join(root, 'quarantine')}\``, '', '## 筛选口径', '', '- 涨星榜按实测日均净增排序，使用距离本次 5–9 天、最接近 7 天的有效快照。', '- 这是 GitHub 搜索样本榜。两组查询分别追踪已有项目和近期新项目，搜索限流时样本会减少。', '- 推荐列表参考星标、fork、实测增长和你的反馈。反馈只调整推荐，不改变实测涨星名次。');
  if (warnings.length) lines.push('', '## 警告', '', ...warnings.map((warning) => `- ${warning}`));
  return `${lines.join('\n')}\n`;
}

async function logEvent(root, event) {
  const logFile = path.join(root, 'logs', `${new Date().toISOString().slice(0, 10)}.jsonl`);
  await ensureDir(path.dirname(logFile));
  await fs.appendFile(logFile, `${JSON.stringify({ at: new Date().toISOString(), ...event })}\n`, 'utf8');
}

async function readFeedback(root) {
  return readJson(path.join(root, 'state', 'feedback.json'), {});
}

async function writeSnapshot(root, snapshot) {
  const stamp = snapshot.fetched_at.replace(/[:.]/g, '-');
  await atomicWriteJson(path.join(root, 'state', 'snapshots', `${stamp}.json`), snapshot);
  await atomicWriteJson(path.join(root, 'state', 'latest.json'), snapshot);
}

async function readComparableSnapshots(root, now) {
  const dir = path.join(root, 'state', 'snapshots');
  const names = await fs.readdir(dir).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const start = new Date(now.getTime() - 10 * DAY_MS).toISOString().slice(0, 10);
  const end = new Date(now.getTime() - 4 * DAY_MS).toISOString().slice(0, 10);
  return Promise.all(names.filter((name) => /^\d{4}-\d{2}-\d{2}T[\d-]+Z\.json$/.test(name) && name.slice(0, 10) >= start && name.slice(0, 10) <= end)
    .map((name) => readJson(path.join(dir, name), { entries: [] })));
}

export async function runSurvey({ root = DEFAULT_ROOT, now = new Date(), download = false } = {}) {
  await ensureDir(root);
  const fetchedAt = now.toISOString();
  const latest = await readJson(path.join(root, 'state', 'latest.json'), null);
  const previous = weeklyBaseline(await readComparableSnapshots(root, now), fetchedAt);
  const feedback = await readFeedback(root);
  const discovered = await searchCandidates();
  const rawCandidates = discovered.stale && latest?.entries?.length
    ? latest.entries.map((entry) => ({ ...entry, stale: true }))
    : discovered.candidates;
  const warnings = [...discovered.warnings];
  const candidates = rawCandidates.map((candidate) => ({
    ...candidate,
    feedback: feedback[candidate.full_name.toLowerCase()]?.status || null,
    growth: calculateGrowth(candidate, previous.get(candidate.full_name.toLowerCase()), fetchedAt),
  }));
  const ranked = rankCandidates(candidates);
  const selectedNames = new Set();
  const selected = [];
  for (const group of SEARCH_GROUPS) {
    const choices = ranked.filter((item) => item.categories.includes(group.name) && !selectedNames.has(item.full_name))
      .map((candidate) => ({ ...candidate, decision: decideDownload(candidate, { now: now.getTime(), requireTrend: true }) }));
    for (const candidate of [...choices.filter((item) => item.decision.download), ...choices.filter((item) => !item.decision.download)].slice(0, 1)) {
      selectedNames.add(candidate.full_name);
      selected.push(candidate);
    }
  }

  if (!download) {
    for (const item of selected) {
      item.decision = {
        ...item.decision,
        download: false,
        reasons: [...item.decision.reasons, '本次未开启下载'],
      };
    }
  }

  const downloads = [];
  const archiveDir = path.join(root, 'quarantine');
  if (download) {
    let currentTotal = await totalArchiveBytes(archiveDir);
    for (const item of selected) {
      if (!item.decision.download) continue;
      try {
        const sha = await getCommitSha(item);
        const fileName = safeArchiveName(item.full_name, sha);
        const existing = path.join(archiveDir, fileName);
        let result;
        try {
          const stat = await fs.lstat(existing);
          if (!stat.isFile() || stat.size < 2 || stat.size > MAX_ARCHIVE_BYTES) throw new Error('已有归档不是允许的普通文件');
          result = { file: existing, bytes: stat.size, sha256: await sha256File(existing), url: `https://codeload.github.com/${item.full_name}/tar.gz/${sha}`, commit: sha };
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          const remaining = Math.min(MAX_ARCHIVE_BYTES, MAX_TOTAL_ARCHIVE_BYTES - currentTotal);
          if (remaining <= 0) throw new Error('隔离区总容量上限已达到');
          result = await downloadArchive(item, sha, archiveDir, remaining);
          currentTotal += result.bytes;
        }
        downloads.push({ full_name: item.full_name, ...result });
        await logEvent(root, { type: 'download', repo: item.full_name, commit: sha, license: item.license, bytes: result.bytes, sha256: result.sha256 });
      } catch (error) {
        warnings.push(`${item.full_name}：${error.message}`);
        await logEvent(root, { type: 'download_skipped', repo: item.full_name, error: error.message });
      }
    }
  }

  const snapshot = {
    schema_version: 1,
    fetched_at: fetchedAt,
    source: 'github-rest-api',
    entries: candidates.map(({ growth, feedback, ...entry }) => ({ ...entry, fetched_at: fetchedAt })),
  };
  if (!discovered.stale) await writeSnapshot(root, snapshot);
  const report = reportMarkdown({ now, candidates, selected, downloads, stale: discovered.stale, root, warnings });
  const localDate = new Intl.DateTimeFormat('sv-SE', { timeZone: REPORT_TIME_ZONE, dateStyle: 'short' }).format(now);
  const reportFile = path.join(root, 'reports', `${localDate}_${fetchedAt.slice(11, 23).replace(/[:.]/g, '-')}Z.md`);
  await atomicWrite(reportFile, report);
  await atomicWrite(path.join(root, 'reports', 'latest.md'), report);
  await logEvent(root, { type: 'run_complete', candidates: candidates.length, downloads: downloads.length, report: reportFile });
  return { root, reportFile, snapshotFile: discovered.stale ? null : path.join(root, 'state', 'latest.json'), candidates, selected, downloads, warnings };
}

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const handle = await fs.open(file, 'r');
  try {
    for await (const chunk of handle.readableWebStream()) hash.update(Buffer.from(chunk));
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

async function updateFeedback(root, repo, status) {
  if (!REPO_NAME.test(repo)) throw new Error('仓库格式应为 owner/repo');
  repo = repo.toLowerCase();
  if (!['useful', 'ignore', 'installed'].includes(status)) throw new Error('状态只能是 useful、ignore 或 installed');
  const file = path.join(root, 'state', 'feedback.json');
  const feedback = await readJson(file, {});
  feedback[repo] = { status, updated_at: new Date().toISOString() };
  await atomicWriteJson(file, feedback);
  return feedback[repo];
}

async function notifyLocal(root, message) {
  if (process.platform !== 'win32') return;
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const command = "$shell = New-Object -ComObject WScript.Shell; [void]$shell.Popup($env:SURVEY_NOTICE, 20, '开源项目周报', 64)";
  const result = await new Promise((resolve) => {
    execFile(powershell, ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', command], {
      env: { ...process.env, SURVEY_NOTICE: message }, windowsHide: true, timeout: 25_000,
    }, (error) => resolve(error?.code ?? null));
  });
  if (result !== null) await logEvent(root, { type: 'notification_failed', code: result });
}

async function main() {
  const args = process.argv.slice(2);
  const root = DEFAULT_ROOT;
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    console.log('Usage: node weekly-surveyor.mjs [--download] [--notify]\n       node weekly-surveyor.mjs --feedback owner/repo useful|ignore|installed');
    return;
  }
  if (args[0] === '--feedback' && args.length === 3) {
    const result = await updateFeedback(root, args[1], args[2]);
    console.log(`已记录 ${args[1]} = ${result.status}`);
    return;
  }
  if (args.some((arg) => !['--download', '--notify'].includes(arg))) throw new Error('未知参数，请运行 --help');
  const result = await runSurvey({ root, download: args.includes('--download') });
  console.log(`报告：${result.reportFile}`);
  console.log(`快照：${result.snapshotFile || '未更新，已保留历史快照'}`);
  console.log(`候选 ${result.candidates.length} 个，下载 ${result.downloads.length} 个，警告 ${result.warnings.length} 条`);
  if (args.includes('--notify')) {
    const status = result.snapshotFile ? `本周调查完成：${result.candidates.length} 个候选，${result.downloads.length} 个归档。` : '本周实时调查未完成，请查看报告。';
    await notifyLocal(root, `${status}\n${path.join(root, 'reports', 'latest.md')}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(async (error) => {
    try { await logEvent(DEFAULT_ROOT, { type: 'run_failed', error: error.message }); } catch {}
    if (process.argv.includes('--notify')) {
      try { await notifyLocal(DEFAULT_ROOT, `本周调查运行失败。日志位置：${path.join(DEFAULT_ROOT, 'logs')}`); } catch {}
    }
    console.error(`调查失败：${error.message}`);
    process.exitCode = 1;
  });
}
