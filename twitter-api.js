'use strict';

/**
 * Twitter API — Lightweight GraphQL wrapper for tweet fetching.
 * 
 * Reuses the same auth_token + ct0 cookie pattern as twspace-crawler,
 * so it works with the existing .env configuration.
 */

const axios = require('axios');

const BEARER = 'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

/**
 * Build authentication headers using the same cookies from .env
 */
function getAuthHeaders() {
  const authToken = process.env.TWITTER_AUTH_TOKEN;
  const csrfToken = process.env.TWITTER_CSRF_TOKEN;

  if (!authToken || !csrfToken) return null;

  return {
    authorization: BEARER,
    cookie: `auth_token=${authToken}; ct0=${csrfToken}`,
    'x-csrf-token': csrfToken,
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
  };
}

/**
 * Resolve a Twitter username to a numeric user ID.
 * @returns {string|null} The user's rest_id
 */
async function getUserId(username) {
  const headers = getAuthHeaders();
  if (!headers) return null;

  try {
    const { data } = await axios.get(
      'https://twitter.com/i/api/graphql/7mjxD3-C6BxitPMVQ6w0-Q/UserByScreenName',
      {
        headers,
        params: {
          variables: JSON.stringify({
            screen_name: username,
            withSafetyModeUserFields: false,
            withSuperFollowsUserFields: false,
          }),
          features: JSON.stringify({
            hidden_profile_subscriptions_enabled: true,
            responsive_web_graphql_exclude_directive_enabled: true,
            verified_phone_label_enabled: false,
            responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
            responsive_web_graphql_timeline_navigation_enabled: true,
          }),
        },
      }
    );
    return data?.data?.user?.result?.rest_id || null;
  } catch (err) {
    console.error(`[TwitterAPI] getUserId error for @${username}:`, err.message);
    return null;
  }
}

/**
 * Fetch the latest tweets for a user by their numeric ID.
 * @param {string} userId - Numeric user ID
 * @param {number} count - Number of tweets to fetch (default 20)
 * @returns {Array} Parsed tweets
 */
async function getUserTweets(userId, count = 20) {
  const headers = getAuthHeaders();
  if (!headers) return [];

  try {
    const { data } = await axios.get(
      'https://twitter.com/i/api/graphql/QvCV3AU7X1ZXr9JSrH9EOA/UserTweets',
      {
        headers,
        params: {
          variables: JSON.stringify({
            userId,
            count,
            includePromotedContent: false,
            withQuickPromoteEligibilityTweetFields: false,
            withVoice: false,
            withV2Timeline: true,
          }),
          features: JSON.stringify({
            responsive_web_graphql_exclude_directive_enabled: true,
            verified_phone_label_enabled: false,
            responsive_web_graphql_timeline_navigation_enabled: true,
            responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
            creator_subscriptions_tweet_preview_api_enabled: true,
            tweetypie_unmention_optimization_enabled: true,
            responsive_web_edit_tweet_api_enabled: true,
            graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
            view_counts_everywhere_api_enabled: true,
            longform_notetweets_consumption_enabled: true,
            responsive_web_twitter_article_tweet_consumption_enabled: true,
            tweet_awards_web_tipping_enabled: false,
            freedom_of_speech_not_reach_fetch_enabled: true,
            standardized_nudges_misinfo: true,
            longform_notetweets_rich_text_read_enabled: true,
            responsive_web_enhance_cards_enabled: false,
            rweb_video_timestamps_enabled: true,
            tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
          }),
        },
      }
    );

    return parseTweetsResponse(data);
  } catch (err) {
    console.error(`[TwitterAPI] getUserTweets error:`, err.message);
    return [];
  }
}

/**
 * Fetch a single tweet by its ID (for thread/reply context).
 * @param {string} tweetId
 * @returns {object|null} Parsed tweet
 */
async function getTweetById(tweetId) {
  const headers = getAuthHeaders();
  if (!headers) return null;

  try {
    const { data } = await axios.get(
      'https://twitter.com/i/api/graphql/xOhkmRac04YFZmOzU9PJHg/TweetDetail',
      {
        headers,
        params: {
          variables: JSON.stringify({
            focalTweetId: tweetId,
            with_rux_injections: false,
            includePromotedContent: false,
            withCommunity: true,
            withQuickPromoteEligibilityTweetFields: false,
            withBirdwatchNotes: false,
            withVoice: true,
            withV2Timeline: true,
          }),
          features: JSON.stringify({
            responsive_web_graphql_exclude_directive_enabled: true,
            verified_phone_label_enabled: false,
            responsive_web_graphql_timeline_navigation_enabled: true,
            responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
            tweetypie_unmention_optimization_enabled: true,
            responsive_web_edit_tweet_api_enabled: true,
            graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
            view_counts_everywhere_api_enabled: true,
            longform_notetweets_consumption_enabled: true,
            tweet_awards_web_tipping_enabled: false,
            freedom_of_speech_not_reach_fetch_enabled: true,
            standardized_nudges_misinfo: true,
            longform_notetweets_rich_text_read_enabled: true,
            responsive_web_enhance_cards_enabled: false,
            tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
          }),
        },
      }
    );

    // TweetDetail returns entries in a timeline format
    const instructions = data?.data?.threaded_conversation_with_injections_v2?.instructions || [];
    for (const inst of instructions) {
      if (inst.type !== 'TimelineAddEntries') continue;
      for (const entry of (inst.entries || [])) {
        const result = entry?.content?.itemContent?.tweet_results?.result;
        if (result) {
          const tweet = parseSingleTweet(result);
          if (tweet && tweet.id === tweetId) return tweet;
        }
      }
    }
    return null;
  } catch (err) {
    console.error(`[TwitterAPI] getTweetById error:`, err.message);
    return null;
  }
}

/**
 * Parse the UserTweets GraphQL response into clean tweet objects.
 */
function parseTweetsResponse(data) {
  const tweets = [];

  try {
    const instructions = data?.data?.user?.result?.timeline_v2?.timeline?.instructions || [];
    
    for (const instruction of instructions) {
      const entries = instruction.entries || [];
      for (const entry of entries) {
        // Skip cursors and non-tweet entries
        if (!entry.entryId?.startsWith('tweet-')) continue;

        let result = entry.content?.itemContent?.tweet_results?.result;
        if (!result) continue;

        // Handle tweets wrapped in TweetWithVisibilityResults
        if (result.__typename === 'TweetWithVisibilityResults') {
          result = result.tweet;
        }

        const tweet = parseSingleTweet(result);
        if (tweet) tweets.push(tweet);
      }
    }
  } catch (err) {
    console.error('[TwitterAPI] parseTweetsResponse error:', err.message);
  }

  return tweets;
}

/**
 * Parse a single tweet result into a clean object.
 */
function parseSingleTweet(result) {
  if (!result || !result.legacy) return null;

  const legacy = result.legacy;
  const user = result.core?.user_results?.result?.legacy || {};
  const metrics = legacy;

  // Extract media
  const media = (legacy.extended_entities?.media || []).map(m => ({
    type: m.type, // photo, video, animated_gif
    url: m.type === 'photo' ? m.media_url_https : (m.video_info?.variants?.find(v => v.content_type === 'video/mp4')?.url || m.media_url_https),
    preview: m.media_url_https,
  }));

  // Extract URLs
  const urls = (legacy.entities?.urls || []).map(u => ({
    display: u.display_url,
    expanded: u.expanded_url,
  }));

  // Check if it's a quote tweet
  let quotedTweet = null;
  if (result.quoted_status_result?.result) {
    quotedTweet = parseSingleTweet(result.quoted_status_result.result);
  }

  return {
    id: result.rest_id || legacy.id_str,
    text: legacy.full_text,
    createdAt: legacy.created_at,
    author: {
      username: user.screen_name,
      displayName: user.name,
      profileImage: user.profile_image_url_https,
    },
    metrics: {
      likes: metrics.favorite_count || 0,
      retweets: metrics.retweet_count || 0,
      replies: metrics.reply_count || 0,
      bookmarks: metrics.bookmark_count || 0,
      views: result.views?.count ? parseInt(result.views.count) : 0,
    },
    conversationId: legacy.conversation_id_str,
    inReplyToStatusId: legacy.in_reply_to_status_id_str || null,
    inReplyToUserId: legacy.in_reply_to_user_id_str || null,
    inReplyToUsername: legacy.in_reply_to_screen_name || null,
    isRetweet: !!legacy.retweeted_status_result,
    isThread: legacy.in_reply_to_user_id_str === legacy.user_id_str,
    media,
    urls,
    quotedTweet,
  };
}

module.exports = {
  getAuthHeaders,
  getUserId,
  getUserTweets,
  getTweetById,
  parseSingleTweet,
};
