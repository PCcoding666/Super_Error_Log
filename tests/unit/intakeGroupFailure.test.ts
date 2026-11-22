import { describe, expect, it } from 'vitest';
import { failedGroupPhotos } from '../../client/src/lib/intakeVerdict.js';

describe('grouped intake failures', () => {
  it('keeps a failed photo that a question card replaced', () => {
    const photos = [
      { id: 'paper', failure: { detail: '原图已保留，可以重新整理。', retryable: true } },
      { id: 'sheet', failure: null },
      { id: 'other', failure: { detail: '看不清或格式不对，请重拍这张。', retryable: false } },
    ];
    expect(failedGroupPhotos(['paper', 'sheet'], photos).map(photo => photo.id)).toEqual(['paper']);
    expect(failedGroupPhotos(['sheet'], photos)).toEqual([]);
  });
});
