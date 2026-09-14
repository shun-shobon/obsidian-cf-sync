export class SyncScheduler {
  private timer: number | undefined;
  private retryDelay = 1000;
  private due = Infinity;

  constructor(private readonly run: () => void) {}

  schedule(delay = 50): void {
    const due = Date.now() + delay;
    if (this.timer !== undefined && this.due <= due) {
      return;
    }
    this.cancel();
    this.due = due;
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.due = Infinity;
      this.run();
    }, delay);
  }

  retry(): void {
    this.cancel();
    this.schedule(this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 60_000);
  }

  succeeded(): void {
    this.retryDelay = 1000;
  }

  cancel(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    this.due = Infinity;
  }
}
