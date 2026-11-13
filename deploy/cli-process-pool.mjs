export class CliProcessPool {
  #controllers = new Set();
  constructor(limit = 4) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 16) throw new Error('CLI concurrency must be between 1 and 16');
    this.limit = limit;
  }
  get active() { return this.#controllers.size; }
  acquire() {
    if (this.active >= this.limit) return;
    const controller = new AbortController();
    this.#controllers.add(controller);
    return { controller, release: () => this.#controllers.delete(controller) };
  }
  abortAll() { for (const controller of this.#controllers) controller.abort(); }
}
