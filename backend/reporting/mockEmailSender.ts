import { randomUUID } from "node:crypto";
import type { SendEmailFn } from "./emailSender.js";

/**
 * Deterministic-shape mock -- never makes a network call, never actually
 * delivers anything. Used by tests and by server.ts by default, since no
 * real provider is configured yet. Accepts an optional `onSend` hook so
 * tests can assert on exactly what was "sent" (recipients, subject, body)
 * without needing a real provider.
 */
export function createMockEmailSender(onSend?: (params: Parameters<SendEmailFn>[0]) => void): SendEmailFn {
  return markMock<SendEmailFn>(async function mockSendEmail(params) {
    onSend?.(params);
    return { messageId: `mock-${randomUUID()}` };
  });
}

/**
 * Mock senders/posters carry this mark so the app can SAY it's in test mode (banner, "mock" labels) --
 * a mock "send" otherwise looks exactly like real delivery (audit 2026-10-27).
 */
export function markMock<F extends (...args: never[]) => unknown>(fn: F): F {
  return Object.assign(fn, { isMock: true });
}

export const isMock = (fn: unknown): boolean => typeof fn === "function" && (fn as { isMock?: boolean }).isMock === true;

/** A mock that always fails, for testing send-failure handling. */
export function createFailingMockEmailSender(errorMessage = "Email provider unavailable"): SendEmailFn {
  return async function failingMockSendEmail() {
    throw new Error(errorMessage);
  };
}
