/** Tiny synthesized sound kit (Web Audio) — no audio files to download. */
let ctx: AudioContext | null = null;
let enabled = true;

export function setSoundEnabled(on: boolean) {
  enabled = on;
}

function audio(): AudioContext | null {
  if (!enabled || typeof window === 'undefined') return null;
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null;
  }
}

function tone(freq: number, start: number, duration: number, type: OscillatorType = 'sine', gain = 0.12) {
  const ac = audio();
  if (!ac) return;
  const osc = ac.createOscillator();
  const amp = ac.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t = ac.currentTime + start;
  amp.gain.setValueAtTime(0, t);
  amp.gain.linearRampToValueAtTime(gain, t + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, t + duration);
  osc.connect(amp).connect(ac.destination);
  osc.start(t);
  osc.stop(t + duration + 0.02);
}

/** Band-passed noise: the squeak of a marker on a whiteboard. */
function scratch(start: number, duration: number, freq: number, gain = 0.09) {
  const ac = audio();
  if (!ac) return;
  const frames = Math.floor(ac.sampleRate * duration);
  const buffer = ac.createBuffer(1, frames, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames) ** 0.5;
  const src = ac.createBufferSource();
  src.buffer = buffer;
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = 1.4;
  const amp = ac.createGain();
  amp.gain.value = gain;
  src.connect(filter).connect(amp).connect(ac.destination);
  src.start(ac.currentTime + start);
}

export const sound = {
  key: () => scratch(0, 0.05, 2600, 0.05),
  erase: () => scratch(0, 0.09, 900, 0.05),
  lock: () => {
    scratch(0, 0.22, 2200, 0.1); // the underline stroke
    tone(659, 0.16, 0.18, 'triangle');
    tone(988, 0.26, 0.3, 'triangle');
  },
  error: () => {
    tone(196, 0, 0.16, 'sawtooth', 0.06);
    tone(165, 0.1, 0.22, 'sawtooth', 0.06);
  },
  hint: () => tone(1175, 0, 0.25, 'sine', 0.08),
  partner: () => tone(784, 0, 0.14, 'sine', 0.07),
  wipe: () => scratch(0, 0.45, 600, 0.08),
  win: () => [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, i * 0.11, 0.45, 'triangle', 0.11)),
};
