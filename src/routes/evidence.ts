import { Router } from 'express';
import { requireStudent } from './middleware.js';
import { getItem } from '../services/itemService.js';
import { getDb } from '../db/connection.js';
import { discardEvidenceCandidate, getEvidence, saveEvidence, getEvidenceCrop, getQuestionCrop, analyzeEvidence, checkEvidenceCrops, resolveEvidenceCrop } from '../services/evidenceService.js';
import { expandCropBox } from '../ai/cropAudit.js';
import { finalizeBatch } from '../services/batchService.js';
import { EvidencePage } from '../views/evidence.js';
import { sendHtml } from '../views/render.js';
import type { Evidence, ObservationKind, Region } from '../ai/evidence.js';

export function evidenceRouter(): Router {
  const r = Router();
  r.use('/items/:id/evidence', requireStudent);
  r.get('/items/:id/evidence', (req, res) => {
    const id = String(req.params.id); const item = getItem(id); const record = getEvidence(id);
    if (!item || !record) { res.status(404).send('没有真实提取证据'); return; }
    const locked = !!getDb().prepare('SELECT 1 FROM review_packet_item WHERE item_id=? LIMIT 1').get(id);
    sendHtml(res, EvidencePage({ item, record, locked, error: typeof req.query.err === 'string' ? req.query.err : undefined }));
  });
  r.get('/items/:id/evidence/crop/:regionId', async (req, res) => {
    try { res.type('image/jpeg').set('Cache-Control', 'private, no-store').send(await getEvidenceCrop(String(req.params.id), String(req.params.regionId))); }
    catch { res.status(404).send('图示区域无法读取'); }
  });
  r.get('/items/:id/evidence/question-crop', async (req, res) => {
    try { res.type('image/jpeg').set('Cache-Control', 'private, no-store').send(await getQuestionCrop(String(req.params.id))); }
    catch { res.status(404).send('整题裁图无法读取'); }
  });
  r.post('/items/:id/evidence/check-crops', async (req, res) => {
    const id = String(req.params.id);
    try { await checkEvidenceCrops(id, Number(req.body.revision)); res.redirect(`/items/${id}/evidence`); }
    catch (e) { res.redirect(`/items/${id}/evidence?err=${encodeURIComponent(e instanceof Error ? e.message : '检查失败')}`); }
  });
  r.post('/items/:id/evidence/resolve-crop', (req, res) => {
    const id = String(req.params.id);
    try {
      const diagramIds = req.body.covered_diagram_ids;
      resolveEvidenceCrop(id, Number(req.body.revision), String(req.body.target), {
        modelCheckHash: String(req.body.model_check_hash),
        requiredElements: String(req.body.required_elements ?? '').split('\n').map(s => s.trim()).filter(Boolean),
        notes: String(req.body.notes ?? ''), sourceCompared: req.body.source_compared === '1', complete: req.body.complete === '1',
        textMatches: req.body.text_matches === '1', pure: req.body.pure === '1',
        coveredDiagramIds: Array.isArray(diagramIds) ? diagramIds : typeof diagramIds === 'string' ? [diagramIds] : [],
      });
      res.redirect(`/items/${id}/evidence`);
    } catch (e) { res.redirect(`/items/${id}/evidence?err=${encodeURIComponent(e instanceof Error ? e.message : '人工复核保存失败')}`); }
  });
  r.post('/items/:id/evidence/expand-crop', async (req, res) => {
    const id = String(req.params.id);
    try {
      const record = getEvidence(id); if (!record || record.revision !== Number(req.body.revision)) throw new Error('证据已更新，请重新加载');
      const content = structuredClone(record.content); const target = String(req.body.target);
      if (target === 'question') content.questionRegion = expandCropBox(content.questionRegion);
      else {
        const region = content.regions.find(r => `region:${r.id}` === target); if (!region) throw new Error('区域不存在');
        region.box = expandCropBox(region.box); region.cleanForPrint = false;
      }
      await saveEvidence(id, content, false); res.redirect(`/items/${id}/evidence`);
    } catch (e) { res.redirect(`/items/${id}/evidence?err=${encodeURIComponent(e instanceof Error ? e.message : '扩大失败')}`); }
  });
  r.post('/items/:id/evidence', async (req, res) => {
    const id = String(req.params.id);
    try {
      const record = getEvidence(id); if (!record) throw new Error('没有真实提取证据');
      if (Number(req.body.revision) !== record.revision) throw new Error('页面版本已过期，请重新加载');
      let content: Evidence;
      if (req.body.use_json === '1') content = JSON.parse(String(req.body.evidence_json));
      else {
        content = structuredClone(record.content);
        content.questionText = String(req.body.question_text ?? '');
        content.subject = String(req.body.subject) as Evidence['subject'];
        content.chapter = String(req.body.chapter ?? ''); content.questionType = String(req.body.question_type ?? '');
        content.knowledgeTags = String(req.body.knowledge_tags ?? '').split(/[,，、]/).map(s => s.trim()).filter(Boolean);
        content.requiresDiagram = req.body.requires_diagram === '1';
        for (const key of ['x', 'y', 'width', 'height'] as const) content.questionRegion[key] = Number(req.body[`question_${key}`]);
        content.uncertainties = String(req.body.uncertainties ?? '').split('\n').map(s => s.trim()).filter(Boolean);
        content.regions.forEach((region, i) => {
          region.kind = String(req.body[`region_kind_${i}`]) as Region['kind'];
          for (const key of ['x', 'y', 'width', 'height'] as const) region.box[key] = Number(req.body[`region_${key}_${i}`]);
          region.cleanForPrint = region.kind === 'diagram' && req.body[`region_clean_${i}`] === '1';
        });
        content.observations.forEach((o, i) => {
          o.kind = String(req.body[`observation_kind_${i}`]) as ObservationKind;
          o.text = String(req.body[`observation_text_${i}`] ?? '');
        });
      }
      await saveEvidence(id, content, req.body.action === 'confirm');
      res.redirect(`/items/${id}/evidence`);
    } catch (e) { res.redirect(`/items/${id}/evidence?err=${encodeURIComponent(e instanceof SyntaxError ? '高级 JSON 格式错误' : e instanceof Error ? e.message : '保存失败')}`); }
  });
  for (const stage of ['diagnose', 'coach'] as const) r.post(`/items/:id/evidence/${stage}`, async (req, res) => {
    const id = String(req.params.id);
    try { await analyzeEvidence(id, stage); res.redirect(`/items/${id}/evidence`); }
    catch (e) { res.redirect(`/items/${id}/evidence?err=${encodeURIComponent(e instanceof Error ? e.message : '分析失败')}`); }
  });
  r.post('/items/:id/evidence/discard', (req, res) => {
    const id = String(req.params.id);
    try {
      discardEvidenceCandidate(id);
      const batchId = getItem(id)!.batch_id; finalizeBatch(batchId);
      res.redirect(`/batches/${batchId}/review`);
    } catch (e) { res.redirect(`/items/${id}/evidence?err=${encodeURIComponent(e instanceof Error ? e.message : '排除失败')}`); }
  });
  return r;
}
