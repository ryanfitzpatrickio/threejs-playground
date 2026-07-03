export class FrameLoop {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.rafId = 0;
    this.running = false;
    this.tick = this.tick.bind(this);
  }

  start() {
    if (this.running) {
      return;
    }

    this.running = true;
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop() {
    this.running = false;

    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  tick(timeMs) {
    if (!this.running) {
      return;
    }

    this.onFrame(timeMs);
    this.rafId = requestAnimationFrame(this.tick);
  }
}
