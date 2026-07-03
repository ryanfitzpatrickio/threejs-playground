export class RenderRateLimiter {
  constructor(hz = 60) {
    this.intervalMs = 1000 / hz;
    this.nextFrameAt = 0;
  }

  reset() {
    this.nextFrameAt = 0;
  }

  shouldRun(timeMs) {
    if (this.nextFrameAt && timeMs < this.nextFrameAt) return false;
    if (!this.nextFrameAt || timeMs - this.nextFrameAt > this.intervalMs) {
      this.nextFrameAt = timeMs;
    }
    this.nextFrameAt += this.intervalMs;
    return true;
  }
}
