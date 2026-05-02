import fs from 'node:fs';
import path from 'node:path';
import { rootLogger } from '../runtime/logger';
import { updateEnvKey } from './env';

const logger = rootLogger.child('refresh-tokens');

interface RefreshResult {
  authToken: string;
  csrfToken: string;
}

/**
 * Refresh Twitter auth tokens by launching a headless Playwright browser
 * with a saved persistent profile, navigating to Twitter, and extracting
 * fresh cookies.
 *
 * Requires a prior `--setup` run where the user logged in manually.
 */
export async function refreshTokensFromProfile(
  profileDir: string,
  envPath: string
): Promise<RefreshResult | null> {
  if (!fs.existsSync(profileDir)) {
    logger.error('No saved browser profile. Run setup first.', { profileDir });
    return null;
  }

  // Dynamic import: playwright may not be installed in all environments
  let chromium: any;
  try {
    chromium = (await import('playwright')).chromium;
  } catch {
    logger.error('Playwright is not installed. Cannot refresh tokens automatically.');
    return null;
  }

  let context: any;
  try {
    context = await chromium.launchPersistentContext(profileDir, {
      headless: true,
      args: ['--disable-blink-features=AutomationControlled'],
    });

    const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();

    try {
      await page.goto('https://x.com/home', { waitUntil: 'networkidle', timeout: 30000 });
      await page.waitForTimeout(3000);
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
      updateEnvKey(envPath, 'TWITTER_AUTH_TOKEN', authToken);
      updateEnvKey(envPath, 'TWITTER_CSRF_TOKEN', csrfToken);
      logger.info('Tokens refreshed successfully');
      return { authToken, csrfToken };
    }

    logger.error('No valid tokens found in browser profile. Re-run setup.');
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
  let chromium: any;
  try {
    chromium = (await import('playwright')).chromium;
  } catch {
    logger.error('Playwright is not installed. Run: npx playwright install chromium');
    return false;
  }

  console.log('\n' + '═'.repeat(50));
  console.log('  Twitter Session Setup');
  console.log('═'.repeat(50));
  console.log('\nA browser window will open.');
  console.log('Please log in to your Twitter/X account.');
  console.log('Once you see your home timeline, close the browser.\n');

  try {
    const context = await chromium.launchPersistentContext(profileDir, {
      headless: false,
      args: ['--disable-blink-features=AutomationControlled'],
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
