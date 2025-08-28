// rem-watcher.js (CommonJS)
// Run: node rem-watcher.js

const { chromium } = require('playwright');
const nodemailer = require('nodemailer');
require('dotenv').config();

const {
  YORK_USERNAME,
  YORK_PASSWORD,
  CATALOGUE_NUMBER,
  SMTP_HOST,
  SMTP_PORT,
  SMTP_USER,
  SMTP_PASS,
  NOTIFY_TO,
} = process.env;

if (!YORK_USERNAME || !YORK_PASSWORD || !CATALOGUE_NUMBER) {
  console.error('Missing YORK_USERNAME, YORK_PASSWORD, or CATALOGUE_NUMBER in .env');
  process.exit(1);
}

// ---------- email ----------
const mailer = nodemailer.createTransport({
  host: SMTP_HOST,
  port: Number(SMTP_PORT || 465),
  secure: true,
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});
async function sendMail(subject, html) {
  try {
    await mailer.sendMail({
      from: `"REM Watcher" <${SMTP_USER}>`,
      to: NOTIFY_TO,
      subject,
      html,
    });
  } catch (e) {
    console.error('Email send error:', e.message);
  }
}

// ---------- timing ----------
function inQuietHours(d = new Date()) {
  const h = d.getHours();
  return h >= 0 && h < 8; // 00:00–07:59
}
function nextDelayMs() {
  const base = 15 * 60 * 1000;                     // 15 min
  const jitter = Math.floor(Math.random() * (20 * 60 * 1000)); // 0–20 min
  return base + jitter;                             // 15–35 min
}
function scheduleNext(fn) {
  const delay = nextDelayMs();
  const when = new Date(Date.now() + delay);
  console.log(`Next attempt in ${(delay/60000).toFixed(1)} min @ ${when.toLocaleString()}`);
  setTimeout(fn, delay);
}

// ---------- browser/session ----------
const USER_DATA_DIR = './.rem-profile'; // persistent profile reduces 2FA prompts

async function ensureLoggedInAndAtREM(page) {
  // ALWAYS start from the application URL (not raw Passport York)
  await page.goto('https://wrem.sis.yorku.ca/Apps/WebObjects/REM.woa/wa/DirectAction/rem', {
    waitUntil: 'domcontentloaded',
  });

  // If redirected to Passport York login, fill & submit:
  const userSel = '#mli';
  const passSel = '#password';
  const loginBtnSel = 'body > div.container.page-content > div.row > div:nth-child(1) > form > div:nth-child(2) > div.col-md-8 > p:nth-child(2) > input';

  const hasLogin = await page.$(userSel);
  if (hasLogin) {
    await page.fill(userSel, YORK_USERNAME);
    await page.fill(passSel, YORK_PASSWORD);
    await page.waitForTimeout(1000); // wait 1s before clicking login
    await page.click(loginBtnSel);
  }

  // Duo step occurs now; wait for “Yes, this is my device” if shown:
  try {
    await page.waitForSelector('#trust-browser-button', { timeout: 15000 });
    await page.waitForTimeout(1000); // wait 1s before clicking trust
    await page.click('#trust-browser-button');
  } catch (_) {
    // If already trusted/auto-redirected, this is fine.
  }

  // Wait a bit for REM redirect/landing to load.
  await page.waitForTimeout(7000);
}

async function doEnrollOnce(page) {
  // PAGE 5: select academic session (4th option)
  const sessionSelectSel =
    'body > form > div:nth-child(1) > table > tbody > tr:nth-child(4) > td:nth-child(2) > table > tbody > tr > td > table > tbody > tr:nth-child(2) > td:nth-child(2) > span > select';
  const continueBtnSel =
    'body > form > div:nth-child(1) > table > tbody > tr:nth-child(4) > td:nth-child(2) > table > tbody > tr > td > table > tbody > tr:nth-child(3) > td:nth-child(2) > input[type=submit]';

  await page.waitForSelector(sessionSelectSel, { timeout: 30000 });
  await page.selectOption(sessionSelectSel, { index: 3 }); // 0-based, 3 = 4th option
  await page.waitForTimeout(1000); // wait 1s before clicking continue
  await page.click(continueBtnSel);

  // PAGE 6: "Add a course"
  const addCourseBtnSel =
    'body > form > div:nth-child(1) > table > tbody > tr:nth-child(4) > td:nth-child(2) > table > tbody > tr > td > table:nth-child(11) > tbody > tr:nth-child(1) > td:nth-child(1) > div > input[type=image]';
  await page.waitForSelector(addCourseBtnSel, { timeout: 30000 });
  await page.waitForTimeout(1000); // wait 1s before clicking add course
  await page.click(addCourseBtnSel);

  // PAGE 7: enter catalogue number + submit
  const catalogInputSel = '#catalogNr';
  const addCourseSubmitSel = '#addCourseAction';
  await page.waitForSelector(catalogInputSel, { timeout: 30000 });
  await page.fill(catalogInputSel, CATALOGUE_NUMBER);
  await page.waitForTimeout(1000); // wait 1s before clicking add course submit
  await page.click(addCourseSubmitSel);

  // PAGE 8: confirm YES
  const yesBtnSel =
    'body > form > div:nth-child(1) > table > tbody > tr:nth-child(4) > td:nth-child(2) > table > tbody > tr > td > table:nth-child(4) > tbody > tr:nth-child(7) > td:nth-child(2) > input[type=submit]:nth-child(2)';
  await page.waitForSelector(yesBtnSel, { timeout: 30000 });
  await page.waitForTimeout(1000); // wait 1s before clicking yes
  await page.click(yesBtnSel);

  // PAGE 9: read result
  const resultSel =
    'body > form > div:nth-child(1) > table > tbody > tr:nth-child(4) > td:nth-child(2) > table > tbody > tr > td > table:nth-child(4) > tbody > tr:nth-child(1) > td:nth-child(2) > span > font > b';
  await page.waitForSelector(resultSel, { timeout: 30000 });
  const resultText = (await page.textContent(resultSel))?.trim() || '';

  const isFailure = /The course has not been added\./i.test(resultText);
  return { success: !isFailure, message: resultText };
}

async function runWatcher() {
  const browser = await chromium.launchPersistentContext(USER_DATA_DIR, {
    channel: 'chrome',    // Playwright-managed Chrome
    headless: false,      // visible = more reliable for Duo
    viewport: { width: 1280, height: 900 },
  });
  const page = await browser.newPage();

  const attempt = async () => {
    try {
      if (inQuietHours()) {
        console.log('Quiet hours (00:00–08:00). Skipping attempt.');
        scheduleNext(attempt);
        return;
      }

      console.log(`[${new Date().toLocaleString()}] Attempt start`);
      await ensureLoggedInAndAtREM(page);

      const { success, message } = await doEnrollOnce(page);
      console.log('Result text:', message);

      if (success) {
        console.log('✅ Appears SUCCESS. Stopping watcher.');
        await sendMail(
          `REM: Enrolment likely succeeded for ${CATALOGUE_NUMBER}`,
          `<p>Result text:</p><pre>${message}</pre>`
        );
        return; // stop after success
      } else {
        console.log('❌ Not added (likely full). Will retry.');
        scheduleNext(attempt);
      }
    } catch (err) {
      console.error('Attempt error:', err?.message || err);
      await sendMail(
        'REM Watcher: Error',
        `<pre>${err?.stack || err?.message || String(err)}</pre>`
      );
      setTimeout(attempt, 5 * 60 * 1000); // 5-min backoff
    }
  };

  attempt();

  process.on('SIGINT', async () => {
    console.log('Shutting down...');
    await browser.close();
    process.exit(0);
  });
}

runWatcher().catch(err => {
  console.error(err);
  process.exit(1);
});