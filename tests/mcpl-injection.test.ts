/**
 * Tests for maybeInjectMcpl() — BUG 9 _mcpl chain context injection.
 *
 * Pure function tests: no delegate process, no mocks needed.
 */

import { describe, it, expect } from 'vitest';
import { maybeInjectMcpl } from '../src/index.js';

describe('maybeInjectMcpl', () => {
  const ctx = { chainId: 'chain-1', frameId: 'frame-1' };
  const baseInput: Record<string, unknown> = { query: 'hello', count: 5 };

  it('injects _mcpl when inferenceContext present and acceptsMcplContext=true', () => {
    const result = maybeInjectMcpl(baseInput, ctx, undefined, true);
    expect(result._mcpl).toEqual({ v: 1, chainId: 'chain-1', frameId: 'frame-1' });
    expect(result.query).toBe('hello');
    expect(result.count).toBe(5);
  });

  it('includes v: 1 version field', () => {
    const result = maybeInjectMcpl(baseInput, ctx, undefined, true);
    expect((result._mcpl as any).v).toBe(1);
  });

  it('does NOT inject when acceptsMcplContext=false', () => {
    const result = maybeInjectMcpl(baseInput, ctx, undefined, false);
    expect(result._mcpl).toBeUndefined();
    expect(result).toBe(baseInput); // same reference — no copy
  });

  it('does NOT inject when inferenceContext and mcplState are both undefined', () => {
    const result = maybeInjectMcpl(baseInput, undefined, undefined, true);
    expect(result._mcpl).toBeUndefined();
    expect(result).toBe(baseInput);
  });

  it('overwrites pre-existing _mcpl in tool input (reserved field)', () => {
    const inputWithFake: Record<string, unknown> = {
      ...baseInput,
      _mcpl: { v: 0, chainId: 'fake', frameId: 'fake' },
    };
    const result = maybeInjectMcpl(inputWithFake, ctx, undefined, true);
    expect((result._mcpl as any).chainId).toBe('chain-1');
    expect((result._mcpl as any).frameId).toBe('frame-1');
    expect((result._mcpl as any).v).toBe(1);
  });

  it('returns same reference when no injection needed (zero allocation)', () => {
    expect(maybeInjectMcpl(baseInput, undefined, undefined, true)).toBe(baseInput);
    expect(maybeInjectMcpl(baseInput, ctx, undefined, false)).toBe(baseInput);
    expect(maybeInjectMcpl(baseInput, undefined, undefined, false)).toBe(baseInput);
  });
});
