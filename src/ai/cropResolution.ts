import type { AuditedCrop, CropAuditReport } from './cropAuditor.js';
import { validateInventory } from './cropAudit.js';

export interface HumanCropResolution {
  targetId: string; sourceHash: string; evidenceHash: string; policyVersion: string; modelCheckHash: string;
  reviewedBy: 'student'; reviewedAt: string; requiredElements: string[]; notes: string;
  sourceCompared: true; complete: true; textMatches: boolean; pure: boolean; coveredDiagramIds: string[];
}

/** Explicit human testimony, not a modified model verdict or automatic promotion. */
export function humanResolution(target: AuditedCrop, report: CropAuditReport, checkHash: string, input: unknown): HumanCropResolution {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('人工复核字段无效');
  const v = input as Record<string, unknown>;
  const strings = (raw: unknown): string[] => {
    if (!Array.isArray(raw) || raw.length > 80 || raw.some(x => typeof x !== 'string' || !x.trim() || x.length > 2000)) throw new Error('请逐项填写完整的人工复核清单');
    return raw as string[];
  };
  if (target.technicalStatus === 'not_checked') throw new Error('请先完成本区域自动检查，再处理模型误报');
  if (target.kind === 'question') {
    const inventory = target.assessment?.inventory ?? target.inventory;
    if (!inventory) throw new Error('整题原图清单尚未建立，无法核验必要图示覆盖，请重新运行检查');
    validateInventory(inventory, 'question');
  }
  if (v.modelCheckHash !== checkHash) throw new Error('检查结果已更新，请重新加载后人工复核');
  const requiredElements = strings(v.requiredElements); const coveredDiagramIds = strings(v.coveredDiagramIds);
  if (!requiredElements.length || new Set(coveredDiagramIds).size !== coveredDiagramIds.length || typeof v.notes !== 'string' || v.notes.trim().length < 8 || v.notes.length > 4000) throw new Error('请填写必需内容清单和至少8字的人工核对依据');
  if (v.sourceCompared !== true || v.complete !== true || (target.expectedText && v.textMatches !== true) || (target.kind !== 'question' && v.pure !== true)) throw new Error('请人工确认已对照原图、内容完整、转写一致及证据归属纯净');
  const question = report.targets.find(t => t.kind === 'question');
  const required = (question?.assessment?.inventory ?? question?.inventory)?.items.filter(i => i.category === 'diagram') ?? [];
  if (coveredDiagramIds.some(id => !required.some(i => i.id === id)) || (target.kind !== 'diagram' && coveredDiagramIds.length)) throw new Error('人工图示覆盖引用无效');
  return { targetId: target.id, sourceHash: report.sourceHash, evidenceHash: report.evidenceHash, policyVersion: report.policyVersion, modelCheckHash: checkHash,
    reviewedBy: 'student', reviewedAt: new Date().toISOString(), requiredElements, notes: v.notes.trim(), sourceCompared: true, complete: true,
    textMatches: v.textMatches === true, pure: v.pure === true, coveredDiagramIds };
}
