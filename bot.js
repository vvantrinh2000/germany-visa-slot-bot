import fs from "fs";
import path from "path";
import { chromium } from "playwright";

const APPOINTMENT_URL = process.env.APPOINTMENT_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const CHECK_TIMEOUT_MS = Number(process.env.CHECK_TIMEOUT_MS || "45000");
const HEADLESS = process.env.HEADLESS !== "false";
const TZ = process.env.TIMEZONE || "Europe/Dublin";

const NEGATIVE_PATTERNS = (process.env.NEGATIVE_PATTERNS || "")
  .split("|")
  .map(s => s.trim())
  .filter(Boolean);

const POSITIVE_PATTERNS = (process.env.POSITIVE_PATTERNS || "")
  .split("|")
  .map(s => s.trim())
  .filter(Boolean);

if (!APPOINTMENT_URL) throw new Error("Missing APPOINTMENT_URL");
if (!TELEGRAM_BOT_TOKEN) throw new Error("Missing TELEGRAM_BOT_TOKEN");
if (!TELEGRAM_CHAT_ID) throw new Error("Missing TELEGRAM_CHAT_ID");

const STATE_PATH = path.resolve("state.json");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { lastStatus: "unknown", lastFingerprint: "" };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

function matchesAny(text, patterns) {
  for (const p of patterns) {
    try {
      const re = new RegExp(p, "i");
      if (re.test(text)) return p;
    } catch {
      if (text.includes(p.toLowerCase())) return p;
    }
  }
  return null;
}

function fingerprint(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) {
    h = (h * 31 + text.charCodeAt(i)) >>> 0;
  }
  return String(h);
}

async function telegramSendMessage(text) {
  const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text,
      disable_web_page_preview: true
    })
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Telegram sendMessage failed: ${resp.status} ${body}`);
  }
}

async function telegramSendPhoto(photoPath, caption) {
  const form = new FormData();
  const buffer = fs.readFileSync(photoPath);
  const blob = new Blob([buffer], { type: "image/png" });

  form.append("chat_id", TELEGRAM_CHAT_ID);
  form.append("caption", caption);
  form.append("photo", blob, "latest.png");

  const resp = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`, {
    method: "POST",
    body: form
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Telegram sendPhoto failed: ${resp.status} ${body}`);
  }
}

async function checkPage() {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    locale: "en-IE",
    timezoneId: TZ,
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36"
  });

  const page = await context.newPage();
  page.setDefaultTimeout(CHECK_TIMEOUT_MS);

  try {
    await page.goto(APPOINTMENT_URL, { waitUntil: "domcontentloaded", timeout: CHECK_TIMEOUT_MS });
    await page.waitForTimeout(5000);

    const title = await page.title().catch(() => "");
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const text = normalizeText(`${title}\n${bodyText}`);

    const negativeHit = matchesAny(text, NEGATIVE_PATTERNS);
    const positiveHit = matchesAny(text, POSITIVE_PATTERNS);

    let status = "unknown";
    let reason = "No pattern matched";

    if (positiveHit && !negativeHit) {
      status = "available";
      reason = `Matched positive pattern: ${positiveHit}`;
    } else if (negativeHit && !positiveHit) {
      status = "unavailable";
      reason = `Matched negative pattern: ${negativeHit}`;
    } else if (positiveHit && negativeHit) {
      status = "unknown";
      reason = `Matched both positive and negative patterns`;
    }

    const shotPath = path.resolve("latest.png");
    await page.screenshot({ path: shotPath, fullPage: true });

    return {
      status,
      reason,
      title,
      url: page.url(),
      text,
      shotPath,
      fingerprint: fingerprint(text.slice(0, 6000))
    };
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  const state = loadState();
  const result = await checkPage();

  console.log(JSON.stringify({
    time: new Date().toISOString(),
    status: result.status,
    reason: result.reason,
    url: result.url,
    title: result.title
  }, null, 2));

  const changed =
    result.status !== state.lastStatus ||
    result.fingerprint !== state.lastFingerprint;

  if (result.status === "available" && changed) {
    await telegramSendPhoto(
      result.shotPath,
      `🚨 Germany tourist visa appointment may be AVAILABLE\n${result.reason}\n${result.url}`
    );
  }

  if (result.status === "unknown" && changed) {
    await telegramSendMessage(
      `⚠️ Visa bot: page state is UNKNOWN\n${result.reason}\n${result.url}`
    );
  }

  saveState({
    lastStatus: result.status,
    lastFingerprint: result.fingerprint
  });
}

main().catch(async (err) => {
  console.error(err);
  try {
    await telegramSendMessage(`❌ Visa bot error\n${String(err.message || err)}`);
  } catch {}
  process.exit(1);
});