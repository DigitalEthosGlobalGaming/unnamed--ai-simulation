/**
 * Timeline scrubber styled as the sheet's scale bar. A real range input,
 * play/pause button, speed select and "Go live" button.
 */
import type { ViewerStore } from '../client/store.ts';
import { clockOf, dayStartTick, fmtTick, ticksPerDay } from './format.ts';
import { icons } from './icons.ts';

export class Timeline {
  el: HTMLElement;
  private input: HTMLInputElement;
  private playBtn: HTMLButtonElement;
  private liveBtn: HTMLButtonElement;
  private readout: HTMLElement;
  private labels: HTMLElement;
  private markers: HTMLElement;
  private speed: HTMLSelectElement;
  private dragging = false;
  private lastLabelsKey = '';
  private lastMarkKey = '';

  constructor(private store: ViewerStore) {
    const el = document.createElement('div');
    el.className = 'timeline';
    el.setAttribute('role', 'group');
    el.setAttribute('aria-label', 'Timeline');
    el.innerHTML = `
      <button type="button" class="btn icon-only play" aria-label="Pause">${icons.pause()}</button>
      <div class="scale">
        <div class="scale-bar" aria-hidden="true"></div>
        <div class="scale-markers" role="group" aria-label="Belief revisions"></div>
        <input type="range" class="scale-input" min="0" max="1" step="10" value="1" aria-label="Scrub the timeline" />
        <div class="scale-labels" aria-hidden="true"></div>
      </div>
      <output class="readout" aria-live="off"></output>
      <label class="speed"><span class="speed-label">Replay speed</span>
        <select>
          <option value="1">1×</option>
          <option value="10">10×</option>
          <option value="60">60×</option>
        </select>
      </label>
      <button type="button" class="btn go-live">${icons.live()}<span>Go live</span></button>`;
    this.el = el;
    this.input = el.querySelector('.scale-input')!;
    this.playBtn = el.querySelector('.play')!;
    this.liveBtn = el.querySelector('.go-live')!;
    this.readout = el.querySelector('.readout')!;
    this.labels = el.querySelector('.scale-labels')!;
    this.markers = el.querySelector('.scale-markers')!;
    this.speed = el.querySelector('select')!;

    this.input.addEventListener('input', () => {
      this.dragging = true;
      const t = Number(this.input.value);
      store.seek(t);
      // Scrubbing onto a belief marker picks its revision row (and scrolls the feed to it).
      const span = Math.max(1, store.conn.range().to - store.conn.range().from);
      const near = store.beliefMarks(store.selectedId).find((e) => Math.abs(e.tick - t) < span * 0.006 + 20);
      if (near && store.highlight !== `${near.tick}:${near.characterId}`) store.setHighlight(`${near.tick}:${near.characterId}`, true);
    });
    this.markers.addEventListener('click', (e) => {
      const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tick]');
      if (!b) return;
      const tick = Number(b.dataset['tick']);
      store.seek(tick + 2);
      store.setHighlight(`${tick}:${b.dataset['id']}`, true);
    });
    this.input.addEventListener('change', () => (this.dragging = false));
    this.input.addEventListener('pointerup', () => (this.dragging = false));
    this.playBtn.addEventListener('click', () => store.togglePlay());
    this.liveBtn.addEventListener('click', () => store.goLive());
    this.speed.addEventListener('change', () => store.setSpeed(Number(this.speed.value)));
  }

  update() {
    const s = this.store;
    const w = s.world;
    const disabled = !w || s.status !== 'live';
    this.input.disabled = disabled;
    this.playBtn.disabled = disabled;
    if (!w) return;
    const { from, to } = s.conn.range();
    const tick = s.tick;
    this.input.min = String(from);
    this.input.max = String(to);
    if (!this.dragging) this.input.value = String(tick);
    const ck = clockOf(tick, w.clock);
    this.input.setAttribute('aria-valuetext', `Day ${ck.day}, ${ck.time}, tick ${fmtTick(tick)}${s.mode === 'live' ? ', live' : ''}`);
    const replay = s.mode === 'replay';
    this.el.classList.toggle('is-replay', replay);
    this.liveBtn.hidden = !replay;
    this.speed.parentElement!.hidden = !replay;
    const playing = s.mode === 'live' || s.playing;
    this.playBtn.innerHTML = playing ? icons.pause() : icons.play();
    this.playBtn.setAttribute('aria-label', s.mode === 'live' ? 'Pause and inspect this moment' : s.playing ? 'Pause replay' : 'Play replay');
    this.readout.innerHTML = `<span class="ro-main">D${ck.day} ${ck.time}</span><span class="ro-sub">${replay ? '<span class="ro-rev">Revision · </span>' : ''}tick ${fmtTick(tick)}</span>`;

    // Scale bar: alternating blocks of six in-world hours, labelled per day.
    const span = Math.max(1, to - from);
    // Six-hour blocks aligned to in-world midnight (the world may start mid-day).
    const tpd = ticksPerDay(w.clock);
    const seg = (tpd / 4 / span) * 100;
    const bar = this.el.querySelector<HTMLElement>('.scale-bar')!;
    bar.style.setProperty('--seg', `${seg}%`);
    const firstDay = clockOf(from, w.clock).day;
    const offset = ((((from - dayStartTick(firstDay, w.clock)) % (tpd / 4)) + tpd / 4) % (tpd / 4)) / span * 100;
    bar.style.backgroundPosition = `${(-offset / 100) * bar.clientWidth}px 0`;
    const days = clockOf(to, w.clock).day;
    const lk = `${days}:${span}`;
    if (lk !== this.lastLabelsKey) {
      this.lastLabelsKey = lk;
      let html = '';
      for (let d = firstDay; d <= days; d++) {
        const at = Math.max(0, (dayStartTick(d, w.clock) - from) / span);
        if (at > 0.97 || (d > firstDay && at < 0.04)) continue;
        html += `<span style="left:${(at * 100).toFixed(2)}%">Day ${d}</span>`;
      }
      html += `<span class="now" style="left:100%">Now</span>`;
      this.labels.innerHTML = html;
    }
    // Belief markers: where a mind changed. Each is a button tied to its revision row.
    const sel = s.selectedId;
    const marks = s.beliefMarks(sel);
    const mk = `${sel}:${marks.length}:${span}:${s.highlight}`;
    if (mk !== this.lastMarkKey) {
      this.lastMarkKey = mk;
      this.markers.innerHTML = marks
        .map((e) => {
          const k = `${e.tick}:${e.characterId}`;
          const ck = clockOf(e.tick, w.clock);
          const row = s.feed.find((f) => f.tick === e.tick && f.characterId === e.characterId);
          const label = `${row ? `Revision ${s.rev(row)}: ` : ''}${s.nameOf(e.characterId)}'s beliefs changed, day ${ck.day} ${ck.time}`;
          return `<button type="button" class="marker${s.highlight === k ? ' is-lit' : ''}" style="left:${(((e.tick - from) / span) * 100).toFixed(2)}%" data-tick="${e.tick}" data-id="${e.characterId}" aria-label="${label}" title="${label}"></button>`;
        })
        .join('');
    }
  }
}
