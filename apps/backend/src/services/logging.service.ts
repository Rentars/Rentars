import { supabase } from '@/config/supabase.js';

export interface BlockchainOperationLog {
  operation: string;
  userId?: string;
  bookingId?: string;
  propertyId?: string;
  txHash?: string;
  escrowId?: string;
  error?: string;
  [key: string]: unknown;
}

class LoggingService {
  async logBlockchainOperation(
    operation: string,
    input: Record<string, unknown>,
    result?: Record<string, unknown>,
    error?: string,
  ): Promise<void> {
    try {
      const { error: dbError } = await supabase
        .from('blockchain_logs')
        .insert({
          operation,
          input_json: input,
          result_json: result || null,
          error_message: error || null,
        });

      if (dbError) {
        console.error(`Failed to log blockchain operation ${operation}:`, dbError);
      }
    } catch (err) {
      console.error(`Error logging blockchain operation ${operation}:`, err);
    }

    const { error: errorMsg, ...rest } = { error, ...input };
    if (error) {
      console.error(`[Blockchain:${operation}] ERROR:`, errorMsg, rest);
    } else {
      console.log(`[Blockchain:${operation}]`, JSON.stringify(rest));
    }
  }
}

export const loggingService = new LoggingService();

// ─── Security event logger ────────────────────────────────────────────────────

type SecurityEvent =
  | 'login_success'
  | 'login_failure'
  | 'logout'
  | 'register_success'
  | 'token_revoked'
  | 'unauthorized_access'
  | 'rate_limit_exceeded';

class SecurityLogger {
  async logAuthEvent(
    event: SecurityEvent,
    userId?: string,
    meta?: Record<string, unknown>,
  ): Promise<void> {
    const entry = {
      event,
      userId,
      timestamp: new Date().toISOString(),
      ...meta,
    };

    // Console output always
    if (event === 'login_failure' || event === 'unauthorized_access') {
      console.warn(`[Security:${event}]`, JSON.stringify(entry));
    } else {
      console.log(`[Security:${event}]`, JSON.stringify(entry));
    }

    // Persist to Supabase (best-effort)
    try {
      await supabase.from('security_logs').insert({
        event,
        user_id: userId || null,
        meta_json: meta || null,
      });
    } catch {
      // non-fatal — DB table may not exist yet
    }
  }
}

export const securityLogger = new SecurityLogger();
