"""
Token Refresh Script — Uses Playwright with a saved browser profile.

First-time setup:
  python refresh_tokens.py --setup
  → Opens a visible browser window. Log in to Twitter manually.
  → Once logged in, close the browser. Your session is saved.

Automatic refresh (called by watcher.js):
  python refresh_tokens.py
  → Runs headless, extracts cookies from the saved profile, updates .env
"""

import asyncio
import argparse
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROFILE_DIR = os.path.join(SCRIPT_DIR, '.browser-profile')
ENV_FILE = os.path.join(SCRIPT_DIR, '.env')


def update_env(auth_token: str, ct0: str):
    """Update the .env file with new token values."""
    lines = []
    if os.path.exists(ENV_FILE):
        with open(ENV_FILE, 'r') as f:
            lines = f.readlines()

    new_lines = []
    found_auth = False
    found_csrf = False

    for line in lines:
        stripped = line.strip()
        if stripped.startswith('TWITTER_AUTH_TOKEN='):
            new_lines.append(f'TWITTER_AUTH_TOKEN={auth_token}\n')
            found_auth = True
        elif stripped.startswith('TWITTER_CSRF_TOKEN='):
            new_lines.append(f'TWITTER_CSRF_TOKEN={ct0}\n')
            found_csrf = True
        else:
            new_lines.append(line)

    if not found_auth:
        new_lines.append(f'TWITTER_AUTH_TOKEN={auth_token}\n')
    if not found_csrf:
        new_lines.append(f'TWITTER_CSRF_TOKEN={ct0}\n')

    with open(ENV_FILE, 'w') as f:
        f.writelines(new_lines)


async def setup_profile():
    """Open a visible browser for the user to log in to Twitter."""
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print('ERROR: Playwright is not installed.')
        print('Run: pip install playwright && python -m playwright install chromium')
        sys.exit(1)

    print('═' * 50)
    print('  Twitter Session Setup')
    print('═' * 50)
    print()
    print('A browser window will open.')
    print('Please log in to your Twitter/X account.')
    print('Once you see your home timeline, close the browser.')
    print()

    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(
            PROFILE_DIR,
            headless=False,
            args=['--disable-blink-features=AutomationControlled'],
            viewport={'width': 1280, 'height': 800},
        )

        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto('https://x.com/login')

        print('Waiting for you to log in...')
        print('(Close the browser when done)')

        # Wait until the browser is closed by the user
        try:
            await context.pages[0].wait_for_event('close', timeout=0)
        except Exception:
            pass

        # Try to extract cookies before closing
        cookies = await context.cookies('https://x.com')
        auth_token = next((c['value'] for c in cookies if c['name'] == 'auth_token'), None)
        ct0 = next((c['value'] for c in cookies if c['name'] == 'ct0'), None)

        await context.close()

    if auth_token and ct0:
        update_env(auth_token, ct0)
        print()
        print('✅ Setup complete! Tokens saved to .env')
        print(f'   auth_token: {auth_token[:8]}****')
        print(f'   ct0:        {ct0[:8]}****')
        print()
        print('Your browser profile is saved. Future refreshes will be automatic.')
    else:
        print()
        print('⚠  Could not extract tokens. Make sure you logged in fully.')
        print('   Try running --setup again.')
        sys.exit(1)


async def refresh_tokens():
    """Headless: open saved profile, navigate to Twitter, extract fresh cookies."""
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        print('FAILED: Playwright not installed')
        sys.exit(1)

    if not os.path.exists(PROFILE_DIR):
        print('FAILED: No saved browser profile. Run with --setup first.')
        sys.exit(1)

    async with async_playwright() as p:
        context = await p.chromium.launch_persistent_context(
            PROFILE_DIR,
            headless=True,
            args=['--disable-blink-features=AutomationControlled'],
        )

        page = context.pages[0] if context.pages else await context.new_page()

        try:
            # Navigate to Twitter — the saved profile should auto-login
            await page.goto('https://x.com/home', wait_until='networkidle', timeout=30000)
            # Give it a moment to settle
            await page.wait_for_timeout(3000)
        except Exception as e:
            print(f'FAILED: {e}')
            await context.close()
            sys.exit(1)

        # Extract cookies
        cookies = await context.cookies('https://x.com')
        auth_token = next((c['value'] for c in cookies if c['name'] == 'auth_token'), None)
        ct0 = next((c['value'] for c in cookies if c['name'] == 'ct0'), None)

        await context.close()

    if auth_token and ct0:
        update_env(auth_token, ct0)
        print('SUCCESS')
    else:
        print('FAILED: No valid tokens in browser profile. Re-run with --setup.')
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description='Refresh Twitter session tokens')
    parser.add_argument('--setup', action='store_true',
                        help='Open browser for initial login (run once)')
    args = parser.parse_args()

    if args.setup:
        asyncio.run(setup_profile())
    else:
        asyncio.run(refresh_tokens())


if __name__ == '__main__':
    main()
