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
let playwrightAvailable = true;

/**
 * Initialize a shared browser instance (reused across all screenshots).
 */
async function initBrowser() {
  if (browser) return true;
  if (!playwrightAvailable) return false;

  try {
    const { Camoufox } = require('camoufox-js');
    browser = await Camoufox({
      headless: true,
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
  let context = null;
  let page = null;

  try {
    context = await browser.newContext({
      viewport: { width: 800, height: 2000 },
      colorScheme: 'dark',
      locale: 'en-US'
    });
    page = await context.newPage();

    // Block unnecessary resources for speed
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['media'].includes(type)) { // Note: 'font' was removed to fix missing Japanese characters / tofu issue
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

    // Ensure output directory exists
    const outputDir = path.dirname(outputPath);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    // Hide any login bars or popups that might overlap before computing bounding box
    await page.evaluate(() => {
      document.querySelectorAll('[data-testid="xMigrationBottomBar"], [data-testid="BottomBar"]').forEach(el => el.style.display = 'none');
    });

    // Take a screenshot of all visible tweets combined using bounding box
    const clip = await page.evaluate(() => {
        const tweets = Array.from(document.querySelectorAll('article[data-testid="tweet"]')).filter(el => el.offsetHeight > 0);
        if (tweets.length === 0) return null;
        let top = Infinity, left = Infinity, bottom = -Infinity, right = -Infinity;
        tweets.forEach(el => {
            const cell = el.closest('[data-testid="cellInnerDiv"]') || el;
            const rect = cell.getBoundingClientRect();
            if (rect.top < top) top = rect.top;
            if (rect.left < left) left = rect.left;
            if (rect.bottom > bottom) bottom = rect.bottom;
            if (rect.right > right) right = rect.right;
        });
        return {
            x: left + window.scrollX,
            y: top + window.scrollY,
            width: right - left,
            height: bottom - top
        };
    });

    if (clip && clip.width > 0 && clip.height > 0) {
      // Add a tiny bit of padding to the bounding box if we want, or just rely on the cellInnerDiv padding
      await page.screenshot({ path: outputPath, type: 'png', clip });
    } else {
      // Fallback if bounding box failed
      const fallbackTweet = await page.locator('article[data-testid="tweet"]').first();
      if (await fallbackTweet.isVisible({ timeout: 2000 }).catch(() => false)) {
         await fallbackTweet.screenshot({ path: outputPath, type: 'png' });
      } else {
         await page.screenshot({ path: outputPath, type: 'png' }); // last resort
      }
    }

    return outputPath;
  } catch (err) {
    console.error(`[Screenshot] Failed for tweet ${tweetId}:`, err.message);
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
    if (context) await context.close().catch(() => {});
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
  let context = null;
  let page = null;

  try {
    context = await browser.newContext({
      viewport: { width: 800, height: 2000 },
      colorScheme: 'dark',
      locale: 'en-US'
    });
    page = await context.newPage();

    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (['media'].includes(type)) { // Note: 'font' was removed to fix missing Japanese characters / tofu issue
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
    if (context) await context.close().catch(() => {});
  }
}

module.exports = {
  screenshotTweet,
  screenshotThread,
  closeBrowser,
  initBrowser,
};
