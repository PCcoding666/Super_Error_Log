import crypto from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { getDb, now } from '../../src/db/connection.js';
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
  it('recommends without creating and starts at most three with stable retries',()=>{
    seedPracticeItems(6);
    const key=crypto.randomUUID();
    const proposal=tasks.suggestedPractice('/does-not-exist');
    expect(proposal.recommended).toHaveLength(3);
    expect(getDb().prepare('SELECT COUNT(*) AS n FROM review_packet').get()).toEqual({n:0});
    const first=tasks.startSuggestedPractice('/does-not-exist',key);
    const retry=tasks.startSuggestedPractice('/does-not-exist',key);
    expect(first.ok && first.detail.items).toHaveLength(3);
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
  it('rejects unknown tasks and invalid request keys',()=>{
    expect(()=>tasks.setTaskLifecycle('pkt_missing','paused')).toThrow();
    expect(tasks.startSuggestedPractice('/none','bad')).toMatchObject({ok:false,httpStatus:400});
  });
  it('cancelled packets cannot record through the lower-level return service',()=>{
    const ids=seedPracticeItems(1),p=make(ids);
    tasks.setTaskLifecycle(p.id,'cancelled');
    getDb().prepare("UPDATE review_packet SET status='generated',generated_at=? WHERE id=?").run(now(),p.id);
    getDb().prepare("UPDATE error_item SET status='packet_generated' WHERE id=?").run(ids[0]!);
    const r=recordAttempt(p.id,ids[0]!,{completion:'independent',correct:true,performedAt:new Date().toISOString().slice(0,10)},'student');
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
