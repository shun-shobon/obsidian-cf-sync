export class SyncScheduler {
  private timer: number | undefined;
  private retryDelay = 1000;

  constructor(private readonly run: () => void) {}

  schedule(delay = 250): void {
    this.cancel();
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      this.run();
    }, delay);
  }

  retry(): void {
    this.schedule(this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 60_000);
  }

  succeeded(): void {
    this.retryDelay = 1000;
  }

  cancel(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
