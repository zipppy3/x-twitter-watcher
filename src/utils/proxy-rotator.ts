import { rootLogger } from '../runtime/logger';

export interface PlaywrightProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

interface ProxyEntry {
  raw: string;
  server: string;
  username?: string;
  password?: string;
  failureCount: number;
  lastFailure: number | null;
}

/**
 * Round-robin proxy rotator with failure tracking.
 * Supports HTTP, HTTPS, and SOCKS5 proxy URLs.
 *
 * Accepted formats:
 *   http://host:port
 *   https://host:port
 *   socks5://host:port
 *   http://user:pass@host:port
 *   socks5://user:pass@host:port
 */
export class ProxyRotator {
  private readonly logger = rootLogger.child('proxy');
  private readonly proxies: ProxyEntry[] = [];
  private index = 0;
  private readonly isRotatingEndpoint: boolean;

  /** Maximum consecutive failures before skipping a proxy temporarily */
  private static readonly MAX_FAILURES = 5;
  /** Cooldown period after which a failed proxy is retried (ms) */
  private static readonly COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

  constructor(proxyUrls: string[], isRotatingEndpoint: boolean = false) {
    this.isRotatingEndpoint = isRotatingEndpoint;
    for (const raw of proxyUrls) {
      const trimmed = raw.trim();
      if (!trimmed) continue;

      const parsed = this.parseProxyUrl(trimmed);
      if (parsed) {
        this.proxies.push(parsed);
      } else {
        this.logger.warn('Invalid proxy URL, skipping', { url: trimmed });
      }
    }

    if (this.proxies.length > 0) {
      this.logger.info('Proxy rotator initialized', { count: this.proxies.length });
    }
  }

  get size(): number {
    return this.proxies.length;
  }

  get enabled(): boolean {
    return this.proxies.length > 0;
  }

  /**
   * Get the next available proxy config for Playwright/Camoufox.
   * Returns `null` if no proxies are configured or all are in cooldown.
   */
  next(): PlaywrightProxyConfig | null {
    if (!this.proxies.length) return null;

    const now = Date.now();
    const startIndex = this.index;

    // Walk through proxies round-robin to find one that is available
    for (let attempts = 0; attempts < this.proxies.length; attempts++) {
      const proxy = this.proxies[this.index % this.proxies.length];
      this.index = (this.index + 1) % this.proxies.length;

      // Check if proxy is in cooldown
      if (
        !this.isRotatingEndpoint &&
        proxy.failureCount >= ProxyRotator.MAX_FAILURES &&
        proxy.lastFailure &&
        now - proxy.lastFailure < ProxyRotator.COOLDOWN_MS
      ) {
        continue; // Skip this proxy
      }

      // Reset failure count if cooldown expired
      if (
        proxy.failureCount >= ProxyRotator.MAX_FAILURES &&
        proxy.lastFailure &&
        now - proxy.lastFailure >= ProxyRotator.COOLDOWN_MS
      ) {
        proxy.failureCount = 0;
        proxy.lastFailure = null;
        this.logger.info('Proxy cooldown expired, retrying', { proxy: proxy.server });
      }

      const config: PlaywrightProxyConfig = { server: proxy.server };
      if (proxy.username) config.username = proxy.username;
      if (proxy.password) config.password = proxy.password;
      return config;
    }

    this.logger.warn('All proxies are in cooldown, returning null');
    return null;
  }

  /**
   * Mark a proxy as having failed. Call after a request through it fails.
   */
  markFailed(proxyServer: string): void {
    const proxy = this.proxies.find((p) => p.server === proxyServer);
    if (proxy) {
      proxy.failureCount += 1;
      proxy.lastFailure = Date.now();
      this.logger.warn('Proxy marked as failed', {
        proxy: proxyServer,
        failures: proxy.failureCount,
      });
    }
  }

  /**
   * Mark a proxy as successful — resets its failure counter.
   */
  markSuccess(proxyServer: string): void {
    const proxy = this.proxies.find((p) => p.server === proxyServer);
    if (proxy && proxy.failureCount > 0) {
      proxy.failureCount = 0;
      proxy.lastFailure = null;
    }
  }

  private parseProxyUrl(raw: string): ProxyEntry | null {
    try {
      const url = new URL(raw);
      const protocol = url.protocol.replace(':', ''); // http, https, socks5

      if (!['http', 'https', 'socks5'].includes(protocol)) {
        return null;
      }

      const server = `${protocol}://${url.hostname}${url.port ? ':' + url.port : ''}`;
      return {
        raw,
        server,
        username: url.username || undefined,
        password: url.password || undefined,
        failureCount: 0,
        lastFailure: null,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Factory: creates a ProxyRotator if proxy is enabled and the list is non-empty.
 */
export function createProxyRotator(proxyEnabled: boolean, proxyList: string[], isRotatingEndpoint: boolean = false): ProxyRotator {
  if (!proxyEnabled || !proxyList.length) {
    return new ProxyRotator([]);
  }
  return new ProxyRotator(proxyList, isRotatingEndpoint);
}
