interface Waiter {
  weight: number;
  resolve: (release: () => void) => void;
}

/** FIFO weighted semaphore. Oversized payloads acquire the entire budget and therefore run alone. */
export class ByteBudget {
  private used = 0;
  private readonly queue: Waiter[] = [];

  constructor(readonly capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity <= 0) {
      throw new Error("Byte budget capacity must be a positive safe integer.");
    }
  }

  async acquire(requestedBytes: number): Promise<() => void> {
    if (!Number.isFinite(requestedBytes) || requestedBytes < 0) {
      throw new Error("Requested byte budget must be a non-negative finite number.");
    }
    const weight = Math.max(1, Math.min(this.capacity, Math.ceil(requestedBytes)));
    if (this.queue.length === 0 && this.used + weight <= this.capacity) {
      return this.grant(weight);
    }
    return await new Promise<() => void>((resolve) => {
      this.queue.push({ weight, resolve });
      this.drain();
    });
  }

  private grant(weight: number): () => void {
    this.used += weight;
    let released = false;
    return () => {
      if (released) throw new Error("Byte budget lease released twice.");
      released = true;
      this.used -= weight;
      if (this.used < 0) throw new Error("Byte budget accounting underflow.");
      this.drain();
    };
  }

  private drain(): void {
    while (this.queue.length > 0) {
      const next = this.queue[0];
      if (!next || this.used + next.weight > this.capacity) return;
      this.queue.shift();
      next.resolve(this.grant(next.weight));
    }
  }
}
