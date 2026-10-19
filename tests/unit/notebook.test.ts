import { describe, expect, it } from 'vitest';
import { matchesNotebook, notebookUrl, safeNotebookReturn } from '../../src/web/notebook.js';
import type { V2WeekItem } from '../../src/v2/weekService.js';

const item: V2WeekItem = {id:'itm_0123456789abcdef',shortId:'M-01',grade:'初二',subject:'数学',chapter:'方程',knowledgeTags:['判别式'],questionExcerpt:'短题干',status:'needs_recheck',badge:'low',cropUrl:'',jobId:''};
const filters = {grade:'初二',subject:'数学',chapter:'方程',status:'needs_recheck',q:''};
describe('notebook filters and safe return context',()=>{
  it('combines every filter with full text, short number, chapter and tags',()=>{
    for (const q of ['完整题目末尾','m-01','方程','判别式']) expect(matchesNotebook(item,{...filters,q},'完整题目末尾')).toBe(true);
    for (const changed of [{grade:'初三'},{subject:'物理'},{chapter:'函数'},{status:'scheduled'},{q:'没有这个词'}]) expect(matchesNotebook(item,{...filters,...changed})).toBe(false);
  });
  it('matches unclassified subjects and chapters without hiding them',()=>{
    expect(matchesNotebook({...item,subject:null,chapter:undefined},{...filters,subject:'未分类',chapter:'未分类'})).toBe(true);
  });
  it('canonicalizes allowed query keys and a valid anchor',()=>{
    const canonical=notebookUrl({...filters,q:'x + y'},item.id);
    expect(safeNotebookReturn(canonical,'/fallback')).toBe(canonical);
    expect(safeNotebookReturn('/s/items?q=x&grade=初二&subject=数学','/fallback')).toBe(notebookUrl({grade:'初二',subject:'数学',q:'x'}));
    expect(safeNotebookReturn('/s/items?grade=大学&status=made-up','/fallback')).toBe('/s/items');
    expect(safeNotebookReturn('/s/items?status=toString','/fallback')).toBe('/s/items');
  });
  it.each(['https://evil.example/s/items','//evil.example/s/items','/s/settings','/s/items/../settings','/s/items%3Fq=x','/s/items?redirect=/s/settings','/s/items#bad','/s/items\\?q=x','/s/items\n?q=x'])('rejects an untrusted return destination: %s',(value)=>{
    expect(safeNotebookReturn(value,'/fallback')).toBe('/fallback');
  });
});
