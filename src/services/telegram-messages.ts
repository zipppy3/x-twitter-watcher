import { SpaceLiveEvent, SpaceRecordedEvent, Tweet } from '../types';
import { escapeHtml } from '../utils/html';

/**
 * Telegram cuts media captions at 1024 characters. Messages are built to stay
 * under that, so a cut can never land inside an HTML tag (which would make
 * Telegram reject the whole message).
 */
const MAX_LENGTH = 1000;

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function preview(text: string, max: number): string {
  // A trailing t.co link is just X's pointer to the attached media or quoted post.
  const clean = (text || '').trim().replace(/\s*https:\/\/t\.co\/\w+$/, '');
  return escapeHtml(clean.length > max ? `${clean.slice(0, max).trimEnd()}…` : clean);
}

export function formatTimestamp(value: string | number | Date): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${hours}:${minutes} UTC`;
}

function authorLine(tweet: Tweet, fallbackUsername: string): string {
  const handle = escapeHtml(tweet.author.username || fallbackUsername);
  const name = tweet.author.displayName?.trim();
  return name ? `<b>${escapeHtml(name)}</b> (@${handle})` : `<b>@${handle}</b>`;
}

function mediaSummary(tweets: Tweet[]): string | null {
  let photos = 0;
  let videos = 0;
  let gifs = 0;
  for (const tweet of tweets) {
    for (const item of tweet.media || []) {
      if (item.type === 'photo') photos += 1;
      else if (item.type === 'animated_gif') gifs += 1;
      else videos += 1;
    }
  }
  const parts = [
    photos ? `${photos} photo${photos === 1 ? '' : 's'}` : null,
    videos ? `${videos} video${videos === 1 ? '' : 's'}` : null,
    gifs ? `${gifs} GIF${gifs === 1 ? '' : 's'}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(' · ') : null;
}

function link(username: string, tweetId: string): string {
  return `🔗 <a href="https://x.com/${encodeURIComponent(username)}/status/${tweetId}">Open on X</a>`;
}

/** Try progressively shorter previews until the message fits a caption. */
function fit(build: (size: number) => string): string {
  let message = '';
  for (const size of [280, 160, 80, 30]) {
    message = build(size);
    if (message.length <= MAX_LENGTH) {
      break;
    }
  }
  return message;
}

export function buildTweetMessage(tweet: Tweet, watchedUsername: string): string {
  const quoted = tweet.quotedTweet;
  const parent = tweet.inReplyToTweet;
  const isReply = Boolean(tweet.inReplyToUsername || parent);
  const title = isReply ? '💬 <b>New reply</b>' : quoted ? '🔁 <b>New quote tweet</b>' : '🐦 <b>New tweet</b>';

  return fit((size) => {
    const context = Math.max(30, Math.round(size / 2.5));
    const lines = [`${title} · ${authorLine(tweet, watchedUsername)}`];

    if (isReply) {
      const to = escapeHtml(parent?.author.username || tweet.inReplyToUsername || 'unknown');
      lines.push(parent?.text ? `↪️ to @${to}: <i>“${preview(parent.text, context)}”</i>` : `↪️ to @${to}`);
    }

    lines.push('', tweet.text.trim() ? `<blockquote>${preview(tweet.text, size)}</blockquote>` : '<i>(no text)</i>');

    if (quoted) {
      const by = escapeHtml(quoted.author?.username || 'unknown');
      lines.push(quoted.text ? `🔁 Quoting @${by}: <i>“${preview(quoted.text, context)}”</i>` : `🔁 Quoting @${by}`);
    }

    const media = mediaSummary([tweet]);
    if (media) {
      lines.push(`📎 ${media}`);
    }
    const time = formatTimestamp(tweet.createdAt);
    if (time) {
      lines.push(`🕐 ${time}`);
    }
    lines.push(link(watchedUsername, tweet.id));
    return lines.join('\n');
  });
}

export function buildThreadMessage(tweets: Tweet[], watchedUsername: string): string {
  const first = tweets[0];
  const last = tweets[tweets.length - 1];

  return fit((size) => {
    const lines = [
      `🧵 <b>New thread</b> · ${authorLine(first, watchedUsername)} · ${tweets.length} tweets`,
      '',
      `<blockquote>${preview(first.text, size)}</blockquote>`,
    ];
    const media = mediaSummary(tweets);
    if (media) {
      lines.push(`📎 ${media}`);
    }
    const time = formatTimestamp(first.createdAt);
    if (time) {
      lines.push(`🕐 ${time}`);
    }
    lines.push(link(watchedUsername, last.id));
    return lines.join('\n');
  });
}

/** Appended when the notification had to be sent without its screenshot or media. */
export const MEDIA_MISSING_NOTE = '\n\n⚠️ <i>Screenshot/media could not be uploaded.</i>';

export function buildSpaceLiveMessage(event: SpaceLiveEvent): string {
  const lines = [
    '🔴 <b>Space is live</b>',
    '',
    `🎙 <b>${escapeHtml(event.title)}</b>`,
    `👤 Host: @${escapeHtml(event.user)}`,
  ];
  const started = formatTimestamp(event.startedAt);
  if (started) {
    lines.push(`🕐 Started: ${started}`);
  }
  lines.push(`🔗 <a href="https://x.com/i/spaces/${encodeURIComponent(event.spaceId)}">Listen on X</a>`, '⏺ Recording…');
  return lines.join('\n');
}

export function buildSpaceRecordedMessage(event: SpaceRecordedEvent): string {
  const fileName = event.filePath.split(/[\\/]/).pop() || event.filePath;
  return [
    '✅ <b>Space recorded</b>',
    '',
    `🎙 <b>${escapeHtml(event.title)}</b>`,
    `👤 Host: @${escapeHtml(event.user)}`,
    `⏱ Duration: ${escapeHtml(event.duration)}`,
    `💾 <code>${escapeHtml(fileName)}</code>`,
  ].join('\n');
}

export function buildSpaceUploadFailedMessage(event: SpaceRecordedEvent): string {
  return [
    '⚠️ <b>Space audio upload failed</b>',
    '',
    `🎙 <b>${escapeHtml(event.title)}</b> (@${escapeHtml(event.user)})`,
    'The recording was kept on the server:',
    `<code>${escapeHtml(event.filePath)}</code>`,
  ].join('\n');
}

export function buildStartedMessage(mode: string, spaces: number, tweets: number, replies: number): string {
  return [
    '🟢 <b>X Watcher started</b>',
    '',
    `👀 Watching: ${spaces} Space${spaces === 1 ? '' : 's'} · ${tweets} tweet account${tweets === 1 ? '' : 's'}${replies ? ` (${replies} with replies)` : ''}`,
    `⚙️ Mode: ${escapeHtml(mode)}`,
  ].join('\n');
}

export function buildStoppedMessage(crashed: boolean, reason: string): string {
  return `${crashed ? '🔴 <b>X Watcher crashed</b>' : '🟡 <b>X Watcher stopped</b>'}\n\nReason: ${escapeHtml(reason)}`;
}
