#!/usr/bin/env node
const http = require('http');
const puppeteer = require('puppeteer-core');

const BOT_NAME = process.env.BOT_NAME || 'TestBot';
const MEET_RELOAD_TIMEOUT_MS = Number(process.env.MEET_RELOAD_TIMEOUT_MS || 3 * 60 * 1000);
const MEET_RELOAD_WAIT_MS    = Number(process.env.MEET_RELOAD_WAIT_MS || 4000);

/* ---------------- WS resolver ---------------- */
async function resolveWsFromHttp(port = 9222) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version' }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', c => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.webSocketDebuggerUrl) return resolve(j.webSocketDebuggerUrl);
          reject(new Error('webSocketDebuggerUrl missing'));
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
  });
}

/* ---------------- tiny helpers ---------------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function clickTextSmart(pageOrFrame, text, { exact = false, timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const clicked = await pageOrFrame.evaluate((needle, exact) => {
        const norm = s => (s || '').replace(/\s+/g, ' ').trim();
        const visible = el => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && cs.pointerEvents !== 'none' && !el.disabled && el.getAttribute('aria-disabled') !== 'true';
        };
        for (const el of document.querySelectorAll('button, [role="button"], span, div')) {
          const txt = norm(el.innerText || el.textContent || '');
          const match = exact ? (txt === needle) : txt.toLowerCase().includes(needle.toLowerCase());
          if (match && visible(el)) {
            el.click();
            return true;
          }
        }
        return false;
      }, text, exact);
      if (clicked) return;
    } catch (err) {
      // Suppress errors
    }
    await sleep(250);
  }
  throw new Error(`Clickable element with text "${text}" not found`);
}

async function typeNameInAnyFrame(page, selectors, text, timeout = 15000) {
  const sels = Array.isArray(selectors) ? selectors : [selectors];
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const fr of page.frames()) {
      for (const sel of sels) {
        try {
            const el = await fr.$(sel);
            if (!el) continue;
            await fr.waitForSelector(sel, { visible: true, timeout: 1000 });
            await el.focus();
            const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
            await page.keyboard.down(mod); await page.keyboard.press('KeyA'); await page.keyboard.up(mod);
            await page.keyboard.press('Backspace');
            await page.keyboard.type(text, { delay: 35 });
            await page.keyboard.press('Tab');
            return true;
        } catch {}
      }
    }
    await sleep(250);
  }
  throw new Error(`Name field not found via ${selectors.join(', ')}`);
}

// Detect cant join screen
async function meetBlocked(page) {
  try {
    return await page.evaluate(() => {
        const bodyText = document.body?.innerText || '';
        return /you can.?t join this video call/i.test(bodyText);
    });
  } catch {
    return false;
  }
}

// Dismisses pop-ups like cookie banners
async function dismissPopups(page, timeout = 10000) {
    console.log('[ATTACH] Checking for initial pop-ups...');
    const popups = ['Accept all', 'Allow all', 'I agree', 'Got it', 'Dismiss'];
    for (const text of popups) {
        try {
            await clickTextSmart(page, text, { timeout: 1500 });
            console.log(`[ATTACH] Clicked pop-up button: "${text}"`);
            await sleep(1000); // Wait for animation
        } catch {}
    }
    console.log('[ATTACH] Finished checking for pop-ups.');
}


/* ---------------- Attach & dispatch ---------------- */
(async () => {
  try {
    const port = process.env.REMOTE_PORT || 9222;
    const wsEndpoint = process.env.WS_URL || (await resolveWsFromHttp(port));
    console.log('[ATTACH] Using WS endpoint:', wsEndpoint);

    const browser = await puppeteer.connect({
      browserWSEndpoint: wsEndpoint,
      defaultViewport: null,
    });
    console.log('[ATTACH] Connected to browser.');

    function pickMeetingPage(pages) {
        const withUrl = pages.filter(p => p.url());
        const meetingPages = withUrl.filter(p => /zoom\.us|meet\.google\.com|teams\.microsoft\.com|teams\.live\.com/i.test(p.url()));
        return meetingPages[meetingPages.length - 1] || withUrl[withUrl.length - 1] || pages[0];
    }

    async function getAllPages(browser) {
        const pages = await browser.pages();
        return pages.filter(p => typeof p.url === 'function');
    }

    async function attachPageTracker(browser) {
        let current = pickMeetingPage(await getAllPages(browser));
        browser.on('targetcreated', async (t) => {
            if (t.type() !== 'page') return;
            await sleep(500);
            current = pickMeetingPage(await getAllPages(browser));
        });
        browser.on('targetchanged', async () => {
            current = pickMeetingPage(await getAllPages(browser));
        });
        browser.on('targetdestroyed', async () => {
            current = pickMeetingPage(await getAllPages(browser));
        });
        return {
            get page() { return current; },
            async bringToFront() { try { await current.bringToFront(); } catch {} },
        };
    }

    const tracker = await attachPageTracker(browser);
    await tracker.bringToFront();
    console.log('[ATTACH] Attached to page:', tracker.page.url());

    const type = (process.env.TYPE || 'unknown').toLowerCase();

    switch (type) {
      case 'google': {
        const meetingUrl = tracker.page.url();
        const deadline = Date.now() + MEET_RELOAD_TIMEOUT_MS;
        let attempt = 0;

        while (Date.now() < deadline) {
            try {
                if (await meetBlocked(tracker.page)) {
                    attempt++;
                    console.log(`[GOOGLE] Blocked screen re-appeared (Attempt #${attempt}). Retrying...`);
                    if (attempt % 2 === 0) {
                        await tracker.page.reload({ waitUntil: 'domcontentloaded' });
                    } else {
                        await tracker.page.goto(meetingUrl, { waitUntil: 'domcontentloaded' });
                    }
                    await sleep(MEET_RELOAD_WAIT_MS);
                    await dismissPopups(tracker.page);
                    continue;
                }

                console.log('[GOOGLE] On join page, attempting to enter name...');
                await typeNameInAnyFrame(tracker.page, ['input[type="text"]', 'input[placeholder="Your name"]'], BOT_NAME, 10000);
                console.log('[GOOGLE] Name entered:', BOT_NAME);

                if (await meetBlocked(tracker.page)) continue;

                console.log('[GOOGLE] Attempting to click "Ask to join"...');
                const clicked = await tracker.page.evaluate(() => {
                    const spans = Array.from(document.querySelectorAll('span'));
                    const joinSpan = spans.find(span => span.textContent.trim() === 'Ask to join');
                    if (joinSpan) {
                        const button = joinSpan.closest('button');
                        if (button && !button.disabled) {
                            button.click();
                            return true;
                        }
                    }
                    return false;
                });

                if (!clicked) {
                    await tracker.page.keyboard.press('Enter');
                }
                console.log('[GOOGLE] Clicked "Ask to join".');

                await tracker.page.waitForSelector('[aria-label*="Leave call"]', { timeout: 60000 });
                console.log('[GOOGLE] Successfully joined the meeting.');
                break;

            } catch (err) {
                console.error(`[GOOGLE] Error during join attempt: ${err.message}. Retrying...`);
                await sleep(2000);
            }
        }
        break;
      }

      case 'zoom': {
        console.log('[ATTACH] Running Zoom flow...');
        
        console.log('[ZOOM] Waiting for page and dismissing potential app dialog...');
        await sleep(5000); 
        await tracker.page.keyboard.press('Escape');
        console.log('[ZOOM] Pressed Escape to dismiss dialog.');
        await sleep(1000);

        await clickTextSmart(tracker.page, 'Join from your browser', { timeout: 10000 }).catch(() => {
          console.log('[ZOOM] "Join from your browser" link not found, continuing...');
        });
        
        await clickTextSmart(tracker.page, 'I Agree', { exact: true, timeout: 10000 }).catch(() => {
            console.log('[ZOOM] "I Agree" button not found, continuing...');
        });
        
        console.log('[ZOOM] Typing name...');
        await typeNameInAnyFrame(tracker.page, '#input-for-name', BOT_NAME);
        
        console.log('[ZOOM] Clicking Join button...');
        await clickTextSmart(tracker.page, 'Join', { exact: true, timeout: 10000 });

        await tracker.page.waitForSelector('[aria-label="Leave"]', { timeout: 30000 });
        console.log('[ZOOM] Successfully joined the meeting.');
        break;
      }

      case 'teams': {
        console.log('[ATTACH] Running Teams flow...');
        await sleep(6000);
        await dismissPopups(tracker.page);

        await clickTextSmart(tracker.page, 'Continue on this browser', { timeout: 8000 }).catch(() => {
            console.log('[TEAMS] "Continue on this browser" not found, proceeding...');
        });
        
        console.log('[TEAMS] Looking for audio/video confirmation modal...');
        try {
            const continueButtonXPath = "//button[contains(., 'Continue without audio or video')]";
            await tracker.page.waitForXPath(continueButtonXPath, { timeout: 15000 });
            const [buttonHandle] = await tracker.page.$x(continueButtonXPath);
            
            if (buttonHandle) {
                await buttonHandle.evaluate(btn => btn.click());
                console.log('[TEAMS] Clicked "Continue without audio or video".');
            } else {
                console.log('[TEAMS] Audio/video modal button was found by XPath but could not be handled.');
            }
        } catch (e) {
            console.log(`[TEAMS] Audio/video modal did not appear or failed: ${e.message}`);
        }
        
        await sleep(2000);

        const nameInputSelector = 'input[data-tid="prejoin-display-name-input"]';
        await typeNameInAnyFrame(tracker.page, nameInputSelector, BOT_NAME);
        console.log('[TEAMS] Name entered.');

        await clickTextSmart(tracker.page, 'Join now', { exact: true, timeout: 15000 });
        console.log('[TEAMS] Clicked "Join now".');

        await tracker.page.waitForSelector('[aria-label*="Leave"]', { timeout: 60000 });
        console.log('[TEAMS] Successfully joined the meeting.');
        break;
      }
    }

    console.log('[ATTACH] Done.');
    process.exit(0);
  } catch (err) {
    console.error('[ATTACH][ERR]', err.stack || err);
    process.exit(1);
  }
})();
