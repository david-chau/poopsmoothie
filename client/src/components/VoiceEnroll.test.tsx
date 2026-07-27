import { test, expect, vi, beforeEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockEmitAck } = vi.hoisted(() => ({ mockEmitAck: vi.fn() }));
vi.mock('../socket', () => ({ emitAck: mockEmitAck }));

import VoiceEnroll from './VoiceEnroll';

let instances: { port: { onmessage: ((e: MessageEvent) => void) | null } }[];
let mockGetUserMedia: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockEmitAck.mockResolvedValue({ ok: true });
  instances = [];
  mockGetUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] });
  Object.defineProperty(navigator, 'mediaDevices', { value: { getUserMedia: mockGetUserMedia }, configurable: true });

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
    close = vi.fn();
    createMediaStreamSource() {
      return { connect: vi.fn(), disconnect: vi.fn() };
    }
  }
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

test('shows "not set up" and a record button when the player has no voiceprint yet', () => {
  render(<VoiceEnroll enrolled={false} />);
  expect(screen.getByText('🎙️ Voice ID not set up')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Record 5s sample' })).toBeInTheDocument();
});

test('shows "ready" and a re-record option once enrolled', () => {
  render(<VoiceEnroll enrolled={true} />);
  expect(screen.getByText('🎙️ Voice ID ready')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Re-record' })).toBeInTheDocument();
});

// A real (short) recordSeconds keeps these fast without fighting fake timers
// against getUserMedia's real Promise chain — see the component's own comment.
const FAST_SECONDS = 0.03;

test('recording sends the captured audio and reports success', async () => {
  const user = userEvent.setup();
  render(<VoiceEnroll enrolled={false} recordSeconds={FAST_SECONDS} />);

  await user.click(screen.getByRole('button', { name: /Record .*sample/ }));
  expect(mockGetUserMedia).toHaveBeenCalledWith(
    expect.objectContaining({ audio: expect.objectContaining({ echoCancellation: true, autoGainControl: false }) }),
  );

  await act(async () => {
    instances[0]?.port.onmessage?.({ data: new ArrayBuffer(8) } as MessageEvent);
  });

  expect(await screen.findByText('🎙️ Voice ID ready', {}, { timeout: 2000 })).toBeInTheDocument();
  expect(mockEmitAck).toHaveBeenCalledWith('enroll-voice', expect.any(ArrayBuffer));
  expect(screen.getByRole('button', { name: 'Re-record' })).toBeInTheDocument();
});

test('a rejected mic permission surfaces an error without crashing', async () => {
  mockGetUserMedia.mockRejectedValue(new Error('Permission denied'));
  const user = userEvent.setup();
  render(<VoiceEnroll enrolled={false} recordSeconds={FAST_SECONDS} />);

  await user.click(screen.getByRole('button', { name: /Record .*sample/ }));
  expect(await screen.findByText(/Permission denied/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Record .*sample/ })).not.toBeDisabled();
});

test('a server-side enrollment failure is surfaced and does not claim success', async () => {
  mockEmitAck.mockResolvedValue({ ok: false, error: 'could not process recording' });
  const user = userEvent.setup();
  render(<VoiceEnroll enrolled={false} recordSeconds={FAST_SECONDS} />);

  await user.click(screen.getByRole('button', { name: /Record .*sample/ }));
  expect(await screen.findByText('could not process recording', {}, { timeout: 2000 })).toBeInTheDocument();
  expect(screen.getByText('🎙️ Voice ID not set up')).toBeInTheDocument();
});
