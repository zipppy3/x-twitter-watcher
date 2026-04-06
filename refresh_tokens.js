#!/usr/bin/env node
'use strict';

/**
 * Token Refresh Script — Uses Node.js Playwright with a saved browser profile.
 *
 * First-time setup:
 *   node refresh_tokens.js --setup
 *   → Opens a visible browser window. Log in to Twitter manually.
 *   → Once logged in, close the browser. Your session is saved.
 *
 * Automatic refresh (called by watcher-core.js):
 *   node refresh_tokens.js
 *   → Runs headless, extracts cookies from the saved profile, updates .env
 */

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const SCRIPT_DIR = __dirname;
const PROFILE_DIR = path.join(SCRIPT_DIR, '.browser-profile');
const ENV_FILE = path.join(SCRIPT_DIR, '.env');

/**
 * Update the .env file with new token values.
 */
function updateEnv(authToken, ct0) {
  let lines = [];
  if (fs.existsSync(ENV_FILE)) {
    lines = fs.readFileSync(ENV_FILE, 'utf8').split('\n');
  }

  const newLines = [];
  let foundAuth = false;
  let foundCsrf = false;

  for (const line of lines) {
    const stripped = line.trim();
    if (stripped.startsWith('TWITTER_AUTH_TOKEN=')) {
      newLines.push(`TWITTER_AUTH_TOKEN=${authToken}`);
      foundAuth = true;
    } else if (stripped.startsWith('TWITTER_CSRF_TOKEN=')) {
      newLines.push(`TWITTER_CSRF_TOKEN=${ct0}`);
      foundCsrf = true;
    } else {
      newLines.push(line);
    }
  }

  if (!foundAuth) newLines.push(`TWITTER_AUTH_TOKEN=${authToken}`);
  if (!foundCsrf) newLines.push(`TWITTER_CSRF_TOKEN=${ct0}`);

  fs.writeFileSync(ENV_FILE, newLines.join('\n'), 'utf8');
}

/**
 * Open a visible browser for the user to log in to Twitter.
 */
async function setupProfile() {
  console.log('═'.repeat(50));
  console.log('  Twitter Session Setup');
  console.log('═'.repeat(50));
  console.log('\nA browser window will open.');
  console.log('Please log in to your Twitter/X account.');
  console.log('Once you see your home timeline, close the browser.\n');

  try {
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
      viewport: { width: 1280, height: 800 },
    });

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    try {
      await page.goto('https://x.com/login');
    } catch {}

    console.log('Waiting for you to log in...');
    console.log('(Close the browser when done)');

    // Wait until the context pages are all closed by the user
    await new Promise(resolve => {
      context.on('close', resolve);
      // Also catch if the specific page is closed
      page.on('close', async () => {
        const pages = context.pages();
        if (pages.length === 0) {
           await context.close().catch(()=>{});
        }
      });
    });

    // Try to extract cookies (if context isn't fully shut down yet, or from file... wait, 
    // playwright persistent context might not let us extract cookies after it is closed. 
    // We should extract cookies BEFORE it fully closes if possible, or re-launch headless to read them.
    // Let's re-launch headless quickly to read what was saved.)
  } catch (err) {
    console.log(`Browser closed: ${err.message}`);
  }

  // Re-launch headless to securely grab the cookies that were saved to disk
  try {
    const checkContext = await chromium.launchPersistentContext(PROFILE_DIR, { headless: true });
    const cookies = await checkContext.cookies('https://x.com');
    const authCookie = cookies.find(c => c.name === 'auth_token');
    const ct0Cookie = cookies.find(c => c.name === 'ct0');
    
    await checkContext.close();

    const authToken = authCookie ? authCookie.value : null;
    const ct0 = ct0Cookie ? ct0Cookie.value : null;

    if (authToken && ct0) {
      updateEnv(authToken, ct0);
      console.log('\n✅ Setup complete! Tokens saved to .env');
      console.log(`   auth_token: ${authToken.substring(0, 8)}****`);
      console.log(`   ct0:        ${ct0.substring(0, 8)}****\n`);
      console.log('Your browser profile is saved. Future refreshes will be automatic.');
    } else {
      console.log('\n⚠  Could not extract tokens. Make sure you logged in fully.');
      console.log('   Try running "node refresh_tokens.js --setup" again.');
      process.exit(1);
    }
  } catch (e) {
    console.log('\n⚠  Setup check failed:', e.message);
    process.exit(1);
  }
}

/**
 * Headless: open saved profile, navigate to Twitter, extract fresh cookies.
 */
async function refreshTokens() {
  if (!fs.existsSync(PROFILE_DIR)) {
    console.log('FAILED: No saved browser profile. Run with --setup first.');
    process.exit(1);
  }

  try {
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    try {
      await page.goto('https://x.com/home', { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000); // Give it a moment to settle
    } catch (e) {
      console.log(`FAILED: ${e.message}`);
      await context.close();
      process.exit(1);
    }

    // Extract cookies
    const cookies = await context.cookies('https://x.com');
    const authCookie = cookies.find(c => c.name === 'auth_token');
    const ct0Cookie = cookies.find(c => c.name === 'ct0');

    await context.close();

    const authToken = authCookie ? authCookie.value : null;
    const ct0 = ct0Cookie ? ct0Cookie.value : null;

    if (authToken && ct0) {
      updateEnv(authToken, ct0);
      console.log('SUCCESS');
    } else {
      console.log('FAILED: No valid tokens in browser profile. Re-run with --setup.');
      process.exit(1);
    }
  } catch (err) {
    console.log('FAILED:', err.message);
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════════════════════════
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--setup')) {
    setupProfile();
  } else {
    refreshTokens();
  }
}
