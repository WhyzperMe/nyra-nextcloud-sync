import { redact } from "../security/redaction";

export interface Logger {
  debug(event: string, context?: unknown): void;
  info(event: string, context?: unknown): void;
  warn(event: string, context?: unknown): void;
  error(event: string, context?: unknown): void;
}

export class ConsoleLogger implements Logger {
  constructor(private readonly prefix = "nyra-nextcloud-sync") {}

  debug(event: string, context?: unknown): void {
    this.write("debug", event, context);
  }

  info(event: string, context?: unknown): void {
    this.write("info", event, context);
  }

  warn(event: string, context?: unknown): void {
    this.write("warn", event, context);
  }

  error(event: string, context?: unknown): void {
    this.write("error", event, context);
  }

  private write(level: "debug" | "info" | "warn" | "error", event: string, context?: unknown): void {
    const payload = context === undefined ? undefined : redact(context);
    const line = `[${this.prefix}] ${event}`;
    if (payload === undefined) {
      console[level](line);
      return;
    }
    console[level](line, payload);
  }
}
