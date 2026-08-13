/**
 * Live pipeline progress - the wave structure, drawn as it executes.
 *
 * `runPipeline` already emits stage-start / stage-ok / stage-fail / loop, so this is
 * purely a renderer: it holds no state the engine does not already own, and if it
 * throws, the pipeline is unaffected.
 *
 * Why a tree rather than a log: a pipeline is waves of parallel stages, and a
 * scrolling log flattens exactly the structure you need to see. The tree shows which
 * stages are running together, which wave you are in, and where a loop went back to.
 *
 * Degrades to one line per event when stdout is not a TTY, so CI output stays useful.
 */
import { c, strip, tree, progressBar, spinner, badge } from './ui.mjs';

export class PipelineProgress {
  /**
   * @param {{name?:string, stages:Array<{name:string,depends_on?:string[]}>}} pipeline
   * @param {Array<string[]>} waves - from computeWaves()
   */
  constructor(pipeline, waves, { stream = process.stderr } = {}) {
    this.pipeline = pipeline;
    this.waves = waves;
    this.stream = stream;
    this.animated = !!stream.isTTY && !process.env.NO_COLOR;
    this.status = new Map(pipeline.stages.map(s => [s.name, 'pending']));
    this.detail = new Map();
    this.loops = [];
    this.lines = 0;
    this.done = 0;
    this.total = pipeline.stages.length;
    this.started = Date.now();
    this.timer = null;
  }

  /** Wave index a stage belongs to, for grouping. */
  #waveOf(name) {
    return this.waves.findIndex(wave => wave.includes(name));
  }

  #nodes() {
    return this.waves.map((wave, index) => {
      const states = wave.map(n => this.status.get(n));
      const waveStatus = states.some(s => s === 'fail') ? 'fail'
        : states.every(s => s === 'ok') ? 'ok'
        : states.some(s => s === 'running') ? 'running' : 'pending';
      return {
        label: `${c.dim}wave ${index + 1}${c.reset}`,
        status: waveStatus,
        children: wave.map(name => ({
          label: `${name}${this.detail.get(name) ? ` ${c.dim}${this.detail.get(name)}${c.reset}` : ''}`,
          status: this.status.get(name),
        })),
      };
    });
  }

  #frame() {
    const elapsed = ((Date.now() - this.started) / 1000).toFixed(1);
    const head = `${badge(this.pipeline.name || 'pipeline', 'blue')} ${progressBar(this.done, this.total)} ${c.dim}${elapsed}s${c.reset}`;
    const body = tree(this.#nodes());
    const loops = this.loops.length
      ? `\n${c.yellow}loops${c.reset} ${this.loops.map(l => `${l.from}${c.dim}->${c.reset}${l.to}`).join(', ')}`
      : '';
    return `${head}\n${body}${loops}`;
  }

  #paint() {
    if (!this.animated) return;
    if (this.lines) this.stream.write(`\x1b[${this.lines}A\x1b[J`);
    const frame = this.#frame();
    this.stream.write(`${frame}\n`);
    this.lines = strip(frame).split('\n').length;
  }

  start() {
    this.#paint();
    if (!this.animated) return;
    // Repaint on a timer so the elapsed clock and spinner advance between events.
    this.timer = setInterval(() => this.#paint(), 200);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.#paint();
  }

  /** Feed this straight into runPipeline's onEvent. */
  handle(event) {
    switch (event.type) {
      case 'stage-start':
        this.status.set(event.stage, 'running');
        this.detail.set(event.stage, event.agent ? `${c.dim}${event.agent}${c.reset}` : '');
        break;
      case 'stage-ok':
        this.status.set(event.stage, 'ok');
        this.done = Math.min(this.total, this.done + 1);
        break;
      case 'stage-fail':
        this.status.set(event.stage, 'fail');
        this.done = Math.min(this.total, this.done + 1);
        if (event.error) this.detail.set(event.stage, `${c.red}${String(event.error).slice(0, 60)}${c.reset}`);
        break;
      case 'loop':
        this.loops.push({ from: event.from, to: event.to });
        // A loop re-runs work, so the stage goes back to pending rather than
        // staying green - otherwise the display claims progress that was undone.
        if (event.to && this.status.has(event.to)) {
          this.status.set(event.to, 'pending');
          this.done = Math.max(0, this.done - 1);
        }
        break;
      default:
        break;
    }
    if (this.animated) this.#paint();
    else this.stream.write(`  ${c.dim}${event.type}${c.reset} ${event.stage || `${event.from}->${event.to}`}\n`);
  }

  summary() {
    const counts = { ok: 0, fail: 0, pending: 0, running: 0 };
    for (const state of this.status.values()) counts[state] = (counts[state] || 0) + 1;
    const elapsed = ((Date.now() - this.started) / 1000).toFixed(1);
    const parts = [
      `${counts.ok} ok`,
      counts.fail ? `${c.red}${counts.fail} failed${c.reset}` : null,
      counts.pending ? `${c.dim}${counts.pending} not reached${c.reset}` : null,
      this.loops.length ? `${c.yellow}${this.loops.length} loop(s)${c.reset}` : null,
      `${elapsed}s`,
    ].filter(Boolean);
    return parts.join(`${c.gray} · ${c.reset}`);
  }
}
