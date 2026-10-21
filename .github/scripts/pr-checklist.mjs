import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const sha = /^[0-9a-f]{40}$/;
const configPath = '.github/workflows/checklistConfig.json';
const maxDiffBytes = 64 * 1024 * 1024;

// The configured patterns use *, ** and brace alternatives. Match dot paths too,
// as the previous action did; unsupported pattern syntax fails visibly.
function matchesGlob(path, pattern) {
  if (typeof pattern !== 'string' || !/^[\w./*{},?-]+$/.test(pattern))
    throw new Error('Unsupported checklist path pattern');
  const expand = (value) => {
    const brace = /\{([^{}]+)\}/.exec(value);
    if (!brace) {
      if (/[{}]/.test(value)) throw new Error('Invalid checklist path pattern');
      return [value];
    }
    const variants = brace[1]
      .split(',')
      .flatMap((part) =>
        expand(
          value.slice(0, brace.index) +
            part +
            value.slice(brace.index + brace[0].length),
        ),
      );
    if (variants.length > 256)
      throw new Error('Checklist path pattern too large');
    return variants;
  };
  return expand(pattern).some((variant) => {
    const segments = variant.split('/');
    const expression = segments
      .map((segment, index) => {
        if (segment === '**')
          return index === segments.length - 1 ? '.*' : '(?:[^/]+/)*';
        const literal = [...segment]
          .map((character) =>
            character === '*'
              ? '[^/]*'
              : character === '?'
                ? '[^/]'
                : character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
          )
          .join('');
        return literal + (index === segments.length - 1 ? '' : '/');
      })
      .join('');
    return new RegExp(`^${expression}$`).test(path);
  });
}

/** Git and diff contents remain data; never invoke external diff/textconv drivers. */
export function generateChecklist({ cwd, event }) {
  const pr = event.pull_request;
  const repository = event.repository?.full_name;
  if (
    !pr ||
    !sha.test(pr.head?.sha) ||
    !sha.test(pr.base?.sha) ||
    !Number.isSafeInteger(pr.number) ||
    pr.number < 1 ||
    !/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')
  ) {
    throw new Error('Complete pull request identity required');
  }
  const git = (...args) =>
    execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: maxDiffBytes,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const configuration = git('show', `${pr.head.sha}:${configPath}`);
  const { mappings } = JSON.parse(configuration);
  if (!Array.isArray(mappings) || !mappings.length)
    throw new Error('Checklist mappings required');
  for (const mapping of mappings) {
    const triggers =
      mapping.triggers === 'always' ? ['always'] : mapping.triggers;
    const paths =
      typeof mapping.paths === 'string' ? [mapping.paths] : mapping.paths;
    if (
      !Array.isArray(triggers) ||
      !triggers.length ||
      triggers.some((value) => typeof value !== 'string') ||
      !Array.isArray(mapping.items) ||
      !mapping.items.length ||
      mapping.items.some(
        (value) => typeof value !== 'string' || !value || /[\r\n]/.test(value),
      ) ||
      (paths !== undefined &&
        (!Array.isArray(paths) ||
          paths.some((value) => typeof value !== 'string')))
    ) {
      throw new Error('Invalid checklist mapping');
    }
    for (const trigger of triggers) new RegExp(trigger, 'i');
  }
  const mergeBase = git('merge-base', pr.base.sha, pr.head.sha).trim();
  if (!sha.test(mergeBase)) throw new Error('Complete PR ancestry required');
  const names = git(
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--find-renames=50%',
    '--name-status',
    '-z',
    mergeBase,
    pr.head.sha,
    '--',
  ).split('\0');
  if (names.pop() !== '') throw new Error('Incomplete changed-file list');
  const changes = new Map();
  let bytes = 0;
  let fileCount = 0;
  for (let index = 0; index < names.length; ) {
    const status = names[index++];
    if (!/^(?:[AMDT]|R\d+)$/.test(status))
      throw new Error('Unsupported diff status');
    const paths = status.startsWith('R')
      ? [names[index++], names[index++]]
      : [names[index++]];
    if (paths.some((path) => !path) || ++fileCount > 10000)
      throw new Error('Incomplete or oversized changed-file list');
    const relevant = mappings.some(
      (mapping) =>
        !mapping.paths ||
        paths.some((path) =>
          (Array.isArray(mapping.paths) ? mapping.paths : [mapping.paths]).some(
            (pattern) => matchesGlob(path, pattern),
          ),
        ),
    );
    let text = '';
    if (relevant) {
      const patch = git(
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--find-renames=50%',
        '--unified=3',
        mergeBase,
        pr.head.sha,
        '--',
        ...paths,
      );
      bytes += Buffer.byteLength(patch);
      if (
        bytes > maxDiffBytes ||
        /^Binary files /m.test(patch) ||
        /^GIT binary patch$/m.test(patch)
      )
        throw new Error('Complete textual checklist diff required');
      let hunk = false;
      for (const line of patch.split('\n')) {
        if (line.startsWith('diff --git ')) hunk = false;
        else if (line.startsWith('@@ ')) hunk = true;
        else if (hunk && /^[ +\-]/.test(line))
          text += line.slice(1).toLowerCase();
      }
    }
    for (const path of paths) changes.set(path, text);
  }
  const items = [];
  const seen = new Set();
  for (const mapping of mappings) {
    const triggers =
      mapping.triggers === 'always' ? ['always'] : mapping.triggers;
    const always = triggers.includes('always');
    const patterns =
      typeof mapping.paths === 'string' ? [mapping.paths] : mapping.paths;
    const matching = [...changes].filter(
      ([path]) =>
        !patterns || patterns.some((pattern) => matchesGlob(path, pattern)),
    );
    if (
      !always &&
      !triggers.some((trigger) =>
        new RegExp(trigger, 'i').test(
          matching.map(([, text]) => text).join(''),
        ),
      )
    )
      continue;
    for (const label of mapping.items) {
      const item = {
        label,
        paths: !always && patterns ? matching.map(([path]) => path) : [],
      };
      const key = JSON.stringify(item);
      if (!seen.has(key)) {
        items.push(item);
        seen.add(key);
      }
    }
  }
  return {
    version: 1,
    repository,
    number: pr.number,
    head: pr.head.sha,
    base: pr.base.sha,
    configurationDigest: createHash('sha256')
      .update(configuration)
      .digest('hex'),
    items,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const payload = JSON.stringify(
    generateChecklist({ cwd: process.cwd(), event }),
  );
  if (Buffer.byteLength(payload) > 100000)
    throw new Error('Checklist output too large; review required');
  // JSON escapes embedded newlines; output is consumed only by structured parse.
  appendFileSync(process.env.GITHUB_OUTPUT, `checklist=${payload}\n`);
}
