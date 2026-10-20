/** Legacy API wrappers: exact jobId cards, and every packet member must be legacy. */
import type { ItemStatus } from '../domain/types.js';
import { recommendLearningPractice, createLearningPractice, getLearningPractice, listLearningPractices } from '../learning/queries.js';
import { legacyCard } from '../learning/sources.js';
export interface PracticeCard {
  id: string;
  shortId: string | null;
  subject: string | null;
  knowledgeTags: string[];
  questionExcerpt: string | null;
  badge: 'ok' | 'low';
  status: ItemStatus;
  cropUrl: string;
  jobId: string;
  reason: string;
  tier: 1 | 2 | 3 | 4;
  reflected: boolean;
}

export interface RecommendResponse {
  recommended: PracticeCard[];
  others: PracticeCard[];
  notes: string[];
  limits: { min: number; max: number };
}

export interface PracticeDetail {
  id: string;
  week: string;
  status: string;
  practiceSlot: string | null;
  createdAt: string;
  generatedAt: string | null;
  items: Array<PracticeCard & { position: number }>;
}

export interface PracticeSummary {
  id: string;
  week: string;
  status: string;
  practiceSlot: string | null;
  createdAt: string;
  generatedAt: string | null;
  itemCount: number;
}


export type CreatePracticeResult =
  | { ok: true; detail: PracticeDetail }
  | { ok: false; httpStatus: 400 | 409; message: string };


export function recommendPractice(mobileDataDir:string):RecommendResponse {
 const r=recommendLearningPractice(mobileDataDir,'legacy');return {...r,recommended:r.recommended.map(legacyCard),others:r.others.map(legacyCard)};
}
export function createPractice(input:unknown):CreatePracticeResult {
 const r=createLearningPractice(input,'legacy');return r.ok?{ok:true,detail:{...r.detail,items:r.detail.items.map(legacyCard)}}:r;
}
export function getPractice(id:string):PracticeDetail|null {
 const r=getLearningPractice(id,'legacy');return r?{...r,items:r.items.map(legacyCard)}:null;
}
export function listPractices():PracticeSummary[] {return listLearningPractices('legacy');}
