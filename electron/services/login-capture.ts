/** Coalesce site login events while validating credentials. Failed cookie-only attempts
 * must not discard a bearer token that arrives during that validation. */
export class BrowserCredentialCapture {
  private active: Promise<void> | undefined;
  private latestToken = '';
  private stopped = false;
  constructor(private readonly accept: (accessToken: string) => Promise<void>) {}

  capture(accessToken = ''): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (accessToken) this.latestToken = accessToken;
    if (!this.active) {
      const job = this.drain();
      this.active = job;
      void job.finally(() => { if (this.active === job) this.active = undefined; });
    }
    return this.active;
  }

  stop() { this.stopped = true; }

  private async drain(): Promise<void> {
    let attempted: string;
    do {
      attempted = this.latestToken;
      try {
        await this.accept(attempted);
        this.stopped = true;
        return;
      } catch {
        // Anonymous requests and incomplete 2FA are not completed login sessions.
        // Retry only if a different, nonempty bearer token arrived while waiting.
      }
    } while (!this.stopped && !!this.latestToken && this.latestToken !== attempted);
  }
}
