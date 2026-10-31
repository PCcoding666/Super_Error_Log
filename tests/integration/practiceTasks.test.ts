import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, now } from '../../src/db/connection.js';
import { localDayText } from '../../src/domain/calendarDay.js';
import { createPractice, recommendPractice } from '../../src/v2/practiceService.js';
import * as tasks from '../../src/v2/practiceTasks.js';
import { recordAttempt } from '../../src/services/attemptService.js';
import { discardV2Item } from '../../src/v2/weekService.js';
import { clearPracticeFixtures, seedPracticeItems } from '../helpers/practiceTask.js';

beforeEach(clearPracticeFixtures);

function make(ids: string[]) {
  const r = createPractice({itemIds:ids});
  if (!r.ok) throw new Error(r.message);
  return r.detail;
}

describe('proactive paper task lifecycle',()=>{
  it('recommends only due questions without creating, starts at most five with stable retries',()=>{
    seedPracticeItems(7);
    // 刚录入的题 3 天后才到期。
    expect(tasks.suggestedPractice('/does-not-exist')).toMatchObject({recommended:[],dueTotal:0});
    expect(tasks.startSuggestedPractice('/does-not-exist',crypto.randomUUID())).toMatchObject({ok:false,httpStatus:409});
    getDb().prepare('UPDATE error_item SET created_at=?').run(new Date(Date.now()-4*86400000).toISOString());
    const key=crypto.randomUUID();
    const proposal=tasks.suggestedPractice('/does-not-exist');
    expect(proposal.recommended).toHaveLength(5);
    expect(proposal.dueTotal).toBe(7);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM review_packet').get()).toEqual({n:0});
    const first=tasks.startSuggestedPractice('/does-not-exist',key);
    const retry=tasks.startSuggestedPractice('/does-not-exist',key);
    expect(first.ok && first.detail.items).toHaveLength(5);
    expect(retry).toEqual(first);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM review_packet').get()).toEqual({n:1});
  });
  it('resumes the oldest active unfinished task rather than making a new one',()=>{
    const ids=seedPracticeItems(5), first=make(ids.slice(0,2)), second=make(ids.slice(2,4));
    getDb().prepare('UPDATE review_packet SET created_at=? WHERE id=?').run('2020-01-01T00:00:00Z',first.id);
    expect(tasks.activePractice()?.id).toBe(first.id);
    expect(tasks.startSuggestedPractice('/none',crypto.randomUUID())).toMatchObject({ok:true,detail:{id:first.id}});
    tasks.setTaskLifecycle(first.id,'paused');
    expect(tasks.activePractice()?.id).toBe(second.id);
    tasks.setTaskLifecycle(first.id,'active');
    expect(tasks.activePractice()?.id).toBe(first.id);
  });
  it('cancels without deleting recorded results and releases only unanswered items',()=>{
    const ids=seedPracticeItems(3), p=make(ids);
    getDb().prepare('INSERT INTO review_attempt(id,packet_id,item_id,completion,correct,created_at) VALUES (?,?,?,?,?,?)')
      .run('att_synthetic',p.id,ids[0]!,'independent',1,now());
    getDb().prepare("UPDATE error_item SET status='temporarily_mastered' WHERE id=?").run(ids[0]!);
    tasks.setTaskLifecycle(p.id,'cancelled');
    expect(tasks.taskLifecycle(p.id)).toBe('cancelled');
    expect(tasks.activePractice()).toBeNull();
    expect(recommendPractice('/none').recommended.map(r=>r.id)).toEqual(expect.arrayContaining(ids.slice(1)));
    expect(getDb().prepare('SELECT status FROM error_item WHERE id=?').get(ids[0]!)).toEqual({status:'temporarily_mastered'});
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM review_attempt').get()).toEqual({n:1});
    expect(()=>tasks.setTaskLifecycle(p.id,'active')).toThrow();
    expect(()=>tasks.assertTaskWritable(p.id)).toThrow();
  });
  it('keeps paused task questions reserved and preserves legacy task cancellation',()=>{
    const ids=seedPracticeItems(2), p=make(ids);
    tasks.setTaskLifecycle(p.id,'paused');
    expect(recommendPractice('/none').recommended).toHaveLength(0);
    getDb().prepare('DELETE FROM practice_task WHERE packet_id=?').run(p.id);
    tasks.setTaskLifecycle(p.id,'cancelled');
    expect(recommendPractice('/none').recommended).toHaveLength(2);
  });
  it.each(['missing', 'paused'] as const)('restores reflected legacy items with %s task metadata', metadata => {
    const db = getDb(), ids = seedPracticeItems(3);
    const expected = ['eligible_for_review', 'ready_for_reflection', 'needs_recheck'];
    ids.forEach((id, index) => {
      db.prepare('UPDATE error_item SET status=? WHERE id=?').run(expected[index]!, id);
      if (index !== 1) {
        db.prepare(`INSERT INTO error_diagnosis(id,item_id,attempt_state,cause,mastery_feeling,review_value,submitted_by,created_at)
          VALUES (?,?,'其他','计算',2,'可以再做','student',?)`).run(`dia_${index}`, id, now());
      }
    });
    const diagnoses = db.prepare('SELECT * FROM error_diagnosis ORDER BY id').all();
    const p = make(ids);
    // Pre-upgrade tasks have no snapshot; pausing them creates an empty one.
    db.prepare('DELETE FROM practice_task WHERE packet_id=?').run(p.id);
    if (metadata === 'paused') tasks.setTaskLifecycle(p.id, 'paused');
    tasks.setTaskLifecycle(p.id, 'cancelled');
    expect(ids.map(id => db.prepare('SELECT status FROM error_item WHERE id=?').get(id)?.status)).toEqual(expected);
    expect(db.prepare('SELECT * FROM error_diagnosis ORDER BY id').all()).toEqual(diagnoses);
    expect(db.prepare('SELECT COUNT(*) n FROM review_attempt').get()).toEqual({ n: 0 });
  });
  it('prefers a saved original status over the reflection fallback', () => {
    const db = getDb(), [id] = seedPracticeItems(1);
    db.prepare(`INSERT INTO error_diagnosis(id,item_id,attempt_state,cause,mastery_feeling,review_value,submitted_by,created_at)
      VALUES ('dia_saved',?,'其他','计算',2,'可以再做','student',?)`).run(id!, now());
    const p = make([id!]);
    tasks.setTaskLifecycle(p.id, 'cancelled');
    expect(db.prepare('SELECT status FROM error_item WHERE id=?').get(id!)).toEqual({ status: 'ready_for_reflection' });
  });
  it('rejects unknown tasks and invalid request keys',()=>{
    expect(()=>tasks.setTaskLifecycle('pkt_missing','paused')).toThrow();
    expect(tasks.startSuggestedPractice('/none','bad')).toMatchObject({ok:false,httpStatus:400});
  });
  it('cancelled packets cannot record through the lower-level return service',()=>{
    const ids=seedPracticeItems(1),p=make(ids);
    tasks.setTaskLifecycle(p.id,'cancelled');
    getDb().prepare("UPDATE review_packet SET status='generated',generated_at=? WHERE id=?").run(now(),p.id);
    getDb().prepare("UPDATE error_item SET status='packet_generated' WHERE id=?").run(ids[0]!);
    const r=recordAttempt(p.id,ids[0]!,{completion:'independent',correct:true,performedAt:localDayText(new Date())},'student');
    expect(r.ok).toBe(false);
    expect(r.error).toContain('取消');
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM review_attempt').get()).toEqual({n:0});
  });
  it('a cancelled reservation does not block removing a wrongly imported question',()=>{
    const ids=seedPracticeItems(1),p=make(ids);
    tasks.setTaskLifecycle(p.id,'cancelled');
    expect(discardV2Item(ids[0]!)).toMatchObject({ok:true});
  });
});
