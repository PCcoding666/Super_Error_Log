import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const EXPECTED_H2 = [
  'Sub-features',
  'How to get to it (user POV)',
  'Driving it with sel-verify',
  'Gotchas',
] as const;

const LEGACY_OPEN = /drive open \/s\/(items|photos|practices|practice|capture|choose|settings|why|print|record)(\b|\/)/;

export interface AuditFinding {
  file: string;
  kind: 'structure' | 'index' | 'testid' | 'legacy-route';
  detail: string;
}

export interface AuditReport {
  phase: 'source';
  outcome: 'clean' | 'changed' | 'blocked';
  findings: AuditFinding[];
  features: string[];
}

export function auditFeatureDir(featuresDir: string, sourceDirs: string[]): AuditReport {
  if (!existsSync(featuresDir)) {
    return { phase: 'source', outcome: 'blocked', findings: [{ file: featuresDir, kind: 'index', detail: 'features directory is missing' }], features: [] };
  }
  const readmePath = path.join(featuresDir, 'README.md');
  if (!existsSync(readmePath)) {
    return { phase: 'source', outcome: 'blocked', findings: [{ file: 'README.md', kind: 'index', detail: 'features/README.md is missing' }], features: [] };
  }
  const files = readdirSync(featuresDir).filter(name => name.endsWith('.md') && name !== 'README.md').sort();
  const findings: AuditFinding[] = [];
  const readme = readFileSync(readmePath, 'utf8');
  const linked = [...readme.matchAll(/\(\.\/([a-z0-9-]+\.md)\)/g)].map(match => match[1]!);
  const linkedSet = new Set(linked);
  for (const file of files) {
    if (!linkedSet.has(file)) findings.push({ file, kind: 'index', detail: 'feature file is not linked from features/README.md' });
  }
  for (const link of linked) {
    if (!files.includes(link)) findings.push({ file: 'README.md', kind: 'index', detail: `links to missing ${link}` });
  }
  const source = loadSource(sourceDirs);
  for (const file of files) {
    const full = path.join(featuresDir, file);
    const text = readFileSync(full, 'utf8');
    findings.push(...structureFindings(file, text));
    findings.push(...testidFindings(file, text, source));
    const driving = section(text, 'Driving it with sel-verify');
    if (driving && LEGACY_OPEN.test(driving)) {
      findings.push({ file, kind: 'legacy-route', detail: 'driving section opens a leftover server-rendered route. Those paths are not current features.' });
    }
  }
  return {
    phase: 'source',
    outcome: findings.length ? 'changed' : 'clean',
    findings,
    features: files,
  };
}

function structureFindings(file: string, text: string): AuditFinding[] {
  const headings = [...text.matchAll(/^## (.+)$/gm)].map(match => match[1]!.trim());
  if (headings.length !== EXPECTED_H2.length || headings.some((heading, index) => heading !== EXPECTED_H2[index])) {
    return [{
      file,
      kind: 'structure',
      detail: `expected H2s ${EXPECTED_H2.join(' | ')}, found ${headings.join(' | ') || '(none)'}`,
    }];
  }
  if (!/^# .+/m.test(text)) return [{ file, kind: 'structure', detail: 'missing H1' }];
  return [];
}

function section(text: string, heading: string): string | null {
  const start = text.indexOf(`## ${heading}`);
  if (start < 0) return null;
  const rest = text.slice(start + heading.length + 3);
  const next = rest.search(/\n## /);
  return next < 0 ? rest : rest.slice(0, next);
}

function testidsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/--testid(?:=|\s+)([a-z0-9-]+)/g)) found.add(match[1]!);
  return [...found];
}

function testidFindings(file: string, text: string, source: string): AuditFinding[] {
  const findings: AuditFinding[] = [];
  for (const id of testidsIn(text)) {
    if (!source.includes(id)) findings.push({ file, kind: 'testid', detail: `data-testid "${id}" is not in client/src or src` });
  }
  return findings;
}

function loadSource(dirs: string[]): string {
  const chunks: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    walk(dir, chunks);
  }
  return chunks.join('\n');
}

function walk(dir: string, chunks: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, chunks);
    else if (/\.(tsx?|jsx?)$/.test(entry.name) && statSync(full).isFile()) chunks.push(readFileSync(full, 'utf8'));
  }
}
