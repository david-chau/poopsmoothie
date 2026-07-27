import { test, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

const { mockEmitAck, mockVolatileEmit } = vi.hoisted(() => ({
  mockEmitAck: vi.fn(),
  mockVolatileEmit: vi.fn(),
}));
vi.mock('./socket', () => ({
  emitAck: mockEmitAck,
  socket: { volatile: { emit: mockVolatileEmit } },
}));

import { useOpenMic } from './useOpenMic';

const MIC_PREF_KEY = 'poopsmoothie-mic-on';

/** One shared instance per test — the hook constructs these itself, so tests
 *  reach in via `instances.at(-1)` to drive the worklet's message port and
 *  assert on connect/disconnect calls. */
let instances: { port: { onmessage: ((e: MessageEvent) => void) | null }; connect: ReturnType<typeof vi.fn>; disconnect: ReturnType<typeof vi.fn> }[];
let mockGetUserMedia: ReturnType<typeof vi.fn>;
let mockTrackStop: ReturnType<typeof vi.fn>;
let mockCtxClose: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  instances = [];
  mockTrackStop = vi.fn();
  mockCtxClose = vi.fn();
  mockGetUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: mockTrackStop }] });

  Object.defineProperty(navigator, 'mediaDevices', {
    value: { getUserMedia: mockGetUserMedia },
    configurable: true,
  });

  class FakeAudioWorkletNode {
    port = { onmessage: null as ((e: MessageEvent) => void) | null };
    connect = vi.fn();
    disconnect = vi.fn();
    constructor() {
      instances.push(this);
    }
  }
  class FakeAudioContext {
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) };
    close = mockCtxClose;
    createMediaStreamSource() {
      return { connect: vi.fn(), disconnect: vi.fn() };
    }
  }
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

test('start() requests the mic, wires the worklet, and tells the server', async () => {
  const { result } = renderHook(() => useOpenMic());
  expect(result.current.on).toBe(false);

  await act(async () => {
    await result.current.start();
  });

  expect(mockGetUserMedia).toHaveBeenCalledWith(
    expect.objectContaining({ audio: expect.objectContaining({ echoCancellation: true, autoGainControl: false }) }),
  );
  expect(result.current.on).toBe(true);
  expect(mockEmitAck).toHaveBeenCalledWith('mic-on');
  expect(localStorage.getItem(MIC_PREF_KEY)).toBe('1');
});

test('a rejected mic permission surfaces an error and never reports "on"', async () => {
  mockGetUserMedia.mockRejectedValue(new Error('Permission denied'));
  const { result } = renderHook(() => useOpenMic());

  await act(async () => {
    await result.current.start();
  });

  expect(result.current.on).toBe(false);
  expect(result.current.error).toMatch(/Permission denied/);
  expect(mockEmitAck).not.toHaveBeenCalledWith('mic-on');
});

test('a frame from the worklet is streamed to the server as a volatile emit', async () => {
  const { result } = renderHook(() => useOpenMic());
  await act(async () => {
    await result.current.start();
  });

  const node = instances.at(-1)!;
  const samples = new Int16Array([100, -100, 200]);
  act(() => {
    node.port.onmessage?.({ data: samples.buffer } as MessageEvent);
  });

  expect(mockVolatileEmit).toHaveBeenCalledWith('audio-frame', samples.buffer);
  await waitFor(() => expect(result.current.level).toBeGreaterThan(0));
});

test('stop() tears down the stream/context and tells the server', async () => {
  const { result } = renderHook(() => useOpenMic());
  await act(async () => {
    await result.current.start();
  });

  act(() => {
    result.current.stop();
  });

  expect(result.current.on).toBe(false);
  expect(mockTrackStop).toHaveBeenCalled();
  expect(mockCtxClose).toHaveBeenCalled();
  expect(mockEmitAck).toHaveBeenCalledWith('mic-off');
  expect(localStorage.getItem(MIC_PREF_KEY)).toBe('0');
});

test('a remembered "on" preference resumes capture automatically on mount', async () => {
  localStorage.setItem(MIC_PREF_KEY, '1');
  renderHook(() => useOpenMic());

  await waitFor(() => expect(mockGetUserMedia).toHaveBeenCalled());
});

test('no remembered preference means capture stays off until asked', () => {
  const { result } = renderHook(() => useOpenMic());
  expect(result.current.on).toBe(false);
  expect(mockGetUserMedia).not.toHaveBeenCalled();
});
