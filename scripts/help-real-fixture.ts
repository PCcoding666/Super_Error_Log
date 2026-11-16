/**
 * Capture-only material extractor. Replays transcribed text from the two real pages
 * in scripts/help-real-papers.ts. Not the synthetic "1 + 1" fixture, and not used by tests.
 * Loaded only when SEL_E2E_MATERIAL_FIXTURE points here, which the help capture server sets
 * on the synthetic test worker.
 */
import sharp from 'sharp';
import { newId } from '../src/db/connection.js';
import { extractMaterial } from '../src/materials/extraction.js';
import type { MaterialStore } from '../src/materials/store.js';
import type { CloudAssemblyOverrides } from '../src/mobile/cloudAssembly.js';
import type { Extraction, Fragment } from '../src/materials/contracts.js';
import { examPage, factorPage, type HelpPageSpec, type HelpQuestion } from './help-real-papers.js';

function pageForWidth(width: number): HelpPageSpec {
  return width >= examPage.minWidth ? examPage : factorPage;
}

function fragmentsFor(question: HelpQuestion, source: { assetId: string; revision: number; sourceHash: string }, order: { n: number }): Fragment[] {
  const base = {
    ...source,
    number: question.number,
    subpart: null,
    page: 1,
    requiresDiagram: false,
    check: 'passed' as const,
    uncertainties: [] as string[],
  };
  const next = (role: Fragment['role'], text: string): Fragment => ({
    ...base,
    fragmentId: newId('mfr'),
    role,
    text,
    order: order.n++,
    box: question.box,
  });
  const parts = [next('question', question.text)];
  if (question.work) parts.push(next('student_work', question.work));
  if (question.reference) parts.push(next('reference_answer', question.reference));
  return parts;
}

function applyTags(store: MaterialStore, page: HelpPageSpec): void {
  const rows = store.db.prepare(`
    SELECT q.id AS question_id, f.content_json
    FROM material_question q
    JOIN material_link_event l ON l.owner_id = q.owner_id AND l.question_id = q.id
    JOIN material_fragment f ON f.owner_id = l.owner_id AND f.id = l.fragment_id AND f.revision = l.fragment_revision
    WHERE q.owner_id = ?
  `).all(store.studentId) as Array<{ question_id: string; content_json: string }>;
  const updated = new Set<string>();
  for (const row of rows) {
    if (updated.has(row.question_id)) continue;
    const fragment = JSON.parse(row.content_json) as { role?: string; text?: string };
    if (fragment.role !== 'question' || !fragment.text) continue;
    const question = page.questions.find(item => fragment.text!.includes(item.match));
    if (!question) continue;
    store.db.prepare('UPDATE material_question SET tags_json = ? WHERE owner_id = ? AND id = ?')
      .run(JSON.stringify(question.tags), store.studentId, row.question_id);
    updated.add(row.question_id);
  }
  if (updated.size < page.questions.length) {
    throw new Error(`help fixture tagged ${updated.size} of ${page.questions.length} questions`);
  }
}

export const configureMaterials: NonNullable<CloudAssemblyOverrides['configureMaterials']> = (jobs, uploads) => {
  jobs.register('extract', async (id, signal) => {
    let page: HelpPageSpec = factorPage;
    await extractMaterial(jobs.store, {
      extract: async input => {
        const meta = await sharp(input.bytes).metadata();
        page = pageForWidth(meta.width ?? 0);
        const source = { assetId: input.assetId, revision: input.revision, sourceHash: uploads.source(input.assetId).sourceHash };
        const order = { n: 0 };
        const extraction: Extraction = {
          assetId: input.assetId,
          revision: input.revision,
          document: { title: page.title, subject: '数学', date: null, printedCode: null, page: 1 },
          fragments: page.questions.flatMap(question => fragmentsFor(question, source, order)),
          warnings: [],
          runs: [],
        };
        return jobs.request(id, 'help-real-paper', async () => extraction);
      },
    }, id, signal);
    applyTags(jobs.store, page);
  });
};
