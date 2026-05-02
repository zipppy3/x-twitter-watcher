import { AppConfig, WatchTarget } from '../types';

export type TopicType = 'audio' | 'metadata' | 'tweet' | 'tweetMetadata';

export function getTopicId(config: AppConfig, target: WatchTarget | null, type: TopicType): string | null {
  const perUserKey = {
    audio: 'telegramAudioTopicId',
    metadata: 'telegramMetadataTopicId',
    tweet: 'telegramTweetTopicId',
    tweetMetadata: 'telegramTweetMetadataTopicId',
  } as const;

  const configKey = {
    audio: config.telegramAudioThreadId,
    metadata: config.telegramMetadataThreadId,
    tweet: config.telegramTweetThreadId,
    tweetMetadata: config.telegramTweetMetadataThreadId,
  } as const;

  return (target?.[perUserKey[type]] as string | null) ?? configKey[type] ?? null;
}
