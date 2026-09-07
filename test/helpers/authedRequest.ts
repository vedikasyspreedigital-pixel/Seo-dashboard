import request from "supertest";
import type { Express } from "express";

// Thin wrapper around supertest's request(app) that pre-attaches a session
// cookie -- used by test files that only need to get PAST requireAuth (they
// aren't testing workspace-ownership, just the existing run/report business
// logic that requireAuth now gates). Returns full supertest Test objects
// (via .set(), which returns `this`), so every existing .send()/.query()/
// etc chained call downstream keeps working exactly as before.
export function authedRequest(app: Express, cookieHeader: string) {
  return {
    get: (url: string) => request(app).get(url).set("Cookie", cookieHeader),
    post: (url: string) => request(app).post(url).set("Cookie", cookieHeader),
    patch: (url: string) => request(app).patch(url).set("Cookie", cookieHeader),
    put: (url: string) => request(app).put(url).set("Cookie", cookieHeader),
    delete: (url: string) => request(app).delete(url).set("Cookie", cookieHeader),
  };
}
