import { createCanvas } from "@napi-rs/canvas";
// Legacy Node build -- the default pdfjs-dist entry point assumes a browser
// (DOM/Worker) environment. Deliberately NOT using Playwright/Chromium for
// this despite it already being a proven dependency in this stack: headless
// Chromium's built-in PDF viewer is unreliable to drive programmatically
// (it can trigger a download instead of inline rendering) and would need a
// scroll/paginate dance for multi-page files. pdfjs-dist + @napi-rs/canvas
// renders directly to a raster buffer with no browser involved, and
// @napi-rs/canvas ships prebuilt native binaries (no system Cairo/Pango
// packages to add to Nixpacks, unlike node-canvas -- avoids repeating the
// exact "missing system library on Railway" problem from the Chromium OOM
// investigation).
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

// 4x, not just a mild upscale -- empirically verified against the real
// sample report this feature was built against: at 2x, tesseract's OCR
// confidence was ~68% and it failed to reliably read the header row's date
// labels at all; at 4x with PSM 6 (see ocrExtractTable.ts), confidence rose
// to ~77% and the header parsed correctly. This is a manual, infrequent
// operation (client onboarding), not a hot path, so the extra render/OCR
// time is worth the accuracy.
const RENDER_SCALE = 4.0;

/** Renders every page of a PDF to a PNG buffer, in page order. */
export async function renderPdfPageImages(pdfBuffer: Buffer): Promise<Buffer[]> {
  const loadingTask = pdfjsLib.getDocument({ data: new Uint8Array(pdfBuffer) });
  const pdf = await loadingTask.promise;

  const images: Buffer[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: RENDER_SCALE });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const context = canvas.getContext("2d");
    // This pdfjs-dist version requires `canvas` (not just `canvasContext`,
    // now backwards-compat-only) -- @napi-rs/canvas's Canvas/context objects
    // are API-compatible with the browser DOM surface pdfjs-dist's renderer
    // expects; the casts are needed only because the two packages ship
    // their own, structurally-identical type declarations.
    await page.render({ canvas: canvas as never, canvasContext: context as never, viewport }).promise;
    images.push(canvas.toBuffer("image/png"));
    page.cleanup();
  }

  return images;
}
