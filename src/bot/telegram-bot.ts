import TelegramBot from 'node-telegram-bot-api';
import { AppConfig, WatcherStatus } from '../types';
import { rootLogger } from '../runtime/logger';
import { deleteUserDownloads, DeleteTarget } from '../services/download-manager';
import { WatchlistService, normalizeUsername } from '../services/watchlist-service';
import { escapeHtml } from '../utils/html';

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

export class TelegramControlBot {
  private readonly logger = rootLogger.child('control-bot');

  private bot: TelegramBot | null = null;

  constructor(
    private readonly config: AppConfig,
    private readonly watchlistService: WatchlistService,
    private readonly statusProvider: () => WatcherStatus
  ) {}

  async start(): Promise<void> {
    if (!this.config.telegramBotToken || !this.config.telegramChatId || this.bot) {
      return;
    }

    this.bot = new TelegramBot(this.config.telegramBotToken, { polling: true });
    this.bot.on('message', async (message) => {
      const incomingChatId = String(message.chat.id);
      if (incomingChatId !== String(this.config.telegramChatId)) {
        return;
      }

      const text = (message.text || '').trim();
      if (!text.startsWith('/')) {
        return;
      }

      const [command, ...args] = text.split(/\s+/);
      switch (command.toLowerCase().split('@')[0]) {
        case '/add':
          await this.handleAdd(message.chat.id, args);
          break;
        case '/remove':
          await this.handleRemove(message.chat.id, args);
          break;
        case '/list':
          await this.handleList(message.chat.id);
          break;
        case '/config':
          await this.handleConfig(message.chat.id, args);
          break;
        case '/status':
          await this.handleStatus(message.chat.id);
          break;
        case '/delete':
          await this.handleDelete(message.chat.id, args);
          break;
        case '/help':
        case '/start':
          await this.handleHelp(message.chat.id);
          break;
        default:
          await this.bot?.sendMessage(message.chat.id, 'Unknown command. Use /help.', { parse_mode: 'HTML' });
          break;
      }
    });

    this.bot.on('polling_error', (error) => {
      this.logger.warn('Polling error', { message: error.message });
    });
  }

  async stop(): Promise<void> {
    if (this.bot) {
      await this.bot.stopPolling();
      this.bot = null;
    }
  }

  private async handleAdd(chatId: number, args: string[]): Promise<void> {
    if (!args.length) {
      await this.bot?.sendMessage(
        chatId,
        '<b>Usage:</b>\n<code>/add username</code>\n<code>/add username spaces</code>\n<code>/add username tweets</code>\n<code>/add username tweets replies</code>',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const username = normalizeUsername(args[0]);
    const { mode, watchReplies } = parseAddMode(args.slice(1));
    const target = this.watchlistService.add(username, mode, watchReplies);
    const watching: string[] = [];
    if (target.watchSpaces) {
      watching.push('Spaces');
    }
    if (target.watchTweets) {
      watching.push('Tweets');
    }
    if (target.watchReplies) {
      watching.push('Replies');
    }

    await this.bot?.sendMessage(chatId, `<b>Added @${username}</b>\nWatching: ${watching.join(' + ')}`, {
      parse_mode: 'HTML',
    });
  }

  private async handleRemove(chatId: number, args: string[]): Promise<void> {
    if (!args.length) {
      await this.bot?.sendMessage(chatId, '<b>Usage:</b> <code>/remove username</code>', { parse_mode: 'HTML' });
      return;
    }

    const username = normalizeUsername(args[0]);
    const removed = this.watchlistService.remove(username);
    await this.bot?.sendMessage(
      chatId,
      removed ? `<b>Removed @${username}</b>` : `@${username} was not in the watchlist.`,
      { parse_mode: 'HTML' }
    );
  }

  private async handleList(chatId: number): Promise<void> {
    const users = this.watchlistService.list();
    if (!users.length) {
      await this.bot?.sendMessage(chatId, '<b>Watchlist is empty.</b>', { parse_mode: 'HTML' });
      return;
    }

    const lines = users.map((target) => {
      const flags = [];
      if (target.watchSpaces) {
        flags.push('Spaces');
      }
      if (target.watchTweets) {
        flags.push('Tweets');
      }
      if (target.watchReplies) {
        flags.push('Replies');
      }
      const saveIcons = [
        target.saveMedia ? '🖼' : '',
        target.saveScreenshots ? '📸' : '',
        target.saveMetadata ? '📄' : '',
      ].filter(Boolean).join('');
      const userId = target.userId ? ` <code>[${target.userId}]</code>` : '';
      return `- <b>@${target.username}</b>${userId}\n  ${flags.join(', ')}  ${saveIcons || '(saves disabled)'}`;
    });

    await this.bot?.sendMessage(chatId, `<b>Watchlist (${users.length} users)</b>\n\n${lines.join('\n\n')}`, {
      parse_mode: 'HTML',
    });
  }

  private async handleStatus(chatId: number): Promise<void> {
    const status = this.statusProvider();
    const message =
      `<b>Watcher Status</b>\n\n` +
      `State: ${status.state}\n` +
      `Mode: ${status.mode}\n` +
      `Uptime: ${status.uptime}\n` +
      `Spaces: ${status.spaceUsers}\n` +
      `Tweets: ${status.tweetUsers}\n` +
      `Reply watchers: ${status.replyUsers}\n` +
      `Polls: ${status.pollCount}\n` +
      `Seen tweets: ${status.totalSeenTweets}\n` +
      `Recordings: ${status.totalRecordings}\n` +
      `Active spaces: ${status.activeSpaces.length ? status.activeSpaces.map((space) => `"${escapeHtml(space.title)}"`).join(', ') : 'none'}\n` +
      `Last error: ${status.lastError ? escapeHtml(status.lastError) : 'none'}`;

    await this.bot?.sendMessage(chatId, message, { parse_mode: 'HTML' });
  }

  private async handleDelete(chatId: number, args: string[]): Promise<void> {
    if (!args.length) {
      await this.bot?.sendMessage(
        chatId,
        '<b>Usage:</b>\n<code>/delete username tweets</code>\n<code>/delete username spaces</code>\n<code>/delete username all</code>',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const username = normalizeUsername(args[0]);
    const target = ((args[1] || 'all').toLowerCase() as DeleteTarget) || 'all';
    if (!['tweets', 'spaces', 'all'].includes(target)) {
      await this.bot?.sendMessage(chatId, 'Invalid delete target. Use tweets, spaces, or all.', {
        parse_mode: 'HTML',
      });
      return;
    }

    const result = deleteUserDownloads(this.config.downloadRoot, username, target);
    const freedMb = (result.freedBytes / (1024 * 1024)).toFixed(1);
    await this.bot?.sendMessage(
      chatId,
      result.deletedCount
        ? `<b>Deleted ${target} data for @${username}</b>\nFiles removed: ${result.deletedCount}\nFreed: ${freedMb} MB`
        : `No downloaded data found for @${username}.`,
      { parse_mode: 'HTML' }
    );
  }

  private async handleHelp(chatId: number): Promise<void> {
    await this.bot?.sendMessage(
      chatId,
      `<b>X Watcher v2 Commands</b>\n\n` +
        `/add username\n` +
        `/add username spaces\n` +
        `/add username tweets\n` +
        `/add username tweets replies\n` +
        `/remove username\n` +
        `/list\n` +
        `/config username\n` +
        `/config username media on|off\n` +
        `/config username screenshots on|off\n` +
        `/config username metadata on|off\n` +
        `/config username all on|off\n` +
        `/status\n` +
        `/delete username tweets\n` +
        `/delete username spaces\n` +
        `/delete username all\n` +
        `/help`,
      { parse_mode: 'HTML' }
    );
  }

  private async handleConfig(chatId: number, args: string[]): Promise<void> {
    if (!args.length) {
      await this.bot?.sendMessage(
        chatId,
        '<b>Usage:</b>\n' +
          '<code>/config username</code> — view save settings\n' +
          '<code>/config username media on|off</code>\n' +
          '<code>/config username screenshots on|off</code>\n' +
          '<code>/config username metadata on|off</code>\n' +
          '<code>/config username all on|off</code>',
        { parse_mode: 'HTML' }
      );
      return;
    }

    const username = normalizeUsername(args[0]);
    const target = this.watchlistService.get(username);
    if (!target) {
      await this.bot?.sendMessage(chatId, `@${username} is not in the watchlist.`, { parse_mode: 'HTML' });
      return;
    }

    // View mode: just show current settings
    if (args.length < 3) {
      const icon = (v: boolean) => v ? '✅' : '❌';
      await this.bot?.sendMessage(
        chatId,
        `<b>Save settings for @${username}</b>\n\n` +
          `${icon(target.saveMedia)} Media (images/videos)\n` +
          `${icon(target.saveScreenshots)} Screenshots\n` +
          `${icon(target.saveMetadata)} Metadata (JSON)`,
        { parse_mode: 'HTML' }
      );
      return;
    }

    const field = args[1].toLowerCase();
    const value = args[2].toLowerCase();
    const enabled = value === 'on' || value === 'true' || value === '1' || value === 'yes';

    const validFields = ['media', 'screenshots', 'metadata', 'all'];
    if (!validFields.includes(field)) {
      await this.bot?.sendMessage(chatId, `Invalid field. Use: ${validFields.join(', ')}`, { parse_mode: 'HTML' });
      return;
    }

    const updates: { saveMedia?: boolean; saveScreenshots?: boolean; saveMetadata?: boolean } = {};
    if (field === 'media' || field === 'all') updates.saveMedia = enabled;
    if (field === 'screenshots' || field === 'all') updates.saveScreenshots = enabled;
    if (field === 'metadata' || field === 'all') updates.saveMetadata = enabled;

    this.watchlistService.update(username, updates);

    const updated = this.watchlistService.get(username)!;
    const icon = (v: boolean) => v ? '✅' : '❌';
    await this.bot?.sendMessage(
      chatId,
      `<b>Updated @${username}</b>\n\n` +
        `${icon(updated.saveMedia)} Media\n` +
        `${icon(updated.saveScreenshots)} Screenshots\n` +
        `${icon(updated.saveMetadata)} Metadata`,
      { parse_mode: 'HTML' }
    );
  }
}
