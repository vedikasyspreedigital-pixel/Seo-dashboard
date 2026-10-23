import { Router, type NextFunction, type Request, type Response } from "express";
import multer from "multer";
import { timingSafeEqual } from "node:crypto";
import { AgentTaskGone, claimNext, completeTask, failTask, reportProgress } from "../../domainIntel/agentQueue.js";

// The office Chrome agent's API (extension/ in this repo). NOT for people:
// there is no session cookie here -- every call carries the shared secret
// DOMAIN_INTEL_AGENT_TOKEN as "Authorization: Bearer <token>". Without that
// env var the whole router answers 404, so the feature is off by default.
// The extension only ever receives a tool name, a domain and a country --
// never client data, credentials or anything from the database.

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

function sameSecret(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createAgentRouter(getToken: () => string | undefined = () => process.env.DOMAIN_INTEL_AGENT_TOKEN) {
  const router = Router();

  router.use((req: Request, res: Response, next: NextFunction) => {
    const token = getToken();
    if (!token) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const given = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!given || !sameSecret(given, token)) {
      res.status(401).json({ error: "Wrong or missing agent token." });
      return;
    }
    next();
  });

  const gone = (res: Response, err: unknown) => {
    if (err instanceof AgentTaskGone) {
      res.status(410).json({ error: err.message });
      return true;
    }
    return false;
  };

  // Polled every ~30s. 204 = nothing to do (also marks the agent online).
  router.get("/tasks/next", (req, res) => {
    const version = typeof req.query.version === "string" ? req.query.version.slice(0, 20) : null;
    const task = claimNext(version);
    if (!task) {
      res.sendStatus(204);
      return;
    }
    res.json({ id: task.id, tool: task.tool, domain: task.domain, location: task.location });
  });

  router.post("/tasks/:id/progress", (req, res) => {
    const step = typeof req.body?.step === "string" ? req.body.step.slice(0, 200) : "";
    try {
      reportProgress(req.params.id as string, step, req.body?.needsHuman === true);
      res.json({ ok: true });
    } catch (err) {
      if (!gone(res, err)) throw err;
    }
  });

  router.post("/tasks/:id/result", upload.single("file"), (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: "Attach the exported file as \"file\"." });
      return;
    }
    try {
      completeTask(req.params.id as string, { buffer: req.file.buffer, fileName: req.file.originalname.slice(0, 200) });
      res.json({ ok: true });
    } catch (err) {
      if (!gone(res, err)) throw err;
    }
  });

  router.post("/tasks/:id/fail", (req, res) => {
    const code = typeof req.body?.code === "string" ? req.body.code : "FAILED";
    const message = typeof req.body?.message === "string" ? req.body.message : "";
    try {
      failTask(req.params.id as string, code, message);
      res.json({ ok: true });
    } catch (err) {
      if (!gone(res, err)) throw err;
    }
  });

  return router;
}
