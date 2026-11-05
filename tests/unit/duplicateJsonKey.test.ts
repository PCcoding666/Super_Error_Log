import { describe, expect, it } from 'vitest';
import { duplicateJsonKey } from '../../src/ai/chatClient.js';

describe('duplicateJsonKey', () => {
  it('returns null for objects whose keys are unique per object', () => {
    expect(duplicateJsonKey('{"candidates":[{"number":"1","box":{"x1":1}},{"number":"2","box":{"x1":2}}],"warnings":[]}')).toBeNull();
    expect(duplicateJsonKey('[]')).toBeNull();
    expect(duplicateJsonKey('"number"')).toBeNull();
  });

  it('finds the key a collapsed inventory repeats inside one candidate object', () => {
    expect(duplicateJsonKey('{"candidates":[{"number":"1","box":{"x1":80,"selectionEvidence":"marked_wrong"},"number":"2","box":{"x1":90}}]}')).toBe('number');
  });

  it('finds a duplicate in a nested object after sibling arrays close', () => {
    expect(duplicateJsonKey('{"a":[1,{"b":2}],"c":{"d":1,"e":[{"d":3}],"d":2}}')).toBe('d');
  });

  it('ignores braces, commas, quotes and key-like text inside string values', () => {
    expect(duplicateJsonKey('{"text":"{\\"text\\":1},\\"text\\"","note":"a,\\\\","other":"}"}')).toBeNull();
  });

  it('compares decoded keys, so an escaped spelling of the same key is still a duplicate', () => {
    expect(duplicateJsonKey('{"number":"1","\\u006eumber":"2"}')).toBe('number');
  });
});
