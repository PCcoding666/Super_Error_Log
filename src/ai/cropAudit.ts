import { AiError } from './errors.js';
import { validateBox, type Box } from '../media/images.js';

export const CROP_AUDIT_VERSION = 'crop-audit-v3-20260907';
export type Completeness = 'pass' | 'missing' | 'uncertain';
export type Purity = 'clean' | 'contaminated' | 'uncertain';
export type TextFidelity = 'match' | 'mismatch' | 'uncertain' | 'not_applicable';
export interface SourceInventory {
  questionNumber: string;
  sourceStatus: 'readable' | 'incomplete' | 'uncertain'; referenceText: string; uncertainties: string[];
  items: Array<{ id: string; category: 'condition' | 'request' | 'option' | 'diagram' | 'mark'; description: string }>;
}
export interface CropComparison {
  coveredDiagramIds: string[];
  checks: Array<{ id: string; visibility: 'present' | 'missing' | 'uncertain'; note: string }>;
  unexpectedMissing: string[]; uncertainties: string[]; boundary: 'clear' | 'touching' | 'uncertain';
  purity: { status: Purity; issues: string[] }; textFidelity: TextFidelity; textNote: string;
}
export interface CropAssessment {
  completeness: Completeness; purity: Purity; textFidelity: TextFidelity; warnings: string[];
  inventory: SourceInventory; comparison: CropComparison;
}

function bad(): never { throw new AiError('invalid_json', '裁图检查清单不完整或字段不合法'); }
function obj(v: unknown): Record<string, unknown> { if (!v || typeof v !== 'object' || Array.isArray(v)) bad(); return v as Record<string, unknown>; }
function str(v: unknown): string { if (typeof v !== 'string' || !v.trim() || v.length > 12000) bad(); return v; }
function list(v: unknown): unknown[] { if (!Array.isArray(v) || v.length > 80) bad(); return v; }
function strings(v: unknown): string[] { return list(v).map(str); }
function choice<T extends string>(v: unknown, allowed: readonly T[]): T { if (!allowed.includes(v as T)) bad(); return v as T; }
function unique(ids: string[]): void { if (new Set(ids).size !== ids.length) bad(); }

export function validateInventory(value: unknown, kind: string, expectedQuestionNumber?: string): SourceInventory {
  const v = obj(value);
  const questionNumber = str(v.questionNumber);
  if (expectedQuestionNumber !== undefined && questionNumber !== expectedQuestionNumber) bad();
  const items = list(v.items).map(raw => { const i = obj(raw); return { id: str(i.id),
    category: choice(i.category, ['condition', 'request', 'option', 'diagram', 'mark']), description: str(i.description) }; });
  if (!items.length || (kind === 'question' && !items.some(i => i.category === 'request'))) bad();
  if (kind === 'question' && items.some(i => !['condition', 'request', 'option', 'diagram'].includes(i.category))) bad();
  if (kind === 'diagram' && items.some(i => i.category !== 'diagram')) bad();
  if (!['question', 'diagram'].includes(kind) && items.some(i => i.category !== 'mark')) bad();
  unique(items.map(i => i.id));
  return { questionNumber, sourceStatus: choice(v.sourceStatus, ['readable', 'incomplete', 'uncertain']),
    referenceText: str(v.referenceText), uncertainties: strings(v.uncertainties), items };
}

/** Derive the verdict from exhaustive item checks; never trust model-level `pass` or confidence. */
export function assessCrop(inventoryValue: unknown, comparisonValue: unknown, kind: string): CropAssessment {
  const inventory = validateInventory(inventoryValue, kind); const v = obj(comparisonValue); const p = obj(v.purity);
  const checks = list(v.checks).map(raw => { const c = obj(raw); return { id: str(c.id),
    visibility: choice(c.visibility, ['present', 'missing', 'uncertain']), note: str(c.note) }; });
  unique(checks.map(c => c.id));
  if (checks.length !== inventory.items.length || checks.some(c => !inventory.items.some(i => i.id === c.id))) bad();
  const comparison: CropComparison = { checks, coveredDiagramIds: v.coveredDiagramIds === undefined && kind !== 'diagram' ? [] : strings(v.coveredDiagramIds), unexpectedMissing: strings(v.unexpectedMissing), uncertainties: strings(v.uncertainties),
    boundary: choice(v.boundary, ['clear', 'touching', 'uncertain']),
    purity: { status: choice(p.status, ['clean', 'contaminated', 'uncertain']), issues: strings(p.issues) },
    textFidelity: choice(v.textFidelity, ['match', 'mismatch', 'uncertain', 'not_applicable']), textNote: str(v.textNote) };
  if (kind === 'question' && comparison.textFidelity === 'not_applicable') bad();
  unique(comparison.coveredDiagramIds);
  const missing = checks.some(c => c.visibility === 'missing') || comparison.unexpectedMissing.length > 0;
  const uncertain = inventory.sourceStatus !== 'readable' || inventory.uncertainties.length > 0 || comparison.uncertainties.length > 0
    || checks.some(c => c.visibility === 'uncertain') || comparison.boundary === 'uncertain';
  return { inventory, comparison, completeness: missing ? 'missing' : uncertain ? 'uncertain' : 'pass',
    purity: comparison.purity.issues.length ? 'contaminated' : comparison.purity.status, textFidelity: comparison.textFidelity,
    warnings: comparison.boundary === 'touching' ? ['内容接触裁图边缘，请人工复核'] : [] };
}

/** Context expansion is a review proposal, never an automatic approval or a replacement crop. */
export function expandCropBox(value: Box): Box {
  const b = validateBox(value); const dx = Math.max(.005, b.width * .25); const dy = Math.max(.005, b.height * .25);
  const x = Math.max(0, b.x - dx); const y = Math.max(0, b.y - dy);
  return validateBox({ x, y, width: Math.min(1, b.x + b.width + dx) - x, height: Math.min(1, b.y + b.height + dy) - y });
}
