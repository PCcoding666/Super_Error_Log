import { describe, expect, it } from 'vitest';
import { NOTEBOOK_STATUS_GROUPS, matchesNotebook, notebookStatusFilter, notebookUrl, resolveNotebookStage, safeNotebookReturn, stageFilterChoices } from '../../src/web/notebook.js';
import type { V2WeekItem } from '../../src/v2/weekService.js';

const item: V2WeekItem = {id:'itm_0123456789abcdef',shortId:'M-01',grade:'初中',subject:'数学',chapter:'方程',knowledgeTags:['判别式'],questionExcerpt:'短题干',status:'needs_recheck',badge:'low',cropUrl:'',jobId:''};
const filters = {grade:'初中',subject:'数学',chapter:'方程',status:'todo',q:''};
describe('notebook filters and safe return context',()=>{
  it('combines every filter with full text, short number, chapter and tags',()=>{
    for (const q of ['完整题目末尾','m-01','方程','判别式']) expect(matchesNotebook(item,{...filters,q},'完整题目末尾')).toBe(true);
    for (const changed of [{grade:'高中'},{subject:'物理'},{chapter:'函数'},{status:'practicing'},{q:'没有这个词'}]) expect(matchesNotebook(item,{...filters,...changed})).toBe(false);
    expect(matchesNotebook(item,{...filters,grade:'全部'})).toBe(true);
    expect(matchesNotebook({...item,grade:'高中'},{...filters,grade:'全部'})).toBe(true);
  });
  it('preserves a bounded exact selection, including nine questions and an empty selection',()=>{
    const ids=Array.from({length:9},(_,i)=>`itm_${i.toString(16).padStart(16,'0')}`);
    const context=`${notebookUrl(filters)}&mode=select&${new URLSearchParams(ids.map(id=>['itemIds',id]))}#item-${item.id}`;
    expect(safeNotebookReturn(context,'/fallback')).toBe(context);
    const empty=`${notebookUrl(filters)}&mode=select#item-${item.id}`;
    expect(safeNotebookReturn(empty,'/fallback')).toBe(empty);
    for(const query of ['mode=wrong','itemIds=itm_0123456789abcdef','mode=select&itemIds=bad','mode=select&itemIds=itm_0123456789abcdef&itemIds=itm_0123456789abcdef']) expect(safeNotebookReturn(`/s/items?${query}`,'/fallback')).toBe('/fallback');
    expect(safeNotebookReturn(`/s/items?mode=select&${new URLSearchParams(Array.from({length:300},(_,i)=>['itemIds',`itm_${i.toString(16).padStart(16,'0')}`]))}`,'/fallback')).toBe('/fallback');
  });
  it('matches unclassified subjects and chapters without hiding them',()=>{
    expect(matchesNotebook({...item,subject:null,chapter:undefined},{...filters,subject:'未分类',chapter:'未分类'})).toBe(true);
  });
  it('canonicalizes allowed query keys and a valid anchor',()=>{
    const canonical=notebookUrl({...filters,q:'x + y'},item.id);
    expect(safeNotebookReturn(canonical,'/fallback')).toBe(canonical);
    expect(safeNotebookReturn('/s/items?q=x&grade=初中&subject=数学','/fallback')).toBe(notebookUrl({grade:'初中',subject:'数学',q:'x'}));
    expect(safeNotebookReturn('/s/items?grade=高中','/fallback')).toBe(notebookUrl({grade:'高中'}));
    expect(safeNotebookReturn('/s/items?grade=全部','/fallback')).toBe(notebookUrl({grade:'全部'}));
    expect(safeNotebookReturn('/s/items?grade=初二&status=made-up','/fallback')).toBe('/s/items');
    expect(safeNotebookReturn('/s/items?grade=大学&status=made-up','/fallback')).toBe('/s/items');
    expect(safeNotebookReturn('/s/items?status=toString','/fallback')).toBe('/s/items');
  });
  it('shows four student status groups and keeps old status links in their group', () => {
    expect(Object.values(NOTEBOOK_STATUS_GROUPS)).toEqual(['待练习', '练习中', '真会了', '稳了']);
    expect(notebookStatusFilter('todo')).toBe('todo');
    expect(notebookStatusFilter('needs_recheck')).toBe('todo');
    expect(notebookStatusFilter('attempted')).toBe('todo');
    expect(notebookStatusFilter('packet_generated')).toBe('practicing');
    expect(notebookStatusFilter('temporarily_mastered')).toBe('mastered');
    expect(notebookStatusFilter('stably_mastered')).toBe('stable');
    expect(notebookStatusFilter('archived_not_worth_review')).toBe('');
    expect(notebookStatusFilter('toString')).toBe('');
    expect(safeNotebookReturn('/s/items?grade=初中&status=needs_recheck','/fallback')).toBe(notebookUrl({grade:'初中',status:'todo'}));
    expect(matchesNotebook({...item,status:'needs_recheck'},{...filters,status:'todo'})).toBe(true);
    expect(matchesNotebook({...item,status:'scheduled'},{...filters,status:'todo'})).toBe(false);
    expect(matchesNotebook({...item,status:'scheduled'},{...filters,status:'practicing'})).toBe(true);
  });
  it('offers only stages that are stored for the subject', () => {
    expect(stageFilterChoices([])).toEqual(['全部']);
    expect(stageFilterChoices(['初中'])).toEqual(['初中']);
    expect(stageFilterChoices(['高中', '初中', '高中'])).toEqual(['全部', '初中', '高中']);
  });
  it('keeps an explicit stage after its questions are gone and ignores a stale empty-stage cookie', () => {
    expect(resolveNotebookStage('初中', ['高中', '初中', '全部'], [])).toEqual({ grade: '初中', stages: ['初中'] });
    expect(resolveNotebookStage('全部', ['初中'], ['初中'])).toEqual({ grade: '全部', stages: ['全部', '初中'] });
    expect(resolveNotebookStage('高中', ['初中'], ['初中'])).toEqual({ grade: '高中', stages: ['全部', '初中', '高中'] });
    expect(resolveNotebookStage('', ['高中', '初中', '全部'], ['初中'])).toEqual({ grade: '初中', stages: ['初中'] });
    expect(resolveNotebookStage('初三', ['高中', '全部'], ['初中'])).toEqual({ grade: '初中', stages: ['初中'] });
  });
  it.each(['https://evil.example/s/items','//evil.example/s/items','/s/settings','/s/items/../settings','/s/items%3Fq=x','/s/items?redirect=/s/settings','/s/items#bad','/s/items\\?q=x','/s/items\n?q=x'])('rejects an untrusted return destination: %s',(value)=>{
    expect(safeNotebookReturn(value,'/fallback')).toBe('/fallback');
  });
});
