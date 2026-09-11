import rateLimit from "express-rate-limit";

// Two different limiters for two different threats -- not a blanket global
// limiter, per the security review's scoped recommendation (no rate
// limiting existed anywhere in this app before).

// Login: brute-force protection. Keyed by IP (express-rate-limit's default
// keyGenerator), tight enough to make password-guessing impractical without
// meaningfully affecting a real user who mistypes their password a few times.
export const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Please try again later." },
});

// Run-start / approve-and-send: cost/spam protection, not brute force --
// each call triggers real DataForSEO API spend or a real Playwright/ClickUp
// send. Generous enough for legitimate rapid use (retrying a few runs/sends
// back to back) while still bounding a runaway script or malicious client.
export const expensiveActionRateLimit = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Please slow down and try again shortly." },
});
