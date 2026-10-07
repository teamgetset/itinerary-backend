import { chromium, type Browser } from "playwright-core";
import { env } from "../../config/env.ts";
import { AppError } from "../../lib/errors.ts";
import { log } from "../../lib/logger.ts";

/*
 * Prints HTML to PDF with headless Chrome. One browser is shared and closed after a minute idle.
 * ponytail: one render at a time per API process (keeps memory flat); add a worker queue if PDF volume grows.
 */

let browser: Promise<Browser> | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let queue: Promise<unknown> = Promise.resolve();

function getBrowser() {
  browser ??= chromium
    .launch(env.PDF_BROWSER_PATH ? { executablePath: env.PDF_BROWSER_PATH } : { channel: env.PDF_BROWSER_CHANNEL })
    .catch((error) => {
      browser = null;
      log.error("pdf.browser_unavailable", { error });
      throw new AppError(500, "PDF_ERROR", "PDF printing is unavailable: Chrome could not be started on the server.");
    });
  return browser;
}

function closeWhenIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    const open = browser;
    browser = null;
    await (await open?.catch(() => null))?.close();
  }, 60_000);
  idleTimer.unref();
}

/** Shrinks embedded photos to what the printed size needs (about 240 dpi), so PDFs stay small. */
const DOWNSCALE_PHOTOS = `(async () => {
  const photos = [...document.images].filter((img) => img.src.startsWith("data:image/") && !img.src.startsWith("data:image/png"));
  await Promise.all(photos.map((img) => img.decode().catch(() => {})));
  for (const img of photos) {
    const box = img.getBoundingClientRect();
    if (!box.width || !img.naturalWidth) continue;
    const factor = Math.min(1, Math.max((box.width * 2.5) / img.naturalWidth, (box.height * 2.5) / img.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(img.naturalWidth * factor);
    canvas.height = Math.round(img.naturalHeight * factor);
    canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
    img.src = canvas.toDataURL("image/jpeg", 0.82);
    await img.decode().catch(() => {});
  }
})()`;

export function renderPdf(html: string, footer: string): Promise<Buffer> {
  const job = queue.then(async () => {
    const instance = await getBrowser();
    // A4 at 96 dpi, so on-screen sizes match the printed page when photos are downscaled.
    const page = await instance.newPage({ viewport: { width: 794, height: 1123 } });
    try {
      // Everything is inline (fonts, images), so "load" means ready.
      await page.setContent(html, { waitUntil: "load", timeout: 30_000 });
      await page.evaluate(DOWNSCALE_PHOTOS);
      await page.evaluate("document.fonts.ready");
      return await page.pdf({
        format: "A4",
        printBackground: true,
        preferCSSPageSize: true,
        displayHeaderFooter: true,
        headerTemplate: "<span></span>",
        footerTemplate: footer,
      });
    } catch (error) {
      if (error instanceof AppError) throw error;
      log.error("pdf.render_failed", { error });
      throw new AppError(500, "PDF_ERROR", "The PDF could not be generated. Please try again.");
    } finally {
      await page.close().catch(() => {});
      closeWhenIdle();
    }
  });
  queue = job.catch(() => undefined);
  return job;
}
