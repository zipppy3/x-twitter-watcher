import { Bot } from 'node-telegram-bot-api';
import { AppConfig, WatcherStatus } from '../types';
import { rootLogger } from '../runtime/logger';
import { deleteUserDownloads, DeleteTarget } from '../services/download-manager';
import { WatchlistService, normalizeUsername } from '../services/watchlist-service';
import { escapeHtml } from '../utils/html';
import { ScreenshotRetryService } from '../services/screenshot-retry';
import { buildFailedScreenshotList } from '../services/telegram-messages';

function parseAddMode(args: string[]): { mode: 'all' | 'spaces' | 'tweets'; watchReplies: boolean } {
  const flags = args.map((arg) => arg.toLowerCase());
  const mode = flags.find((flag) => flag === 'all' || flag === 'spaces' || flag === 'tweets') as
    | 'all'
    | 'spaces'
    | 'tweets'
    | undefined;
  return {
    mode: mode ?? 'all',
    watchReplies: flags.includes('replies'),
  };
}

/** Sends an HTML reply into the chat (and forum topic) the command came from. */
type Reply = (html: string) => Promise<void>;

export class TelegramControlBot {
  private readonly logger = rootLogger.child('control-bot');

  private bot: Bot | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly watchlistService: WatchlistService,
    private readonly statusProvider: () => WatcherStatus,
    private readonly screenshotRetry?: ScreenshotRetryService
  ) {}

  async start(): Promise<void> {
    if (!this.config.telegramBotToken || !this.config.telegramChatId || this.bot) {
      return;
    }

    const bot = new Bot(this.config.telegramBotToken);
    this.bot = bot;

    bot.on('message', async (ctx) => {
      const message = ctx.message;
      if (!message || String(message.chat.id) !== String(this.config.telegramChatId)) {
        return;
      }

      const text = (message.text || '').trim();
      if (!text.startsWith('/')) {
        return;
      }

      const threadId = message.is_topic_message ? message.message_thread_id : undefined;
      const reply: Reply = async (html) => {
        await ctx.reply(html, {
          parse_mode: 'HTML',
          ...(threadId ? { message_thread_id: threadId } : {}),
        });
      };

      const [command, ...args] = text.split(/\s+/);
      try {
        switch (command.toLowerCase().split('@')[0]) {
          case '/add':
            await this.handleAdd(reply, args);
            break;
          case '/remove':
            await this.handleRemove(reply, args);
            break;
          case '/list':
            await this.handleList(reply);
            break;
          case '/config':
            await this.handleConfig(reply, args);
            break;
          case '/status':
            await this.handleStatus(reply);
            break;
          case '/delete':
            await this.handleDelete(reply, args);
            break;
          case '/retry':
            await this.handleRetry(reply, args, message.reply_to_message?.message_id);
            break;
          case '/help':
          case '/start':
            await this.handleHelp(reply);
            break;
          default:
            await reply('❓ Unknown command. Use /help.');
            break;
        }
      } catch (error) {
        // A bad argument (e.g. an invalid username) must never take the daemon down.
        this.logger.warn('Command failed', { command, message: (error as Error).message });
        await reply(`⚠️ ${escapeHtml((error as Error).message)}`).catch(() => undefined);
      }
    });

    bot.catch((error) => {
      this.logger.error('Control bot handler error', { message: (error as Error)?.message ?? String(error) });
    });

    // Resolves only when polling stops, so it is deliberately not awaited.
    bot
      .startPolling(undefined, {
        onError: (error) => {
          this.logger.warn('Polling error', { message: (error as Error)?.message ?? String(error) });
        },
      })
      .catch((error) => {
        this.logger.error('Control bot polling stopped', { message: (error as Error)?.message ?? String(error) });
      });
  }

  async stop(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
    }
  }

  private async handleAdd(reply: Reply, args: string[]): Promise<void> {
    if (!args.length) {
      await reply(
        'ℹ️ <b>Usage:</b>\n<code>/add username</code> — Spaces + tweets\n<code>/add username spaces</code>\n<code>/add username tweets</code>\n<code>/add username tweets replies</code>'
      );
      return;
    }

    const username = normalizeUsername(args[0]);
    const { mode, watchReplies } = parseAddMode(args.slice(1));
    const target = this.watchlistService.add(username, mode, watchReplies);
    const watching: string[] = [];
    if (target.watchSpaces) {
      watching.push('🎙 Spaces');
    }
    if (target.watchTweets) {
      watching.push('🐦 Tweets');
    }
    if (target.watchReplies) {
      watching.push('💬 Replies');
    }

    await reply(`✅ <b>Added @${username}</b>\n👀 Watching: ${watching.join(' · ')}`);
  }

  private async handleRemove(reply: Reply, args: string[]): Promise<void> {
    if (!args.length) {
      await reply('ℹ️ <b>Usage:</b> <code>/remove username</code>');
      return;
    }

    const username = normalizeUsername(args[0]);
    const removed = this.watchlistService.remove(username);
    await reply(removed ? `🗑 <b>Removed @${username}</b>` : `ℹ️ @${username} was not in the watchlist.`);
  }

  private async handleList(reply: Reply): Promise<void> {
    const users = this.watchlistService.list();
    if (!users.length) {
      await reply('📋 <b>Watchlist is empty.</b>\nAdd someone with <code>/add username</code>.');
      return;
    }

    const lines = users.map((target) => {
      const flags = [];
      if (target.watchSpaces) {
        flags.push('🎙 Spaces');
      }
      if (target.watchTweets) {
        flags.push('🐦 Tweets');
      }
      if (target.watchReplies) {
        flags.push('💬 Replies');
      }
      const saveIcons = [
        target.saveMedia ? '🖼' : '',
        target.saveScreenshots ? '📸' : '',
        target.saveMetadata ? '📄' : '',
      ].filter(Boolean).join('');
      const userId = target.userId ? ` <code>[${target.userId}]</code>` : '';
      return `• <b>@${target.username}</b>${userId}\n   ${flags.join(' · ') || 'nothing watched'}\n   💾 Saving: ${saveIcons || 'nothing'}`;
    });

    await reply(`📋 <b>Watchlist (${users.length} user${users.length === 1 ? '' : 's'})</b>\n\n${lines.join('\n\n')}\n\n<i>🖼 media · 📸 screenshots · 📄 metadata</i>`);
  }

  private async handleStatus(reply: Reply): Promise<void> {
    const status = this.statusProvider();
    const stateIcon: Record<string, string> = {
      watching: '🟢',
      recording: '🔴',
      downloading: '⬇️',
      idle: '⚪',
      stopped: '🟡',
      error: '⚠️',
    };
    const live = status.activeSpaces.length
      ? status.activeSpaces.map((space) => `"${escapeHtml(space.title)}"`).join(', ')
      : 'none';
    const message =
      `📊 <b>Watcher status</b>\n\n` +
      `${stateIcon[status.state] ?? '⚪'} State: ${status.state}\n` +
      `⏱ Uptime: ${status.uptime}\n` +
      `👀 Watching: ${status.spaceUsers} Spaces · ${status.tweetUsers} tweet accounts (${status.replyUsers} with replies)\n` +
      `🔄 Polls: ${status.pollCount}\n` +
      `🐦 Tweets seen: ${status.totalSeenTweets}\n` +
      `🎙 Recordings: ${status.totalRecordings}\n` +
      `🔴 Live now: ${live}\n` +
      (status.lastError ? `⚠️ Last error: ${escapeHtml(status.lastError)}` : `✅ No errors`);

    await reply(message);
  }

  private async handleDelete(reply: Reply, args: string[]): Promise<void> {
    if (!args.length) {
      await reply(
        'ℹ️ <b>Usage:</b>\n<code>/delete username tweets</code>\n<code>/delete username spaces</code>\n<code>/delete username all</code>'
      );
      return;
    }

    const username = normalizeUsername(args[0]);
    const target = ((args[1] || 'all').toLowerCase() as DeleteTarget) || 'all';
    if (!['tweets', 'spaces', 'all'].includes(target)) {
      await reply('⚠️ Invalid delete target. Use tweets, spaces, or all.');
      return;
    }

    const result = deleteUserDownloads(this.config.downloadRoot, username, target);
    const freedMb = (result.freedBytes / (1024 * 1024)).toFixed(1);
    await reply(
      result.deletedCount
        ? `🗑 <b>Deleted ${target} data for @${username}</b>\nFiles removed: ${result.deletedCount}\nFreed: ${freedMb} MB`
        : `ℹ️ No downloaded data found for @${username}.`
    );
  }

  private async handleRetry(reply: Reply, args: string[], repliedTo?: number): Promise<void> {
    const retry = this.screenshotRetry;
    if (!retry) {
      await reply('ℹ️ Screenshot retry is not available.');
      return;
    }

    let postIds: string[] | null;
    if (args.length === 1 && args[0].toLowerCase() === 'all') {
      postIds = null;
    } else if (args.length) {
      const ids = args.map((arg) => arg.match(/(\d{5,})/)?.[1]).filter((id): id is string => Boolean(id));
      if (!ids.length) {
        await reply('ℹ️ <b>Usage:</b> <code>/retry</code> (list) · <code>/retry tweet-id-or-link</code> · <code>/retry all</code>');
        return;
      }
      postIds = ids.flatMap((id) => retry.find({ postId: id }));
      if (!postIds.length) {
        await reply('ℹ️ No failed screenshot is waiting for that tweet. <code>/retry</code> lists the ones that are.');
        return;
      }
    } else {
      const replied = repliedTo ? retry.find({ messageId: repliedTo }) : [];
      if (!replied.length) {
        await reply(buildFailedScreenshotList(retry.pending()));
        return;
      }
      postIds = replied;
    }

    const count = new Set(postIds ?? retry.pending().map((item) => item.postId)).size;
    if (!count) {
      await reply(buildFailedScreenshotList([]));
      return;
    }
    if (retry.isBusy) {
      await reply('⏳ A retry is already running. Try again when it has finished.');
      return;
    }

    await reply(`⏳ Retrying ${count} post${count === 1 ? '' : 's'}… the screenshots follow as replies to the posts.`);

    // Several screenshots can take minutes; the chat should not wait on this handler.
    void retry
      .retry(postIds)
      .then(async (outcomes) => {
        if (!outcomes) {
          return;
        }
        const failed = outcomes.filter((outcome) => !outcome.ok);
        const lines = [`📸 <b>Retry finished</b>: ${outcomes.length - failed.length} of ${outcomes.length} done`];
        for (const outcome of failed) {
          lines.push(`❌ @${escapeHtml(outcome.username)} · <code>/retry ${outcome.postId}</code>`);
        }
        await reply(lines.join('\n'));
      })
      .catch((error) => {
        this.logger.warn('Screenshot retry failed', { message: (error as Error).message });
        return reply(`⚠️ ${escapeHtml((error as Error).message)}`).catch(() => undefined);
      });
  }

  private async handleHelp(reply: Reply): Promise<void> {
    await reply(
      `❓ <b>X Watcher commands</b>\n\n` +
        `<b>➕ Watch someone</b>\n` +
        `/add username — Spaces + tweets\n` +
        `/add username spaces\n` +
        `/add username tweets\n` +
        `/add username tweets replies\n\n` +
        `<b>➖ Stop watching</b>\n` +
        `/remove username\n\n` +
        `<b>📋 Overview</b>\n` +
        `/list — who is being watched\n` +
        `/status — is everything working\n\n` +
        `<b>⚙️ What gets saved</b>\n` +
        `/config username — show settings\n` +
        `/config username media|screenshots|metadata|all on|off\n\n` +
        `<b>🗑 Delete downloaded files</b>\n` +
        `/delete username tweets|spaces|all\n\n` +
        `<b>📸 Failed screenshots</b>\n` +
        `/retry — list posts whose screenshot failed\n` +
        `/retry tweet-id-or-link — try that one again\n` +
        `/retry id1 id2 … — a few at once\n` +
        `/retry all — every one that is waiting\n` +
        `Or reply to a failure notice with /retry`
    );
  }

  private async handleConfig(reply: Reply, args: string[]): Promise<void> {
    if (!args.length) {
      await reply(
        'ℹ️ <b>Usage:</b>\n' +
          '<code>/config username</code> — view save settings\n' +
          '<code>/config username media on|off</code>\n' +
          '<code>/config username screenshots on|off</code>\n' +
          '<code>/config username metadata on|off</code>\n' +
          '<code>/config username all on|off</code>'
      );
      return;
    }

    const username = normalizeUsername(args[0]);
    const target = this.watchlistService.get(username);
    if (!target) {
      await reply(`ℹ️ @${username} is not in the watchlist.`);
      return;
    }

    // View mode: just show current settings
    if (args.length < 3) {
      const icon = (v: boolean) => v ? '✅' : '❌';
      await reply(
        `⚙️ <b>Save settings for @${username}</b>\n\n` +
          `${icon(target.saveMedia)} Media (images/videos)\n` +
          `${icon(target.saveScreenshots)} Screenshots\n` +
          `${icon(target.saveMetadata)} Metadata (JSON)`
      );
      return;
    }

    const field = args[1].toLowerCase();
    const value = args[2].toLowerCase();
    const enabled = value === 'on' || value === 'true' || value === '1' || value === 'yes';

    const validFields = ['media', 'screenshots', 'metadata', 'all'];
    if (!validFields.includes(field)) {
      await reply(`⚠️ Invalid field. Use: ${validFields.join(', ')}`);
      return;
    }

    const updates: { saveMedia?: boolean; saveScreenshots?: boolean; saveMetadata?: boolean } = {};
    if (field === 'media' || field === 'all') updates.saveMedia = enabled;
    if (field === 'screenshots' || field === 'all') updates.saveScreenshots = enabled;
    if (field === 'metadata' || field === 'all') updates.saveMetadata = enabled;

    this.watchlistService.update(username, updates);

    const updated = this.watchlistService.get(username)!;
    const icon = (v: boolean) => v ? '✅' : '❌';
    await reply(
      `⚙️ <b>Updated @${username}</b>\n\n` +
        `${icon(updated.saveMedia)} Media\n` +
        `${icon(updated.saveScreenshots)} Screenshots\n` +
        `${icon(updated.saveMetadata)} Metadata`
    );
  }
}
