import fs from 'node:fs';
import path from 'node:path';
import axios, { AxiosError, AxiosInstance, AxiosResponse } from 'axios';
import FormData from 'form-data';
import { AppConfig, HealthReporter, TelegramClient, TelegramMediaItem } from '../types';
import { rootLogger } from '../runtime/logger';
import { sleep } from '../utils/async';

const PUBLIC_API = 'https://api.telegram.org';

function safeThreadId(threadId?: string | null): string | null {
  if (!threadId) {
    return null;
  }
  const value = Number(threadId);
  return Number.isFinite(value) && value > 0 ? String(value) : null;
}

function isFallbackCandidate(error: AxiosError): boolean {
  return ['ECONNREFUSED', 'ECONNRESET'].includes(error.code || '');
}

export class TelegramBotApiClient implements TelegramClient {
  private readonly logger = rootLogger.child('telegram');

  private readonly http: AxiosInstance;

  /** Telegram's explanation of the most recent failed request. */
  private lastFailureDescription: string | null = null;

  /** Topic used for notices once the General topic turned out to be closed. */
  private closedGeneralFallback: string | null = null;

  constructor(private readonly config: AppConfig, http?: AxiosInstance, private readonly health?: HealthReporter) {
    this.http = http ?? axios.create();
  }

  isConfigured(): boolean {
    return Boolean(this.config.telegramBotToken && this.config.telegramChatId);
  }

  async sendMessage(message: string, threadId?: string | null): Promise<boolean> {
    if (!this.isConfigured()) {
      return false;
    }

    const send = (thread: string | null): Promise<boolean> => {
      const payload: Record<string, string | boolean> = {
        chat_id: this.config.telegramChatId!,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      };
      if (thread) {
        payload.message_thread_id = thread;
      }
      return this.requestWithFallback((baseUrl) =>
        this.http.post(`${baseUrl}/bot${this.config.telegramBotToken}/sendMessage`, payload, { timeout: 10000 })
      );
    };

    const explicit = safeThreadId(threadId);
    if (explicit) {
      return send(explicit);
    }

    // A notice with no topic of its own (started/stopped, Space live, health alerts).
    const noticeThread = safeThreadId(this.config.telegramStatusThreadId) ?? this.closedGeneralFallback;
    if (noticeThread) {
      return send(noticeThread);
    }

    if (await send(null)) {
      return true;
    }

    // In a forum group whose General topic is closed, Telegram rejects every
    // message without a topic. Rather than lose all notices (including health
    // alerts), post them in a topic that is known to be open.
    if (this.lastFailureDescription?.includes('TOPIC_CLOSED')) {
      const fallback = [
        this.config.telegramMetadataThreadId,
        this.config.telegramTweetMetadataThreadId,
        this.config.telegramAudioThreadId,
        this.config.telegramTweetThreadId,
      ]
        .map((id) => safeThreadId(id))
        .find(Boolean);
      if (fallback) {
        this.closedGeneralFallback = fallback;
        this.logger.warn(
          'The General topic of the Telegram group is closed; watcher notices will go to another topic. Set TELEGRAM_STATUS_THREAD_ID to choose which.',
          { topic: fallback }
        );
        return send(fallback);
      }
    }

    return false;
  }

  async sendPhoto(filePath: string, caption?: string, threadId?: string | null): Promise<boolean> {
    return this.uploadFile('sendPhoto', 'photo', filePath, {
      caption,
      threadId,
      timeout: 30000,
    });
  }

  async sendVideo(filePath: string, caption?: string, threadId?: string | null): Promise<boolean> {
    return this.uploadFile('sendVideo', 'video', filePath, {
      caption,
      threadId,
      timeout: 120000,
      extraFields: {
        supports_streaming: 'true',
      },
    });
  }

  async sendDocument(filePath: string, threadId?: string | null): Promise<boolean> {
    return this.uploadFile('sendDocument', 'document', filePath, {
      threadId,
      timeout: 30000,
    });
  }

  async sendAudio(
    filePath: string,
    options: { title?: string; performer?: string; durationSec?: number; threadId?: string | null } = {}
  ): Promise<boolean> {
    const result = await this.uploadFile('sendAudio', 'audio', filePath, {
      threadId: options.threadId,
      timeout: 120000,
      extraFields: {
        title: options.title || '',
        performer: options.performer || '',
        duration: options.durationSec ? String(options.durationSec) : '',
      },
      onFallbackFailure: async (error) => {
        if (error.response?.status !== 413) {
          return;
        }

        await this.sendMessage(
          `❌ <b>Upload failed</b>\n\n<code>${path.basename(filePath)}</code> is too large for the public Telegram Bot API (50 MB limit).\nIs the local Bot API server running?`
        );
      },
    });

    return result;
  }

  async sendMediaGroup(items: TelegramMediaItem[], caption?: string, threadId?: string | null): Promise<boolean> {
    if (!this.isConfigured() || !items.length) {
      return false;
    }

    const validItems = items.filter((item) => fs.existsSync(item.path));
    if (!validItems.length) {
      return false;
    }

    if (validItems.length === 1) {
      const [item] = validItems;
      return item.type === 'video'
        ? this.sendVideo(item.path, caption, threadId)
        : this.sendPhoto(item.path, caption, threadId);
    }

    const limitedItems = validItems.slice(0, 10);
    if (validItems.length > 10) {
      this.logger.warn('Media group capped at 10 items', {
        total: validItems.length,
        dropped: validItems.length - 10,
      });
    }
    return this.requestWithFallback(async (baseUrl) => {
      const form = new FormData();
      form.append('chat_id', this.config.telegramChatId!);

      const safe = safeThreadId(threadId);
      if (safe) {
        form.append('message_thread_id', safe);
      }

      const media = limitedItems.map((item, index) => {
        const attachKey = `file${index}`;
        form.append(attachKey, fs.createReadStream(item.path));

        const entry: Record<string, string> = {
          type: item.type,
          media: `attach://${attachKey}`,
        };

        if (index === 0 && caption) {
          entry.caption = caption.substring(0, 1024);
          entry.parse_mode = 'HTML';
        }

        return entry;
      });

      form.append('media', JSON.stringify(media));

      return this.http.post(`${baseUrl}/bot${this.config.telegramBotToken}/sendMediaGroup`, form, {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: 120000,
      });
    });
  }

  private get apiUrl(): string {
    return this.config.telegramApiUrl.replace(/\/+$/, '');
  }

  private get isLocalServerConfigured(): boolean {
    return this.apiUrl !== PUBLIC_API && this.apiUrl.startsWith('http://');
  }

  private async uploadFile(
    endpoint: string,
    fieldName: string,
    filePath: string,
    options: {
      caption?: string;
      threadId?: string | null;
      timeout: number;
      extraFields?: Record<string, string>;
      onFallbackFailure?: (error: AxiosError) => Promise<void>;
    }
  ): Promise<boolean> {
    if (!this.isConfigured() || !fs.existsSync(filePath)) {
      return false;
    }

    return this.requestWithFallback(async (baseUrl) => {
      const form = new FormData();
      form.append('chat_id', this.config.telegramChatId!);

      const safe = safeThreadId(options.threadId);
      if (safe) {
        form.append('message_thread_id', safe);
      }

      form.append(fieldName, fs.createReadStream(filePath));

      if (options.caption) {
        form.append('caption', options.caption.substring(0, 1024));
        form.append('parse_mode', 'HTML');
      }

      for (const [key, value] of Object.entries(options.extraFields ?? {})) {
        if (value) {
          form.append(key, value);
        }
      }

      return this.http.post(`${baseUrl}/bot${this.config.telegramBotToken}/${endpoint}`, form, {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        timeout: options.timeout,
      });
    }, options.onFallbackFailure);
  }

  private async requestWithFallback<T>(
    request: (baseUrl: string) => Promise<AxiosResponse<T>>,
    onFallbackFailure?: (error: AxiosError) => Promise<void>
  ): Promise<boolean> {
    const delivered = await this.tryRequest(request, onFallbackFailure);
    if (delivered) {
      this.health?.ok('telegram');
    } else {
      this.health?.fail('telegram', 'Telegram request failed');
    }
    return delivered;
  }

  private async tryRequest<T>(
    request: (baseUrl: string) => Promise<AxiosResponse<T>>,
    onFallbackFailure?: (error: AxiosError) => Promise<void>,
    retried = false
  ): Promise<boolean> {
    try {
      const response = await request(this.apiUrl);
      return response.status === 200;
    } catch (error) {
      const axiosError = error as AxiosError;
      const body = axiosError.response?.data as { description?: string; parameters?: { retry_after?: number } } | undefined;
      this.lastFailureDescription = body?.description ?? null;

      // Rate limited: Telegram says how long to wait. One patient retry beats dropping the message.
      const retryAfter = axiosError.response?.status === 429 ? Number(body?.parameters?.retry_after) : NaN;
      if (!retried && Number.isFinite(retryAfter)) {
        const waitSeconds = Math.min(Math.max(retryAfter, 1), 60);
        this.logger.warn('Telegram rate limit hit, retrying after the requested pause', { waitSeconds });
        await sleep(waitSeconds * 1000 + 500);
        return this.tryRequest(request, onFallbackFailure, true);
      }
      if (this.isLocalServerConfigured && isFallbackCandidate(axiosError)) {
        this.logger.warn('Local Telegram API unavailable, falling back to public API');
        try {
          const response = await request(PUBLIC_API);
          return response.status === 200;
        } catch (fallbackError) {
          if (onFallbackFailure) {
            await onFallbackFailure(fallbackError as AxiosError);
          }
          this.logger.error('Telegram fallback request failed', {
            message: (fallbackError as Error).message,
          });
          return false;
        }
      }

      if (onFallbackFailure) {
        await onFallbackFailure(axiosError);
      }
      this.logger.error('Telegram request failed', {
        message: axiosError.message,
        status: axiosError.response?.status,
        // Telegram's own explanation, e.g. "Bad Request: PHOTO_INVALID_DIMENSIONS".
        description: body?.description,
      });
      return false;
    }
  }
}
