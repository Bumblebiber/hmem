export interface LogContext {
    agent_id?: string;
    pid?: number;
    tool?: string;
    model?: string;
    [key: string]: string | number | boolean | undefined;
}
export declare class Logger {
    private logFile;
    private maxBytes;
    private jsonMode;
    private minLevel;
    constructor(logDir: string, maxBytes: number, jsonMode?: boolean, minLevelStr?: string);
    info(msg: string, ctx?: LogContext): void;
    warn(msg: string, ctx?: LogContext): void;
    error(msg: string, ctx?: LogContext): void;
    action(msg: string, ctx?: LogContext): void;
    debug(msg: string, ctx?: LogContext): void;
    private write;
    private rotate;
}
