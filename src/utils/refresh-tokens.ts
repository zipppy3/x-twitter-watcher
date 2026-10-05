import fs from 'node:fs';
import path from 'node:path';
import { rootLogger } from '../runtime/logger';
import { readEnv, updateEnvKey } from './env';

const logger = rootLogger.child('refresh-tokens');

/**
 * Open the saved login profile in a Chromium-based browser.
 *
 * playwright-core ships no browser of its own, so an installed Chrome or Edge is
 * used; a Playwright-managed Chromium (`npx playwright-core install chromium`)
 * is the last resort.
 */
async function launchProfile(profileDir: string, options: Record<string, unknown>): Promise<any> {
  const { chromium } = await import('playwright-core');
  let lastError: Error | null = null;
  for (const channel of ['chrome', 'msedge', undefined]) {
    try {
      return await chromium.launchPersistentContext(profileDir, {
        ...options,
        ...(channel ? { channel } : {}),
        args: ['--disable-blink-features=AutomationControlled'],
      });
    } catch (error) {
      lastError = error as Error;
    }
  }
  throw new Error(
    `No usable Chrome, Edge or Chromium found (${lastError?.message.split(/\r?\n/)[0] ?? 'unknown error'}). ` +
      'Install Chrome/Edge or run: npx playwright-core install chromium'
  );
}

interface RefreshResult {
  authToken: string;
  csrfToken: string;
}

/**
 * Refresh Twitter auth tokens by launching a headless browser with the saved
 * persistent profile, navigating to Twitter, and extracting fresh cookies.
 *
 * Requires a prior `login` run where the user logged in manually.
 * With `rejectUnchanged`, cookies identical to the ones already in .env count
 * as a failure (used by the automatic refresh, where those are known to be bad).
 */
export async function refreshTokensFromProfile(
  profileDir: string,
  envPath: string,
  options: { rejectUnchanged?: boolean } = {}
): Promise<RefreshResult | null> {
  if (!fs.existsSync(profileDir)) {
    logger.error('No saved browser profile. Run the `login` command first.', { profileDir });
    return null;
  }

  let context: any;
  try {
    context = await launchProfile(profileDir, { headless: true });

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    try {
      // x.com keeps connections open, so waiting for "networkidle" would always time out.
      await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);
    } catch (error) {
      logger.error('Failed to navigate to Twitter', { message: (error as Error).message });
      await context.close();
      return null;
    }

    const cookies: Array<{ name: string; value: string }> = await context.cookies('https://x.com');
    const authCookie = cookies.find((c) => c.name === 'auth_token');
    const ct0Cookie = cookies.find((c) => c.name === 'ct0');
    await context.close();

    const authToken = authCookie?.value ?? null;
    const csrfToken = ct0Cookie?.value ?? null;

    if (authToken && csrfToken) {
      const current = readEnv(envPath);
      if (
        options.rejectUnchanged &&
        current.TWITTER_AUTH_TOKEN === authToken &&
        current.TWITTER_CSRF_TOKEN === csrfToken
      ) {
        // The profile holds the very session that is being rejected; re-saving it fixes nothing.
        logger.error('Browser profile only has the session that is already failing. Manual login required.');
        return null;
      }

      updateEnvKey(envPath, 'TWITTER_AUTH_TOKEN', authToken);
      updateEnvKey(envPath, 'TWITTER_CSRF_TOKEN', csrfToken);
      logger.info('Tokens refreshed successfully');
      return { authToken, csrfToken };
    }

    logger.error('No valid tokens found in browser profile. Run the `login` command again.');
    return null;
  } catch (error) {
    logger.error('Token refresh failed', { message: (error as Error).message });
    if (context) {
      await context.close().catch(() => undefined);
    }
    return null;
  }
}

/**
 * Interactive setup: opens a visible browser for the user to log in.
 */
export async function setupBrowserProfile(
  profileDir: string,
  envPath: string
): Promise<boolean> {
  console.log('\n' + '═'.repeat(50));
  console.log('  Twitter Session Setup');
  console.log('═'.repeat(50));
  console.log('\nA browser window will open.');
  console.log('Please log in to your Twitter/X account.');
  console.log('Once you see your home timeline, close the browser.\n');

  try {
    const context = await launchProfile(profileDir, {
      headless: false,
      viewport: { width: 1280, height: 800 },
    });

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    try {
      await page.goto('https://x.com/login');
    } catch {
      // Ignore navigation errors during setup
    }

    console.log('Waiting for you to log in...');
    console.log('(Close the browser when done)');

    await new Promise<void>((resolve) => {
      context.on('close', resolve);
      page.on('close', async () => {
        const pages = context.pages();
        if (pages.length === 0) {
          await context.close().catch(() => undefined);
        }
      });
    });
  } catch (error) {
    console.log(`Browser closed: ${(error as Error).message}`);
  }

  // Re-launch headless to grab saved cookies
  const result = await refreshTokensFromProfile(profileDir, envPath);
  if (result) {
    console.log('\n✅ Setup complete! Tokens saved to .env');
    console.log(`   auth_token: ${result.authToken.substring(0, 8)}****`);
    console.log(`   ct0:        ${result.csrfToken.substring(0, 8)}****\n`);
    console.log('Your browser profile is saved. Future refreshes will be automatic.');
    return true;
  }

  console.log('\n⚠  Could not extract tokens. Make sure you logged in fully.');
  return false;
}
