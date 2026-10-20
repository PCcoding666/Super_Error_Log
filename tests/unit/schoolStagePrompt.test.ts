import { expect, it } from 'vitest';
import { EXTRACT_ITEMS_PROMPT, SUGGEST_FIELDS_PROMPT } from '../../src/ai/openaiProvider.js';
import { STAGED_SAFETY } from '../../src/ai/stagedProvider.js';

it('names 中学 and does not inject a school stage', () => {
  for (const prompt of [STAGED_SAFETY, EXTRACT_ITEMS_PROMPT, SUGGEST_FIELDS_PROMPT]) {
    expect(prompt).toContain('你是中学');
    expect(prompt).not.toContain('初中');
    expect(prompt).not.toContain('高中');
    expect(prompt).not.toContain('初三');
    expect(prompt).not.toContain('高三');
  }
});
