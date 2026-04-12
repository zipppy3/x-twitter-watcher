'use strict';

/**
 * Screenshot — Captures clean dark-mode screenshots of tweets using Playwright.
 * 
 * Headless Chromium visits the public tweet URL (no login needed),
 * waits for the content to render, and captures just the tweet element.
 */

const path = require('path');
const fs = require('fs');

let browser = null;
let browserContext = null;
let playwrightAvailable = true;

/**
 * Initialize a shared browser instance (reused across all screenshots).
 */
async function initBrowser() {
  if (browser) return true;
  if (!playwrightAvailable) return false;

  try {
    const { chromium } = require('playwright');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });
    browserContext = await browser.newContext({
      viewport: { width: 550, height: 900 },
      colorScheme: 'dark',
      locale: 'en-US',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });
    return true;
  } catch (err) {
    console.error('[Screenshot] Playwright not available:', err.message);
    playwrightAvailable = false;
    return false;
  }
}

/**
 * Close the shared browser instance.
 */
async function closeBrowser() {
  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
  }
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
  }
}

/**
 * Take a screenshot of a tweet.
 * 
 * @param {string} username - Tweet author's username
 * @param {string} tweetId - Tweet ID
 * @param {string} outputPath - Where to save the PNG
 * @returns {string|null} Path to screenshot or null on failure
 */
async function screenshotTweet(username, tweetId, outputPath) {
  const ready = await initBrowser();
  if (!ready) return null;

  const url = `https://x.com/${username}/status/${tweetId}`;
  let page = null;

  try {
    page = await browserContext.newPage();

    // Block unnecessary resources for speed
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['font', 'media'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Wait for the tweet article to render
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 15000 });

    // Small delay to let images and styles finish loading
    await page.waitForTimeout(2000);

    // Dismiss any login popups or cookie banners
    try {
      const closeBtn = page.locator('[data-testid="xMigrationBottomBar"] button, [role="button"][aria-label="Close"]');
      if (await closeBtn.first().isVisible({ timeout: 1000 })) {
        await closeBtn.first().click();
        await page.waitForTimeout(500);
      }
    } catch { /* no popup */ }

    // Find the main tweet article (first one is the focal tweet)
    const tweetElement = page.locator('article[data-testid="tweet"]').first();

    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Take screenshot of just the tweet element
    await tweetElement.screenshot({
      path: outputPath,
      type: 'png',
    });

    return outputPath;
  } catch (err) {
    console.error(`[Screenshot] Failed for tweet ${tweetId}:`, err.message);
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * Take a screenshot of a full thread (multiple tweets stacked).
 * Captures wider viewport to show the thread conversation view.
 * 
 * @param {string} username
 * @param {string} tweetId - The last tweet in the thread
 * @param {string} outputPath
 * @returns {string|null}
 */
async function screenshotThread(username, tweetId, outputPath) {
  const ready = await initBrowser();
  if (!ready) return null;

  const url = `https://x.com/${username}/status/${tweetId}`;
  let page = null;

  try {
    page = await browserContext.newPage();

    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['font', 'media'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('article[data-testid="tweet"]', { timeout: 15000 });
    await page.waitForTimeout(3000); // Extra time for thread to load

    // Dismiss popups
    try {
      const closeBtn = page.locator('[data-testid="xMigrationBottomBar"] button, [role="button"][aria-label="Close"]');
      if (await closeBtn.first().isVisible({ timeout: 1000 })) {
        await closeBtn.first().click();
        await page.waitForTimeout(500);
      }
    } catch { /* no popup */ }

    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // For threads, take a full-page screenshot to capture all stacked tweets
    await page.screenshot({
      path: outputPath,
      type: 'png',
      fullPage: true,
    });

    return outputPath;
  } catch (err) {
    console.error(`[Screenshot] Thread failed for ${tweetId}:`, err.message);
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

module.exports = {
  screenshotTweet,
  screenshotThread,
  closeBrowser,
  initBrowser,
};
