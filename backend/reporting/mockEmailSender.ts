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
  return async function mockSendEmail(params) {
    onSend?.(params);
    return { messageId: `mock-${randomUUID()}` };
  };
}

/** A mock that always fails, for testing send-failure handling. */
export function createFailingMockEmailSender(errorMessage = "Email provider unavailable"): SendEmailFn {
  return async function failingMockSendEmail() {
    throw new Error(errorMessage);
  };
}
