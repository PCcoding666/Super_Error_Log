import { describe, expect, it } from 'vitest';
import { PermitPool } from '../../src/studentHost/permits.js';

describe('parent permit pool', () => {
  it('grants in arrival order and only up to the limit', () => {
    const pool = new PermitPool(1);
    const order: string[] = [];
    pool.acquire('a', '1', () => order.push('a'));
    pool.acquire('b', '1', () => order.push('b'));
    expect(order).toEqual(['a']);
    expect(pool.inUse).toBe(1);
    expect(pool.waiting).toBe(1);
    pool.release('a', '1');
    expect(order).toEqual(['a', 'b']);
    expect(pool.waiting).toBe(0);
    pool.dropOwner('b');
    expect(pool.inUse).toBe(0);
  });

  it('returns a departed owner’s permit to the next waiter', () => {
    const pool = new PermitPool(1);
    const order: string[] = [];
    pool.acquire('a', '1', () => order.push('a'));
    pool.acquire('b', '1', () => order.push('b'));
    pool.dropOwner('a');
    expect(order).toEqual(['a', 'b']);
    expect(pool.inUse).toBe(1);
  });
});
