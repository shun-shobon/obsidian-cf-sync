export class SyncScheduler {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryDelay = 1000;

  constructor(private readonly run: () => void) {}

  schedule(delay = 250): void {
    this.cancel();
    this.timer = setTimeout(() => {
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
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
