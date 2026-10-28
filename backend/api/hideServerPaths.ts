import path from "node:path";
import type { RequestHandler } from "express";

// Where files live on the server (e.g. /app/reports/<id>.pdf) never goes to the browser (audit 2026-10-27):
// these fields keep only the file NAME -- the pages only check that a PDF exists -- and stored extra PDFs
// lose their `path`. One filter on every JSON response, so a new route can't leak them either.
const PATH_FIELDS = new Set(["clientPdfPath", "customPdfPath", "sourceFilePath", "resultFilePath"]);

export function hideServerPaths(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hideServerPaths);
  if (!value || typeof value !== "object" || value instanceof Date || Buffer.isBuffer(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    if (PATH_FIELDS.has(key) && typeof v === "string") out[key] = path.basename(v);
    else if (key === "extraAttachments" && Array.isArray(v)) out[key] = v.map((a) => (a && typeof a === "object" ? omitPath(a as Record<string, unknown>) : a));
    else out[key] = hideServerPaths(v);
  }
  return out;
}

function omitPath({ path: _path, ...rest }: Record<string, unknown>) {
  return rest;
}

export const hideServerPathsInResponses: RequestHandler = (_req, res, next) => {
  const send = res.json.bind(res);
  res.json = (body?: unknown) => send(hideServerPaths(body));
  next();
};
