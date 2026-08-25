import type { XiaomiAuth, XiaomiRegion } from './types';

export type QrSession = {
  status: 'waiting' | 'success' | 'error';
  qrUrl: string;
  loginUrl: string;
  pollUrl: string;
  ua: string;
  deviceId: string;
  pass_o: string;
  region: XiaomiRegion;
  completion?: Promise<void>;
  auth?: XiaomiAuth;
  error?: string;
  createdAt: number;
};

declare global {
  var __miLockQrSessions: Map<string, QrSession> | undefined;
}

export const qrSessions = globalThis.__miLockQrSessions ?? new Map<string, QrSession>();
globalThis.__miLockQrSessions = qrSessions;

export function cleanupQrSessions() {
  const cutoff = Date.now() - 10 * 60 * 1000;
  for (const [id, session] of qrSessions) if (session.createdAt < cutoff) qrSessions.delete(id);
}
