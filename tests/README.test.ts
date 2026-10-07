import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const README = readFileSync(join(import.meta.dirname, '..', 'README.md'), 'utf-8');

function extractSection(document: string, title: string): string {
  const start = document.indexOf(`## ${title}\n`);
  expect(start, `README should document the "${title}" section`).toBeGreaterThanOrEqual(0);
  const next = document.indexOf('\n## ', start + 1);
  return next === -1 ? document.slice(start) : document.slice(start, next);
}

function extractBashFence(text: string, label: string): string {
  const fence = text.indexOf('```bash\n');
  expect(fence, `${label} should include a bash code fence`).toBeGreaterThanOrEqual(0);
  const fenceEnd = text.indexOf('```', fence + 8);
  return text.slice(fence + 8, fenceEnd);
}

describe('README publishing docs', () => {
  const section = extractSection(README, 'Publishing to Obvious');

  it('has a Publishing to Obvious section', () => {
    expect(section).toContain('one-way');
    expect(section).toContain('never deletes workspace skills');
  });

  it('publish syntax matches the locked command shape', () => {
    const syntax = section.slice(section.indexOf('### Syntax'), section.indexOf('### Options'));
    const code = extractBashFence(syntax, 'Syntax');
    expect(code).toContain('skills publish [path] --to obvious');
    expect(syntax).toContain('defaults to the current directory');
    expect(section).toContain('SKILL.md');
    expect(section).toContain('tree');
  });

  it('documents every locked publish flag in the options table', () => {
    for (const flag of [
      '--to',
      '--skill',
      '--all',
      '-y, --yes',
      '--json',
      '--dry-run',
      '--force',
    ]) {
      expect(section).toContain(flag);
    }
  });

  it('examples cover the single-directory and tree cases', () => {
    const examples = section.slice(section.indexOf('### Examples'), section.indexOf('### Output'));
    const code = extractBashFence(examples, 'Examples');
    expect(code).toContain('--skill deploy-checklist');
    expect(code).toContain('--all');
    expect(code).toContain('--dry-run');
    expect(code).toContain('--json');
  });

  it('documents the output contract', () => {
    for (const action of ['created', 'updated', 'failed']) {
      expect(section).toContain(action);
    }
    for (const field of ['name', 'action', 'skillId', 'error']) {
      expect(section).toContain(field);
    }
    expect(section).toContain('--json');
    expect(section).toContain('every discovered skill');
    expect(section).toContain('exit code');
  });

  it('documents the auth order with the env override first', () => {
    const envStart = section.indexOf('1. `OBVIOUS_API_TOKEN`');
    expect(envStart, 'env override should come first in the auth list').toBeGreaterThanOrEqual(0);
    expect(
      section.indexOf('Browser login'),
      'browser login should come after the env override'
    ).toBeGreaterThan(envStart);
    expect(section).toContain('CI');
    expect(section).toContain('token-issuing endpoint');
    expect(section).toContain('OBVIOUS_API_BASE_URL');
    expect(section).toContain('api.app.obvious.ai');
  });

  it('documents conflict semantics with --force', () => {
    const conflicts = section.slice(section.indexOf('### Conflicts'));
    expect(conflicts).toContain('frontmatter');
    expect(conflicts).toContain('--force');
    expect(conflicts).toContain('--yes');
    expect(conflicts).toContain('failed');
    expect(conflicts).toContain('the run exits `1`');
  });
});
