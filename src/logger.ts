import fs from "node:fs";
import path from "node:path";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR" | "ACTION";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  ACTION: 1,
  WARN: 2,
  ERROR: 3,
};

export interface LogContext {
  agent_id?: string;
  pid?: number;
  tool?: string;
  model?: string;
  [key: string]: string | number | boolean | undefined;
}

export class Logger {
  private logFile: string;
  private maxBytes: number;
  private jsonMode: boolean;
  private minLevel: number;

  constructor(logDir: string, maxBytes: number, jsonMode = false, minLevelStr = "info") {
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    this.logFile = path.join(logDir, "council_log.txt");
    this.maxBytes = maxBytes;
    this.jsonMode = jsonMode;
    this.minLevel = LEVEL_PRIORITY[minLevelStr.toUpperCase() as LogLevel] ?? 1;
  }

  info(msg: string, ctx?: LogContext) { this.write("INFO", msg, ctx); }
  warn(msg: string, ctx?: LogContext) { this.write("WARN", msg, ctx); }
  error(msg: string, ctx?: LogContext) { this.write("ERROR", msg, ctx); }
  action(msg: string, ctx?: LogContext) { this.write("ACTION", msg, ctx); }
  debug(msg: string, ctx?: LogContext) { this.write("DEBUG", msg, ctx); }

  private write(level: LogLevel, msg: string, ctx?: LogContext) {
    const priority = LEVEL_PRIORITY[level] ?? 1;
    if (priority < this.minLevel) return;

    let line: string;

    if (this.jsonMode) {
      const entry: Record<string, unknown> = {
        ts: new Date().toISOString(),
        level,
        msg,
      };
      // Agent-Kontext als separate Felder
      if (ctx) {
        for (const [k, v] of Object.entries(ctx)) {
          if (v !== undefined) entry[k] = v;
        }
      }
      line = JSON.stringify(entry) + "\n";
    } else {
      const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
      const ctxStr = ctx?.agent_id ? ` [${ctx.agent_id}]` : "";
      line = `[${ts}] [${level}]${ctxStr} ${msg}\n`;
    }

    try {
      this.rotate();
      fs.appendFileSync(this.logFile, line, "utf-8");
    } catch (e) {
      process.stderr.write(`Logger error: ${e}\n`);
    }
  }

  private rotate() {
    try {
      if (!fs.existsSync(this.logFile)) return;
      const stat = fs.statSync(this.logFile);
      if (stat.size < this.maxBytes) return;

      const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const archive = this.logFile.replace(".txt", `_${ts}.txt`);
      fs.renameSync(this.logFile, archive);
    } catch {
      // Rotation fehlgeschlagen — weiter loggen
    }
  }
}
