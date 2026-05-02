import path from 'node:path';
import axios, { AxiosError, AxiosInstance } from 'axios';
import dotenv from 'dotenv';
import { AppConfig, Tweet, TwitterClient } from '../types';
import { rootLogger } from '../runtime/logger';
import { refreshTokensFromProfile } from '../utils/refresh-tokens';
import { ProxyRotator, PlaywrightProxyConfig } from '../utils/proxy-rotator';

const TWITTER_API_URL = 'https://api.twitter.com';
const TWITTER_PUBLIC_AUTHORIZATION =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const GRAPHQL_ENDPOINTS = {
  UserByScreenName: { queryId: 'oUZZZ8Oddwxs8Cd3iW3UEA', operationName: 'UserByScreenName' },
  UserTweets: { queryId: 'rIIwMe1ObkGh_ByBtTCtRQ', operationName: 'UserTweets' },
  TweetDetail: { queryId: 'TuC3CinYecrqAyqccUyFhw', operationName: 'TweetDetail' },
} as const;

const GRAPHQL_PARAMS = {
  UserByScreenName: {
    variables: {
      screen_name: '',
      withSafetyModeUserFields: true,
    },
    features: {
      hidden_profile_likes_enabled: false,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      subscriptions_verification_info_verified_since_enabled: true,
      highlights_tweets_tab_ui_enabled: true,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      responsive_web_graphql_timeline_navigation_enabled: true,
    },
  },
  UserTweets: {
    variables: {
      userId: '',
      count: 20,
      includePromotedContent: true,
      withQuickPromoteEligibilityTweetFields: true,
      withVoice: true,
      withV2Timeline: true,
    },
    features: {
      rweb_lists_timeline_redesign_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      tweetypie_unmention_optimization_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: false,
      tweet_awards_web_tipping_enabled: false,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      responsive_web_media_download_video_enabled: false,
      responsive_web_enhance_cards_enabled: false,
    },
    fieldToggles: {
      withArticleRichContentState: false,
    },
  },
  TweetDetail: {
    variables: {
      focalTweetId: '',
      with_rux_injections: false,
      includePromotedContent: true,
      withCommunity: true,
      withQuickPromoteEligibilityTweetFields: true,
      withBirdwatchNotes: true,
      withVoice: true,
    },
    features: {
      rweb_lists_timeline_redesign_enabled: true,
      responsive_web_graphql_exclude_directive_enabled: true,
      verified_phone_label_enabled: false,
      creator_subscriptions_tweet_preview_api_enabled: true,
      responsive_web_graphql_timeline_navigation_enabled: true,
      responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
      tweetypie_unmention_optimization_enabled: true,
      responsive_web_edit_tweet_api_enabled: true,
      graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
      view_counts_everywhere_api_enabled: true,
      longform_notetweets_consumption_enabled: true,
      responsive_web_twitter_article_tweet_consumption_enabled: false,
      tweet_awards_web_tipping_enabled: false,
      freedom_of_speech_not_reach_fetch_enabled: true,
      standardized_nudges_misinfo: true,
      tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
      longform_notetweets_rich_text_read_enabled: true,
      longform_notetweets_inline_media_enabled: true,
      responsive_web_media_download_video_enabled: false,
      responsive_web_enhance_cards_enabled: false,
    },
    fieldToggles: {
      withArticleRichContentState: false,
      withAuxiliaryUserLabels: false,
    },
  },
};

const QUERY_RESOLVER_OPERATIONS = ['UserTweets', 'UserTweetsAndReplies', 'UserByScreenName', 'TweetDetail'] as const;

function cloneParams(src: Record<string, any>, overrides?: Record<string, any>): Record<string, string> {
  const obj = JSON.parse(JSON.stringify(src));
  if (overrides) {
    for (const key of Object.keys(overrides)) {
      Object.assign(obj, { [key]: { ...obj[key], ...overrides[key] } });
    }
  }
  for (const key of Object.keys(obj)) {
    obj[key] = JSON.stringify(obj[key]);
  }
  return obj;
}

function buildUrl(endpoint: { queryId: string; operationName: string }): string {
  return `${TWITTER_API_URL}/graphql/${endpoint.queryId}/${endpoint.operationName}`;
}

function parseSingleTweet(rawResult: any): Tweet | null {
  if (!rawResult) {
    return null;
  }

  const result = rawResult.__typename === 'TweetWithVisibilityResults' ? rawResult.tweet : rawResult;

  if (!result || !result.legacy) {
    return null;
  }

  const legacy = result.legacy;
  const userNode = result.core?.user_results?.result;
  const userLegacy = userNode?.legacy || {};
  // Twitter API moved screen_name/name from legacy to core in newer responses
  const userCore = userNode?.core || {};
  const media = (legacy.extended_entities?.media || []).map((item: any) => ({
    type: item.type,
    url:
      item.type === 'photo'
        ? item.media_url_https
        : item.video_info?.variants?.find((variant: any) => variant.content_type === 'video/mp4')?.url ||
          item.media_url_https,
    preview: item.media_url_https,
  }));
  const urls = (legacy.entities?.urls || []).map((item: any) => ({
    display: item.display_url,
    expanded: item.expanded_url,
  }));

  return {
    id: result.rest_id || legacy.id_str,
    text: legacy.full_text,
    createdAt: legacy.created_at,
    authorId: userNode?.rest_id || legacy.user_id_str,
    author: {
      username: userLegacy.screen_name || userCore.screen_name,
      displayName: userLegacy.name || userCore.name,
      profileImage: userLegacy.profile_image_url_https || userNode?.avatar?.image_url,
    },
    metrics: {
      likes: legacy.favorite_count || 0,
      retweets: legacy.retweet_count || 0,
      replies: legacy.reply_count || 0,
      bookmarks: legacy.bookmark_count || 0,
      views: result.views?.count ? Number.parseInt(result.views.count, 10) : 0,
    },
    conversationId: legacy.conversation_id_str,
    inReplyToStatusId: legacy.in_reply_to_status_id_str || null,
    inReplyToUserId: legacy.in_reply_to_user_id_str || null,
    inReplyToUsername: legacy.in_reply_to_screen_name || null,
    isRetweet: Boolean(legacy.retweeted_status_result),
    isThread: legacy.in_reply_to_user_id_str === legacy.user_id_str,
    media,
    urls,
    quotedTweet: result.quoted_status_result?.result ? parseSingleTweet(result.quoted_status_result.result) : null,
  };
}

function parseTweetsResponse(data: any, targetUserId?: string): Tweet[] {
  const tweets: Tweet[] = [];

  try {
    const result = data?.data?.user?.result;
    const instructions = result?.timeline_v2?.timeline?.instructions || result?.timeline?.timeline?.instructions || [];

    for (const instruction of instructions) {
      const entries = instruction.entries || [];
      for (const entry of entries) {
        if (entry.entryId?.includes('cursor-')) {
          continue;
        }

        if (entry.entryId?.startsWith('tweet-')) {
          let resultNode = entry.content?.itemContent?.tweet_results?.result;
          if (!resultNode) {
            continue;
          }
          if (resultNode.__typename === 'TweetWithVisibilityResults') {
            resultNode = resultNode.tweet;
          }
          const tweet = parseSingleTweet(resultNode);
          if (tweet && (!targetUserId || tweet.authorId === targetUserId)) {
            tweets.push(tweet);
          }
          continue;
        }

        if (entry.entryId?.startsWith('profile-conversation-') || entry.content?.__typename === 'TimelineTimelineModule') {
          const items = entry.content?.items || [];
          for (const item of items) {
            let resultNode = item.item?.itemContent?.tweet_results?.result;
            if (!resultNode) {
              continue;
            }
            if (resultNode.__typename === 'TweetWithVisibilityResults') {
              resultNode = resultNode.tweet;
            }
            const tweet = parseSingleTweet(resultNode);
            if (tweet && (!targetUserId || tweet.authorId === targetUserId)) {
              tweets.push(tweet);
            }
          }
        }
      }
    }
  } catch (error) {
    rootLogger.child('twitter').error('Failed to parse tweet timeline', { message: (error as Error).message });
  }

  return tweets;
}

class QueryResolver {
  private cachedEndpoints: Record<string, string> | null = null;

  private cacheTime = 0;

  constructor(private readonly http: Pick<AxiosInstance, 'get'>) {}

  getCachedQueryId(operationName: string): string | null {
    return this.cachedEndpoints ? this.cachedEndpoints[operationName] : null;
  }

  async getQueryId(operationName: (typeof QUERY_RESOLVER_OPERATIONS)[number], forceRefresh = false): Promise<string | null> {
    const endpoints = await this.resolveQueryIds(forceRefresh);
    return endpoints[operationName] || null;
  }

  private async resolveQueryIds(forceRefresh = false): Promise<Record<string, string>> {
    if (!forceRefresh && this.cachedEndpoints && Date.now() - this.cacheTime < 3600000) {
      return this.cachedEndpoints;
    }

    const html = await this.http.get('https://x.com', { headers: { 'User-Agent': UA }, timeout: 15000 }).then((res) => res.data);
    const urls = Array.from(
      new Set((html.match(/https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"'\s]+\.js/g) || []) as string[])
    );

    const found: Record<string, string> = {};
    for (const url of urls) {
      if (QUERY_RESOLVER_OPERATIONS.every((operation) => found[operation])) {
        break;
      }

      try {
        const js = await this.http.get(url, { headers: { 'User-Agent': UA }, timeout: 15000 }).then((res) => res.data);
        for (const operation of QUERY_RESOLVER_OPERATIONS) {
          if (found[operation]) {
            continue;
          }
          const patterns = [
            new RegExp(`queryId:"([^"]+)",operationName:"${operation}"`),
            new RegExp(`queryId:\\s*"([^"]+)"\\s*,\\s*operationName:\\s*"${operation}"`),
            new RegExp(`\\{queryId:"([^"]+)",operationName:"${operation}"`),
          ];
          for (const pattern of patterns) {
            const match = js.match(pattern);
            if (match) {
              found[operation] = match[1];
              break;
            }
          }
        }
      } catch {
        // Ignore bundle fetch failures and keep scanning.
      }
    }

    this.cachedEndpoints = found;
    this.cacheTime = Date.now();
    return found;
  }
}

export class TwitterApiClient implements TwitterClient {
  private readonly logger = rootLogger.child('twitter');

  private readonly http: Pick<AxiosInstance, 'get' | 'post'>;

  private readonly resolver: QueryResolver;

  private authToken: string | null;

  private csrfToken: string | null;

  constructor(
    private readonly config: AppConfig,
    options: {
      httpClient?: Pick<AxiosInstance, 'get' | 'post'>;
      refreshHandler?: (reason: string) => Promise<boolean>;
      onRefreshFailure?: (reason: string, error: Error) => Promise<void>;
      proxyRotator?: ProxyRotator;
    } = {}
  ) {
    this.http = options.httpClient ?? axios.create();
    this.resolver = new QueryResolver(this.http as Pick<AxiosInstance, 'get'>);
    this.authToken = config.twitterAuthToken;
    this.csrfToken = config.twitterCsrfToken;
    this.refreshHandler = options.refreshHandler ?? ((reason) => this.runRefreshScript(reason));
    this.onRefreshFailure = options.onRefreshFailure;
    this.proxyRotator = options.proxyRotator;
  }

  private readonly refreshHandler: (reason: string) => Promise<boolean>;

  private readonly onRefreshFailure?: (reason: string, error: Error) => Promise<void>;

  private readonly proxyRotator?: ProxyRotator;

  private getAxiosProxyConfig(proxyConfig: PlaywrightProxyConfig | null): any {
    if (!proxyConfig) return false;
    try {
      const url = new URL(proxyConfig.server);
      return {
        protocol: url.protocol.replace(':', ''),
        host: url.hostname,
        port: parseInt(url.port || '80', 10),
        auth: proxyConfig.username ? { username: proxyConfig.username, password: proxyConfig.password || '' } : undefined,
      };
    } catch {
      return false;
    }
  }

  async resolveUserId(username: string): Promise<string | null> {
    try {
      const queryId = this.resolver.getCachedQueryId('UserByScreenName') || GRAPHQL_ENDPOINTS.UserByScreenName.queryId;
      const url = `${TWITTER_API_URL}/graphql/${queryId}/UserByScreenName`;
      const params = cloneParams(GRAPHQL_PARAMS.UserByScreenName, {
        variables: { screen_name: username },
      });
      const { data } = await this.requestWithAuthRetry((proxy) =>
        this.http.get(url, { headers: this.getAuthHeaders(), params, proxy })
      );
      return data?.data?.user?.result?.rest_id || null;
    } catch (error) {
      this.logger.error('Failed to resolve user id', { username, message: (error as Error).message });
      return null;
    }
  }

  async getUserTweets(userId: string, count = 20): Promise<Tweet[]> {
    try {
      const queryId = this.resolver.getCachedQueryId('UserTweets') || GRAPHQL_ENDPOINTS.UserTweets.queryId;
      const url = `${TWITTER_API_URL}/graphql/${queryId}/UserTweets`;
      const params = cloneParams(GRAPHQL_PARAMS.UserTweets, {
        variables: { userId, count },
      });
      const { data } = await this.requestWithAuthRetry((proxy) =>
        this.http.get(url, { headers: this.getAuthHeaders(), params, proxy })
      );
      return parseTweetsResponse(data, userId);
    } catch (error) {
      const axiosError = error as AxiosError;
      if (axiosError.response?.status === 404 || axiosError.response?.status === 422) {
        const freshId = await this.resolver.getQueryId('UserTweets', true);
        if (!freshId) {
          return [];
        }
        const params = cloneParams(GRAPHQL_PARAMS.UserTweets, {
          variables: { userId, count },
        });
        const { data } = await this.requestWithAuthRetry((proxy) =>
          this.http.get(`${TWITTER_API_URL}/graphql/${freshId}/UserTweets`, {
            headers: this.getAuthHeaders(),
            params,
            proxy,
          })
        );
        return parseTweetsResponse(data, userId);
      }
      this.logger.error('Failed to fetch user tweets', { userId, message: axiosError.message });
      return [];
    }
  }

  async getUserTweetsAndReplies(userId: string, count = 20): Promise<Tweet[]> {
    const freshId = await this.resolver.getQueryId('UserTweetsAndReplies');
    if (!freshId) {
      this.logger.error('Failed to resolve UserTweetsAndReplies query id');
      return [];
    }

    const payload = {
      variables: {
        userId,
        count,
        includePromotedContent: true,
        withCommunity: true,
        withVoice: true,
      },
      features: {
        rweb_video_screen_enabled: false,
        profile_label_improvements_pcf_label_in_post_enabled: true,
        responsive_web_profile_redirect_enabled: false,
        rweb_tipjar_consumption_enabled: false,
        verified_phone_label_enabled: false,
        creator_subscriptions_tweet_preview_api_enabled: true,
        responsive_web_graphql_timeline_navigation_enabled: true,
        responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
        premium_content_api_read_enabled: false,
        communities_web_enable_tweet_community_results_fetch: true,
        c9s_tweet_anatomy_moderator_badge_enabled: true,
        responsive_web_grok_analyze_button_fetch_trends_enabled: false,
        responsive_web_grok_analyze_post_followups_enabled: false,
        responsive_web_jetfuel_frame: true,
        responsive_web_grok_share_attachment_enabled: true,
        responsive_web_grok_annotations_enabled: true,
        articles_preview_enabled: true,
        responsive_web_edit_tweet_api_enabled: true,
        graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
        view_counts_everywhere_api_enabled: true,
        longform_notetweets_consumption_enabled: true,
        responsive_web_twitter_article_tweet_consumption_enabled: true,
        content_disclosure_indicator_enabled: true,
        content_disclosure_ai_generated_indicator_enabled: true,
        responsive_web_grok_show_grok_translated_post: true,
        responsive_web_grok_analysis_button_from_backend: true,
        post_ctas_fetch_enabled: true,
        freedom_of_speech_not_reach_fetch_enabled: true,
        standardized_nudges_misinfo: true,
        tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
        longform_notetweets_rich_text_read_enabled: true,
        longform_notetweets_inline_media_enabled: false,
        responsive_web_grok_image_annotation_enabled: true,
        responsive_web_grok_imagine_annotation_enabled: true,
        responsive_web_grok_community_note_auto_translation_is_enabled: true,
        responsive_web_enhance_cards_enabled: false,
      },
      fieldToggles: {
        withArticlePlainText: false,
      },
    };

    try {
      const { data } = await this.requestWithAuthRetry((proxy) =>
        this.http.post(`${TWITTER_API_URL}/graphql/${freshId}/UserTweetsAndReplies`, payload, {
          headers: this.getAuthHeaders(),
          proxy,
        })
      );
      return parseTweetsResponse(data, userId);
    } catch (error) {
      this.logger.error('Failed to fetch tweets and replies', { userId, message: (error as Error).message });
      return [];
    }
  }

  async getTweetById(tweetId: string): Promise<Tweet | null> {
    try {
      const queryId = this.resolver.getCachedQueryId('TweetDetail') || GRAPHQL_ENDPOINTS.TweetDetail.queryId;
      const url = `${TWITTER_API_URL}/graphql/${queryId}/TweetDetail`;
      const params = cloneParams(GRAPHQL_PARAMS.TweetDetail, {
        variables: { focalTweetId: tweetId },
      });
      const { data } = await this.requestWithAuthRetry((proxy) =>
        this.http.get(url, { headers: this.getAuthHeaders(), params, proxy })
      );

      return this.parseTweetDetailResponse(data, tweetId);
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;
      if (status === 404 || status === 422) {
        this.logger.warn('TweetDetail queryId stale, resolving fresh ID', { tweetId, status });
        const freshId = await this.resolver.getQueryId('TweetDetail', true);
        if (freshId) {
          try {
            const params = cloneParams(GRAPHQL_PARAMS.TweetDetail, {
              variables: { focalTweetId: tweetId },
            });
            const { data } = await this.requestWithAuthRetry((proxy) =>
              this.http.get(`${TWITTER_API_URL}/graphql/${freshId}/TweetDetail`, {
                headers: this.getAuthHeaders(),
                params,
                proxy,
              })
            );
            return this.parseTweetDetailResponse(data, tweetId);
          } catch (retryError) {
            this.logger.error('Failed to fetch tweet detail with fresh queryId', {
              tweetId,
              message: (retryError as Error).message,
            });
            return null;
          }
        }
      }
      this.logger.error('Failed to fetch tweet detail', { tweetId, message: (error as Error).message });
      return null;
    }
  }

  private parseTweetDetailResponse(data: any, tweetId: string): Tweet | null {
    const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions || [];
    for (const instruction of instructions) {
      if (instruction.type !== 'TimelineAddEntries') {
        continue;
      }
      for (const entry of instruction.entries || []) {
        const result = entry?.content?.itemContent?.tweet_results?.result;
        if (!result) {
          continue;
        }
        const tweet = parseSingleTweet(result);
        if (tweet?.id === tweetId) {
          return tweet;
        }
      }
    }
    return null;
  }

  async refreshAuth(reason: string): Promise<boolean> {
    return this.refreshHandler(reason);
  }

  private getAuthHeaders(): Record<string, string> {
    if (!this.authToken || !this.csrfToken) {
      throw new Error('Twitter auth is not configured');
    }

    return {
      authorization: TWITTER_PUBLIC_AUTHORIZATION,
      cookie: `auth_token=${this.authToken}; ct0=${this.csrfToken}`,
      'x-csrf-token': this.csrfToken,
      'x-twitter-active-user': 'yes',
      'x-twitter-client-language': 'en',
      'user-agent': UA,
    };
  }

  private async requestWithAuthRetry<T>(request: (proxy: any) => Promise<T>, retried = false, useProxy = false): Promise<T> {
    const defaultUseProxy = !this.config.proxyFallbackOnBan;
    const shouldProxy = useProxy || defaultUseProxy;
    const proxyConfig = shouldProxy && this.proxyRotator?.enabled ? this.getAxiosProxyConfig(this.proxyRotator.next()) : false;

    try {
      return await request(proxyConfig);
    } catch (error) {
      const axiosError = error as AxiosError;
      const status = axiosError.response?.status;

      if (this.config.proxyFallbackOnBan && !useProxy && (status === 403 || status === 429)) {
        this.logger.warn(`Twitter API IP banned (${status}), falling back to proxy...`);
        return this.requestWithAuthRetry(request, retried, true);
      }

      if (!retried && (status === 401 || status === 403)) {
        const refreshed = await this.refreshAuth(`twitter_http_${status}`);
        if (refreshed) {
          return this.requestWithAuthRetry(request, true, useProxy);
        }
      }
      throw error;
    }
  }

  private async runRefreshScript(reason: string): Promise<boolean> {
    this.logger.warn('Refreshing Twitter auth tokens', { reason });

    const profileDir = path.join(this.config.packageRoot, '.browser-profile');
    try {
      const result = await refreshTokensFromProfile(profileDir, this.config.envPath);

      if (result) {
        dotenv.config({ path: this.config.envPath, override: true });
        this.authToken = result.authToken;
        this.csrfToken = result.csrfToken;
        return true;
      }

      if (this.onRefreshFailure) {
        await this.onRefreshFailure(reason, new Error('No valid tokens found in browser profile. Manual login required.'));
      }
      return false;
    } catch (error) {
      if (this.onRefreshFailure) {
        await this.onRefreshFailure(reason, error as Error);
      }
      return false;
    }
  }
}
