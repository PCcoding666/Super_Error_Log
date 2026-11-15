import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditFeatureDir } from '../../.claude/skills/verify-sel/src/maintain.js';

const repoRoot = path.resolve(import.meta.dirname, '../..');
const features = path.join(repoRoot, '.claude/skills/verify-sel/features');
const sources = [path.join(repoRoot, 'client/src'), path.join(repoRoot, 'src')];

describe('verify-sel feature map', () => {
  it('matches the current client and server source', () => {
    const report = auditFeatureDir(features, sources);
    expect(report.outcome, JSON.stringify(report.findings, null, 2)).toBe('clean');
    expect(report.features).toContain('notebook.md');
    expect(report.features).toContain('item-detail.md');
  });

  it('reports a broken heading and a missing test id without editing anything', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'verify-sel-map-'));
    try {
      writeFileSync(path.join(dir, 'README.md'), '- [Broken](./broken.md)\n');
      writeFileSync(path.join(dir, 'broken.md'), '# Broken\n\nA page.\n\n## Sub-features\n\n- `x` does x.\n\n## Driving it with sel-verify\n\n- `sel-verify drive click --testid not-a-real-control`\n\n## Gotchas\n\n- none.\n');
      const report = auditFeatureDir(dir, sources);
      expect(report.outcome).toBe('changed');
      expect(report.findings.map(finding => finding.kind).sort()).toEqual(['structure', 'testid']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('flags a driving step that opens a leftover route', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'verify-sel-legacy-'));
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'README.md'), '- [Old](./old.md)\n');
      writeFileSync(path.join(dir, 'old.md'), [
        '# Old',
        '',
        'Leftover.',
        '',
        '## Sub-features',
        '',
        '- `old` opens the old list.',
        '',
        '## How to get to it (user POV)',
        '',
        '- Open the old list.',
        '',
        '## Driving it with sel-verify',
        '',
        '- `sel-verify drive open /s/items`',
        '',
        '## Gotchas',
        '',
        '- This route has no current entry.',
        '',
      ].join('\n'));
      const report = auditFeatureDir(dir, sources);
      expect(report.findings.some(finding => finding.kind === 'legacy-route')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
