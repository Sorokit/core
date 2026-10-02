export type LogLevel = 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

export interface LogConfig {
    enabled: boolean;
    level: LogLevel;
    redactSensitive: boolean;
    logger?: (level: LogLevel, msg: string, meta: any) => void;
}

const levelWeights: Record<LogLevel, number> = {
    TRACE: 10,
    DEBUG: 20,
    INFO: 30,
    WARN: 40,
    ERROR: 50,
};

export class StructuredLogger {
    constructor(private config: LogConfig) {}

    private shouldLog(level: LogLevel): boolean {
        if (!this.config.enabled) return false;
        return levelWeights[level] >= levelWeights[this.config.level];
    }

    private redact(meta: any): any {
        if (!this.config.redactSensitive || !meta) return meta;
        const redacted = { ...meta };
        const sensitiveKeys = ['secret', 'seed', 'key', 'token', 'authorization'];
        for (const k of Object.keys(redacted)) {
            if (sensitiveKeys.some(sk => k.toLowerCase().includes(sk))) {
                redacted[k] = '[REDACTED]';
            } else if (typeof redacted[k] === 'object') {
                redacted[k] = this.redact(redacted[k]);
            }
        }
        return redacted;
    }

    log(level: LogLevel, operation: string, durationMs?: number, meta?: any) {
        if (!this.shouldLog(level)) return;
        
        const timestamp = new Date().toISOString();
        const safeMeta = this.redact(meta);
        const payload = { timestamp, level, operation, durationMs, ...safeMeta };

        if (this.config.logger) {
            this.config.logger(level, operation, payload);
        } else {
            const msg = JSON.stringify(payload);
            switch (level) {
                case 'ERROR': console.error(msg); break;
                case 'WARN': console.warn(msg); break;
                case 'INFO': console.info(msg); break;
                case 'DEBUG': console.debug(msg); break;
                case 'TRACE': console.trace(msg); break;
            }
        }
    }

    trace(op: string, meta?: any) { this.log('TRACE', op, undefined, meta); }
    debug(op: string, meta?: any) { this.log('DEBUG', op, undefined, meta); }
    info(op: string, meta?: any) { this.log('INFO', op, undefined, meta); }
    warn(op: string, meta?: any) { this.log('WARN', op, undefined, meta); }
    error(op: string, meta?: any) { this.log('ERROR', op, undefined, meta); }
}
