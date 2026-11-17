/**
 * Robot noises synthesised with Web Audio, after the spec's `noises` block:
 * one oscillator per note, shaped by the noise's synth settings. No files.
 */
import type { Noises } from '../types.ts';

interface Synth {
  wave: OscillatorType;
  ms: number;
  sweep?: number;
  vibratoHz?: number;
  octave?: number;
  rough?: number;
  gain: number;
}

/** Output level per waveform: square and sawtooth are much louder than sine at equal gain. */
const WAVE_GAIN: Record<string, number> = { sine: 0.32, triangle: 0.32, square: 0.08, sawtooth: 0.1 };

/** Pitches and synth settings, set from the archetype's `noises` block in the world's catalog. */
let PITCH_HZ: Record<string, number> = {};
let SYNTH: Record<string, Synth> = {};

const GAP_S = 0.05;

export class NoisePlayer {
  /** Load the archetype's noises (pitches, and a `synth` per noise). Recorded sounds are skipped. */
  static configure(noises: Noises | null | undefined) {
    PITCH_HZ = { ...(noises?.pitches ?? {}) };
    SYNTH = {};
    for (const [name, def] of Object.entries(noises?.set ?? {})) {
      if ('synth' in def) SYNTH[name] = { ...def.synth, gain: WAVE_GAIN[def.synth.wave] ?? 0.2 } as Synth;
    }
  }

  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  enabled = false;

  /** Must be called from a user gesture: browsers block autoplay. */
  async enable(): Promise<boolean> {
    if (!this.ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return false;
      this.ctx = new Ctor();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.8;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    this.enabled = true;
    return true;
  }

  disable() {
    this.enabled = false;
  }

  /** Total chain length in seconds, used to time the drawn sound arcs. */
  static duration(notes: string[]): number {
    return notes.reduce((t, n) => t + (SYNTH[n.split('-')[0]!]?.ms ?? 150) / 1000 + GAP_S, 0);
  }

  /** pan -1..1 from direction, gain 0..1 from distance. */
  play(notes: string[], pan = 0, gain = 1) {
    if (!this.enabled || !this.ctx || !this.master) return;
    const ctx = this.ctx;
    const out = ctx.createStereoPanner();
    out.pan.value = Math.max(-1, Math.min(1, pan));
    const vol = ctx.createGain();
    vol.gain.value = Math.max(0.05, Math.min(1, gain));
    out.connect(vol).connect(this.master);
    let t = ctx.currentTime + 0.02;
    for (const note of notes) {
      const [noise, pitch] = note.split('-');
      const syn = SYNTH[noise ?? ''];
      const hz = PITCH_HZ[pitch ?? ''];
      if (!syn || !hz) continue;
      const dur = syn.ms / 1000;
      const f = hz * Math.pow(2, syn.octave ?? 0);
      const osc = ctx.createOscillator();
      osc.type = syn.wave;
      osc.frequency.setValueAtTime(f, t);
      if (syn.sweep) osc.frequency.exponentialRampToValueAtTime(f * syn.sweep, t + dur);
      const env = ctx.createGain();
      env.gain.setValueAtTime(0.0001, t);
      env.gain.exponentialRampToValueAtTime(syn.gain, t + 0.012);
      env.gain.setValueAtTime(syn.gain, t + dur * 0.7);
      env.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const nodes: AudioScheduledSourceNode[] = [osc];
      if (syn.vibratoHz) {
        const lfo = ctx.createOscillator();
        lfo.frequency.value = syn.vibratoHz;
        const depth = ctx.createGain();
        depth.gain.value = f * 0.035;
        lfo.connect(depth).connect(osc.frequency);
        nodes.push(lfo);
      }
      let tail: AudioNode = env;
      if (syn.rough) {
        // Roughness: fast amplitude modulation for a gritty buzz.
        const am = ctx.createGain();
        am.gain.value = 1 - syn.rough / 2;
        const lfo = ctx.createOscillator();
        lfo.type = 'square';
        lfo.frequency.value = 37;
        const depth = ctx.createGain();
        depth.gain.value = syn.rough / 2;
        lfo.connect(depth).connect(am.gain);
        env.connect(am);
        tail = am;
        nodes.push(lfo);
      }
      osc.connect(env);
      tail.connect(out);
      for (const n of nodes) {
        n.start(t);
        n.stop(t + dur + 0.02);
      }
      t += dur + GAP_S;
    }
  }
}
