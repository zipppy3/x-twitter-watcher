"""Launch a headless Camoufox Playwright server for the watcher daemon.

The Node side (src/adapters/camoufox-browser.ts) spawns this script, reads the
"Websocket endpoint: ws://..." line it prints, and connects with playwright-core.

The script exits as soon as its stdin closes, so the browser can never outlive
the daemon, even when the daemon is killed without a chance to clean up.
"""

import os
import sys
import threading

from camoufox.server import launch_server


def _exit_when_parent_goes_away() -> None:
    try:
        while sys.stdin.buffer.read(4096):
            pass
    except Exception:
        pass
    # Exiting closes the pipe to the Playwright driver, which shuts the browser down.
    os._exit(0)


if __name__ == "__main__":
    threading.Thread(target=_exit_when_parent_goes_away, daemon=True).start()
    launch_server(
        headless=True,
        firefox_user_prefs={
            # Screenshots are dark-themed. Playwright's per-context colorScheme is not
            # honoured here, so without this the theme follows whatever the host OS
            # uses (dark on a desktop, light on a server). 0 = dark.
            "layout.css.prefers-color-scheme.content-override": 0,
            "ui.systemUsesDarkTheme": 1,
        },
    )
