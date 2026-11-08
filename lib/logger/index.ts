// lib/logger/index.ts
// Structured JSON logger for production

type LogLevel = "debug" | "info" | "warn" | "error";
type LogMeta = Record<string, unknown>;

interface LoggerConfig {
  level?: LogLevel;
  pretty?: boolean;
  serviceName?: string;
}

interface LogEntry extends LogMeta {
  level: LogLevel;
  message: string;
}

class Logger {
  constructor(config: LoggerConfig = {}) {
    this.level = config.level || (process.env.NODE_ENV === "production" ? "info" : "debug");
    this.pretty = config.pretty ?? (process.env.NODE_ENV !== "production");
    this.serviceName = config.serviceName || (process.env.NEXT_PUBLIC_SERVICE_NAME || "omniflow");
  }

  level: LogLevel = "info";
  pretty = false;
  serviceName = "omniflow";

  shouldLog(level: LogLevel): boolean {
    const levels = ["debug", "info", "warn", "error"];
    const currentLevel = levels.indexOf(this.level);
    const logLevel = levels.indexOf(level);
    return logLevel >= currentLevel;
  }

  format(entry: LogEntry): string {
    const base = {
      timestamp: new Date().toISOString(),
      level: entry.level,
      service: this.serviceName,
      message: entry.message,
    };

    if (this.pretty) {
      return JSON.stringify(base, null, 2);
    }

    return JSON.stringify(base);
  }

  debug(message: string, meta: LogMeta = {}): void {
    if (!this.shouldLog("debug")) return;
    console.log(this.format({ ...meta, level: "debug", message }));
  }

  info(message: string, meta: LogMeta = {}): void {
    if (!this.shouldLog("info")) return;
    console.log(this.format({ ...meta, level: "info", message }));
  }

  warn(message: string, meta: LogMeta = {}): void {
    if (!this.shouldLog("warn")) return;
    console.warn(this.format({ ...meta, level: "warn", message }));
  }

  error(message: string, error: unknown = null, meta: LogMeta = {}): void {
    if (!this.shouldLog("error")) return;

    const errorDetails = error instanceof Error
      ? { stack: error.stack, name: error.name }
      : error == null
      ? {}
      : { error: String(error) };
    const entry: LogEntry = {
      ...meta,
      level: "error",
      message,
      ...errorDetails,
    };

    console.error(this.format(entry));
  }

  request(method: string, path: string, durationMs: number, status: number, meta: LogMeta = {}): void {
    this.info("request completed", {
      method,
      path,
      status_code: status,
      duration_ms: durationMs,
      ...meta,
    });
  }

  rateLimit(clientId: string, limitType: string, retryAfter: number): void {
    this.warn("rate limit exceeded", {
      client_id: clientId,
      limit_type: limitType,
      retry_after_seconds: retryAfter,
    });
  }

  dbQuery(
    operation: string,
    tableName: string,
    durationMs: number,
    success: boolean,
    meta: LogMeta = {}
  ): void {
    if (success) {
      this.debug("db query success", { operation, table: tableName, duration_ms: durationMs, ...meta });
    } else {
      this.error("db query failed", undefined, { operation, table: tableName, duration_ms: durationMs, ...meta });
    }
  }
}

// Singleton instance
let loggerInstance: Logger | null = null;

export function getLogger(config: LoggerConfig = {}): Logger {
  if (!loggerInstance) {
    loggerInstance = new Logger(config);
  }
  return loggerInstance;
}

export const log = getLogger();

export default log;
