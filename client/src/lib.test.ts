import { describe, test, expect, vi, afterEach } from 'vitest';
import { playerName, playerTeamClass, copyText } from './lib';
import { makeState } from './test-fixtures';

describe('playerName', () => {
  const state = makeState();
  test('returns the name for a known id', () => {
    expect(playerName(state, 'p2')).toBe('Bob');
  });
  test('falls back to "someone" for an unknown id', () => {
    expect(playerName(state, 'ghost')).toBe('someone');
  });
  test('returns "" for null state or id', () => {
    expect(playerName(null, 'p1')).toBe('');
    expect(playerName(state, null)).toBe('');
  });
});

describe('playerTeamClass', () => {
  const state = makeState();
  test('maps team A -> team-blue, team B -> team-red', () => {
    expect(playerTeamClass(state, 'p1')).toBe('team-blue');
    expect(playerTeamClass(state, 'p2')).toBe('team-red');
  });
  test('undefined for unknown/null', () => {
    expect(playerTeamClass(state, 'ghost')).toBeUndefined();
    expect(playerTeamClass(null, 'p1')).toBeUndefined();
  });
});

describe('copyText', () => {
  afterEach(() => vi.restoreAllMocks());

  test('uses the async clipboard API when available', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const ok = await copyText('hello');
    expect(ok).toBe(true);
    expect(writeText).toHaveBeenCalledWith('hello');
    vi.unstubAllGlobals();
  });

  test('falls back to execCommand when clipboard API throws (LAN http)', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn().mockRejectedValue(new Error('not secure context')),
      },
    });
    const exec = vi.fn().mockReturnValue(true);
    // jsdom lacks execCommand; provide it
    (document as unknown as { execCommand: unknown }).execCommand = exec;
    const ok = await copyText('hello');
    expect(ok).toBe(true);
    expect(exec).toHaveBeenCalledWith('copy');
    vi.unstubAllGlobals();
  });
});
