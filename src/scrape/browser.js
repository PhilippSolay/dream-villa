// Playwright, and only behind PLAYWRIGHT=1 (CLAUDE.md). Playwright is NOT a
// package.json dependency: an adapter that needs a browser says so with
// `needsBrowser: true` and logs "skipped: needs PLAYWRIGHT=1" when the flag is off,
// so a plain `npm ci` install runs the whole scrape without it.

/** Same UA as src/scrape/fetch.js, so a site sees one visitor, not two. */
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';

const NAV_TIMEOUT_MS = 45_000;
const WAIT_TIMEOUT_MS = 15_000;
const BLOCKED_TYPES = new Set(['image', 'font', 'media']);

let browserPromise = null; // one chromium per process, reused across calls

export function playwrightEnabled() {
  return process.env.PLAYWRIGHT === '1';
}

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    throw new Error('playwright not installed — npm i playwright && npx playwright install chromium');
  }
}

/** Launch once, reuse. */
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await loadPlaywright();
      return chromium.launch({ headless: true });
    })().catch((err) => {
      browserPromise = null; // a failed launch must not poison every later call
      throw err;
    });
  }
  return browserPromise;
}

/**
 * Rendered HTML of `url`.
 * @param {string} url
 * @param {{waitFor?:string, timeoutMs?:number}} [opts] `waitFor` is a CSS selector;
 *   without it the page settles on networkidle.
 * @returns {Promise<{html:string|null, status:number}>}
 */
export async function getBrowserHtml(url, { waitFor = null, timeoutMs = NAV_TIMEOUT_MS } = {}) {
  if (!playwrightEnabled()) throw new Error('PLAYWRIGHT=1 is not set');

  const browser = await getBrowser();
  const context = await browser.newContext({ userAgent: UA, locale: 'en-US' });
  // Images and fonts are downloaded by src/scrape/images.js later, from their own
  // URLs — pulling them here would double every listing's traffic.
  await context.route('**/*', (route) =>
    BLOCKED_TYPES.has(route.request().resourceType()) ? route.abort() : route.continue()
  );

  const page = await context.newPage();
  try {
    const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    const status = res ? res.status() : 0;
    if (status === 404 || status === 410) return { html: null, status };

    if (waitFor) {
      await page.waitForSelector(waitFor, { timeout: WAIT_TIMEOUT_MS }).catch(() => {});
    } else {
      await page.waitForLoadState('networkidle', { timeout: WAIT_TIMEOUT_MS }).catch(() => {});
    }
    return { html: await page.content(), status: status || 200 };
  } finally {
    await context.close().catch(() => {});
  }
}

/** Close the shared browser (end of a scrape run, or a test). Safe to call twice. */
export async function closeBrowser() {
  if (!browserPromise) return;
  const p = browserPromise;
  browserPromise = null;
  try {
    const browser = await p;
    await browser.close();
  } catch {
    /* nothing to close */
  }
}

export default { getBrowserHtml, closeBrowser, playwrightEnabled };
