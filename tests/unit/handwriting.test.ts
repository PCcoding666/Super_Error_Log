import { describe, it, expect } from 'vitest';
import { validateHandwriting } from '../../src/ai/handwriting.js';
describe('handwriting evidence', () => {
  it('preserves uncertain transcription without accepting empty or malformed output', () => {
    expect(validateHandwriting({text:'x = [看不清]',uncertain:true})).toEqual({text:'x = [看不清]',uncertain:true});
    for (const value of [null, {}, {text:'',uncertain:false}, {text:'x',uncertain:'false'}, {text:'x'.repeat(20001),uncertain:false}]) expect(() => validateHandwriting(value)).toThrow();
  });
});
