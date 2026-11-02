// lib/logger/index.ts
// Structured JSON logger for production

class Logger {
  constructor(config = {}) {
    this.level = config.level || (process.env.NODE_ENV === "production" ? "info" : "debug");
    this.pretty = config.pretty ?? (process.env.NODE_ENV !== "production");
    this.serviceName = config.serviceName || (process.env.NEXT_PUBLIC_SERVICE_NAME || "omniflow");
  }

  level = "info";
  pretty = false;
  serviceName = "omniflow";

  shouldLog(level) {
    const levels = ["debug", "info", "warn", "error"];
    const currentLevel = levels.indexOf(this.level);
    const logLevel = levels.indexOf(level);
    return logLevel >= currentLevel;
  }

  format(entry) {
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

  debug(message, meta = {}) {
    if (!this.shouldLog("debug")) return;
    console.log(this.format({ ...meta, level: "debug", message }));
  }

  info(message, meta = {}) {
    if (!this.shouldLog("info")) return;
    console.log(this.format({ ...meta, level: "info", message }));
  }

  warn(message, meta = {}) {
    if (!this.shouldLog("warn")) return;
    console.warn(this.format({ ...meta, level: "warn", message }));
  }

  error(message, error = null, meta = {}) {
    if (!this.shouldLog("error")) return;

    const entry = {
      ...meta,
      level: "error",
      message,
      stack: error?.stack,
      name: error?.name,
    };

    console.error(this.format(entry));
  }

  request(method, path, durationMs, status, meta = {}) {
    this.info("request completed", {
      method,
      path,
      status_code: status,
      duration_ms: durationMs,
      ...meta,
    });
  }

  rateLimit(clientId, limitType, retryAfter) {
    this.warn("rate limit exceeded", {
      client_id: clientId,
      limit_type: limitType,
      retry_after_seconds: retryAfter,
    });
  }

  dbQuery(operation, tableName, durationMs, success, meta = {}) {
    if (success) {
      this.debug("db query success", { operation, table: tableName, duration_ms: durationMs, ...meta });
    } else {
      this.error("db query failed", undefined, { operation, table: tableName, duration_ms: durationMs, ...meta });
    }
  }
}

// Singleton instance
let loggerInstance = null;

export function getLogger(config = {}) {
  if (!loggerInstance) {
    loggerInstance = new Logger(config);
  }
  return loggerInstance;
}

export const log = getLogger();

export default log;
