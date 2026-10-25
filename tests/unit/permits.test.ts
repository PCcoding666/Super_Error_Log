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

  it('background work waits behind every foreground request and never takes the last free permit', () => {
    const pool = new PermitPool(3);
    const order: string[] = [];
    pool.acquire('a', 'bg1', () => order.push('a-bg1'), true);
    pool.acquire('b', 'bg1', () => order.push('b-bg1'), true);
    pool.acquire('c', 'bg1', () => order.push('c-bg1'), true);
    // Only limit - 1 background permits: one stays free for a foreground arrival.
    expect(order).toEqual(['a-bg1', 'b-bg1']);
    expect(pool.waiting).toBe(0);
    pool.acquire('d', 'fg1', () => order.push('d-fg1'));
    expect(order).toEqual(['a-bg1', 'b-bg1', 'd-fg1']);
    pool.acquire('e', 'fg1', () => order.push('e-fg1'));
    expect(pool.waiting).toBe(1);
    // A released permit goes to the waiting foreground request before the queued background one.
    pool.release('a', 'bg1');
    expect(order.at(-1)).toBe('e-fg1');
    pool.release('d', 'fg1');
    pool.release('e', 'fg1');
    expect(order.at(-1)).toBe('c-bg1');
    pool.dropOwner('c');
    expect(pool.inUse).toBe(1);
  });

  it('a single permit can still serve background work when nobody else waits', () => {
    const pool = new PermitPool(1);
    const order: string[] = [];
    pool.acquire('a', 'bg', () => order.push('a-bg'), true);
    expect(order).toEqual(['a-bg']);
    pool.acquire('b', 'fg', () => order.push('b-fg'));
    pool.acquire('c', 'bg', () => order.push('c-bg'), true);
    pool.release('a', 'bg');
    expect(order).toEqual(['a-bg', 'b-fg']);
    pool.release('b', 'fg');
    expect(order).toEqual(['a-bg', 'b-fg', 'c-bg']);
  });

  it('asks a background holder to yield once when foreground work is waiting and no permit is free', () => {
    const pool = new PermitPool(1);
    const order: string[] = [];
    let preempted = 0;
    pool.acquire('a', 'bg', () => order.push('a-bg'), true, () => { preempted += 1; });
    pool.acquire('b', 'fg', () => order.push('b-fg'));
    pool.acquire('c', 'fg', () => order.push('c-fg'));
    expect(preempted).toBe(1);
    expect(order).toEqual(['a-bg']);
    // The worker aborts its call and returns the permit; the foreground request gets it.
    pool.release('a', 'bg');
    expect(order).toEqual(['a-bg', 'b-fg']);
    pool.release('b', 'fg');
    pool.release('c', 'fg');
    // Foreground work never preempts foreground work.
    pool.acquire('d', 'fg', () => order.push('d-fg'));
    pool.acquire('e', 'fg', () => order.push('e-fg'));
    expect(preempted).toBe(1);
  });
});
