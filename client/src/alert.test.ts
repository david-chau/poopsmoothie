import { test, expect, vi, beforeEach, afterEach } from 'vitest';
import { tick, timeUp, primeAudio, isMuted, setMuted } from './alert';

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  // jsdom has no AudioContext at all — the module must cope with that alone
  delete (window as { AudioContext?: unknown }).AudioContext;
  delete (window as { webkitAudioContext?: unknown }).webkitAudioContext;
});

afterEach(() => {
  delete (navigator as { vibrate?: unknown }).vibrate;
});

test('never throws when the browser has no Web Audio at all', () => {
  expect(() => primeAudio()).not.toThrow();
  expect(() => tick()).not.toThrow();
  expect(() => timeUp()).not.toThrow();
});

test('never throws when the AudioContext constructor itself blows up', () => {
  (window as { AudioContext?: unknown }).AudioContext = function () {
    throw new Error('blocked by autoplay policy');
  };
  expect(() => tick()).not.toThrow();
  expect(() => timeUp()).not.toThrow();
});

test('vibrates on a device that supports it, distinctly for time-up', () => {
  const vibrate = vi.fn();
  (navigator as { vibrate?: unknown }).vibrate = vibrate;

  // the soft 10-second warning is audio only — buzzing every second for ten
  // seconds is not a warning, it's an annoyance
  tick();
  expect(vibrate).not.toHaveBeenCalled();

  tick(true);
  expect(vibrate).toHaveBeenCalledWith(30);

  timeUp();
  expect(vibrate).toHaveBeenLastCalledWith([120, 60, 200]);
});

test('a device without vibration support is simply skipped', () => {
  expect('vibrate' in navigator).toBe(false);
  expect(() => timeUp()).not.toThrow();
});

test('muting silences vibration too, not just sound', () => {
  const vibrate = vi.fn();
  (navigator as { vibrate?: unknown }).vibrate = vibrate;

  setMuted(true);
  tick(true);
  timeUp();
  expect(vibrate).not.toHaveBeenCalled();

  setMuted(false);
  tick(true);
  expect(vibrate).toHaveBeenCalled();
});

test('the mute preference survives a reload', () => {
  setMuted(true);
  expect(isMuted()).toBe(true);
  expect(localStorage.getItem('poopsmoothie-muted')).toBe('1');
  setMuted(false);
  expect(isMuted()).toBe(false);
});

test('unavailable localStorage falls back to audible rather than throwing', () => {
  const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('storage disabled');
  });
  const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('storage disabled');
  });
  expect(isMuted()).toBe(false);
  expect(() => setMuted(true)).not.toThrow();
  expect(() => timeUp()).not.toThrow();
  getItem.mockRestore();
  setItem.mockRestore();
});
