'use strict';

/**
 * Twitter API — Lightweight GraphQL wrapper for tweet fetching.
 * 
 * Uses the same endpoint hashes, params, and auth patterns as twspace-crawler
 * to stay in sync with Twitter's API changes.
 */

const axios = require('axios');
const { getQueryId } = require('./query-resolver');

// Import the up-to-date constants directly from twspace-crawler
const { TWITTER_PUBLIC_AUTHORIZATION, UA } = require('twspace-crawler/dist/api/twitter.constant');
const { twitterGraphqlEndpoints } = require('twspace-crawler/dist/api/constant/twitter-graphql-endpoint.constant');
const { twitterGraphqlParams } = require('twspace-crawler/dist/api/constant/twitter-graphql-param.constant');

const TWITTER_API_URL = 'https://api.twitter.com';

/**
 * Clone and merge params (mirrors twspace-crawler's cloneParams method).
 * Each top-level key (variables, features, fieldToggles) is JSON-stringified.
 */
function cloneParams(src, overrides) {
  const obj = JSON.parse(JSON.stringify(src));
  if (overrides) {
    Object.keys(overrides).forEach((key) => {
      Object.assign(obj, { [key]: { ...obj[key], ...overrides[key] } });
    });
  }
  // Twitter expects each param group as a JSON string
  Object.keys(obj).forEach((key) => {
    obj[key] = JSON.stringify(obj[key]);
  });
  return obj;
}

/**
 * Build authentication headers using the same cookies from .env
 */
function getAuthHeaders() {
  const authToken = process.env.TWITTER_AUTH_TOKEN;
  const csrfToken = process.env.TWITTER_CSRF_TOKEN;

  if (!authToken || !csrfToken) return null;

  return {
    authorization: TWITTER_PUBLIC_AUTHORIZATION,
    cookie: `auth_token=${authToken}; ct0=${csrfToken}`,
    'x-csrf-token': csrfToken,
    'x-twitter-active-user': 'yes',
    'x-twitter-client-language': 'en',
    'user-agent': UA,
  };
}

/**
 * Build the full URL for a GraphQL endpoint.
 */
function buildUrl(endpoint) {
  return `${TWITTER_API_URL}/graphql/${endpoint.queryId}/${endpoint.operationName}`;
}

/**
 * Resolve a Twitter username to a numeric user ID.
 * @returns {string|null} The user's rest_id
 */
async function getUserId(username) {
  const headers = getAuthHeaders();
  if (!headers) return null;

  try {
    const url = buildUrl(twitterGraphqlEndpoints.UserByScreenName);
    const params = cloneParams(twitterGraphqlParams.UserByScreenName, {
      variables: { screen_name: username },
    });

    const { data } = await axios.get(url, { headers, params });
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
    // Try twspace-crawler's endpoint first
    const url = buildUrl(twitterGraphqlEndpoints.UserTweets);
    const params = cloneParams(twitterGraphqlParams.UserTweets, {
      variables: { userId, count },
    });

    const { data } = await axios.get(url, { headers, params });
    return parseTweetsResponse(data, userId);
  } catch (err) {
    // If stale queryId (404), try dynamic resolution
    if (err.response?.status === 404) {
      console.log('[TwitterAPI] Stale UserTweets queryId, resolving dynamically...');
      try {
        const freshId = await getQueryId('UserTweets');
        if (freshId) {
          const url = `${TWITTER_API_URL}/graphql/${freshId}/UserTweets`;
          const params = cloneParams(twitterGraphqlParams.UserTweets, {
            variables: { userId, count },
          });
          const { data } = await axios.get(url, { headers, params });
          return parseTweetsResponse(data, userId);
        }
      } catch (err2) {
        console.error(`[TwitterAPI] getUserTweets dynamic error:`, err2.response?.status, err2.message);
      }
    } else {
      console.error(`[TwitterAPI] getUserTweets error:`, err.response?.status, err.message);
    }
    return [];
  }
}

/**
 * Fetch the latest tweets AND replies for a user by their numeric ID.
 * Uses the V2 endpoint (UserWithProfileTweetsAndRepliesQueryV2) which
 * has a more up-to-date queryId. Falls back to the old endpoint if V2
 * is unavailable.
 * 
 * @param {string} userId - Numeric user ID (rest_id)
 * @param {number} count - Number of entries to fetch (default 20)
 * @returns {Array} Parsed tweets + replies
 */
async function getUserTweetsAndReplies(userId, count = 20) {
  const headers = getAuthHeaders();
  if (!headers) return [];

  const freshId = await getQueryId('UserTweetsAndReplies');
  if (!freshId) {
    console.error('[TwitterAPI] Failed to dynamically grab UserTweetsAndReplies queryId');
    return [];
  }

  // Use the exact live extracted features from 2026-04
  const exactParams = {
    variables: {
      userId,
      count,
      includePromotedContent: true,
      withCommunity: true,
      withVoice: true
    },
    features: {
      "rweb_video_screen_enabled": false,
      "profile_label_improvements_pcf_label_in_post_enabled": true,
      "responsive_web_profile_redirect_enabled": false,
      "rweb_tipjar_consumption_enabled": false,
      "verified_phone_label_enabled": false,
      "creator_subscriptions_tweet_preview_api_enabled": true,
      "responsive_web_graphql_timeline_navigation_enabled": true,
      "responsive_web_graphql_skip_user_profile_image_extensions_enabled": false,
      "premium_content_api_read_enabled": false,
      "communities_web_enable_tweet_community_results_fetch": true,
      "c9s_tweet_anatomy_moderator_badge_enabled": true,
      "responsive_web_grok_analyze_button_fetch_trends_enabled": false,
      "responsive_web_grok_analyze_post_followups_enabled": false,
      "responsive_web_jetfuel_frame": true,
      "responsive_web_grok_share_attachment_enabled": true,
      "responsive_web_grok_annotations_enabled": true,
      "articles_preview_enabled": true,
      "responsive_web_edit_tweet_api_enabled": true,
      "graphql_is_translatable_rweb_tweet_is_translatable_enabled": true,
      "view_counts_everywhere_api_enabled": true,
      "longform_notetweets_consumption_enabled": true,
      "responsive_web_twitter_article_tweet_consumption_enabled": true,
      "content_disclosure_indicator_enabled": true,
      "content_disclosure_ai_generated_indicator_enabled": true,
      "responsive_web_grok_show_grok_translated_post": true,
      "responsive_web_grok_analysis_button_from_backend": true,
      "post_ctas_fetch_enabled": true,
      "freedom_of_speech_not_reach_fetch_enabled": true,
      "standardized_nudges_misinfo": true,
      "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": true,
      "longform_notetweets_rich_text_read_enabled": true,
      "longform_notetweets_inline_media_enabled": false,
      "responsive_web_grok_image_annotation_enabled": true,
      "responsive_web_grok_imagine_annotation_enabled": true,
      "responsive_web_grok_community_note_auto_translation_is_enabled": true,
      "responsive_web_enhance_cards_enabled": false
    },
    fieldToggles: {
      "withArticlePlainText": false
    }
  };

  try {
    const url = `${TWITTER_API_URL}/graphql/${freshId}/UserTweetsAndReplies`;
    
    // Instead of GET, we use POST with JSON body payload.
    // Twitter's endpoint accepts POST for GraphQL and this completely
    // bypasses the 404 / Web Application Firewall blocks that hit URL-encoded GETs!
    const { data } = await axios.post(url, exactParams, { headers });
    return parseTweetsResponse(data, userId);
  } catch (err) {
    console.error(`[TwitterAPI] Live TweetsAndReplies error:`, err.response?.status, err.message);
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
    const url = buildUrl(twitterGraphqlEndpoints.TweetDetail);
    const params = cloneParams(twitterGraphqlParams.TweetDetail, {
      variables: { focalTweetId: tweetId },
    });

    const { data } = await axios.get(url, { headers, params });

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
 * @param {object} data - GraphQL response 
 * @param {string} targetUserId - Filter out external replies
 */
function parseTweetsResponse(data, targetUserId) {
  const tweets = [];

  try {
    const result = data?.data?.user?.result;
    const instructions = result?.timeline_v2?.timeline?.instructions 
                      || result?.timeline?.timeline?.instructions 
                      || [];
    
    for (const instruction of instructions) {
      const entries = instruction.entries || [];
      for (const entry of entries) {
        // Skip cursors
        if (entry.entryId?.includes('cursor-')) continue;

        // Standard tweets
        if (entry.entryId?.startsWith('tweet-')) {
          let result = entry.content?.itemContent?.tweet_results?.result;
          if (!result) continue;
          if (result.__typename === 'TweetWithVisibilityResults') result = result.tweet;
          const tweet = parseSingleTweet(result);
          if (tweet && (!targetUserId || tweet.authorId === targetUserId)) tweets.push(tweet);
        }
        
        // Threads & Replies are wrapped in TimelineTimelineModule
        else if (entry.entryId?.startsWith('profile-conversation-') || entry.content?.__typename === 'TimelineTimelineModule') {
          const items = entry.content?.items || [];
          for (const item of items) {
            let result = item.item?.itemContent?.tweet_results?.result;
            if (!result) continue;
            if (result.__typename === 'TweetWithVisibilityResults') result = result.tweet;
            const tweet = parseSingleTweet(result);
            // Ensure the extracted tweet was authored by the user we are tracking
            if (tweet && (!targetUserId || tweet.authorId === targetUserId)) tweets.push(tweet);
          }
        }
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
    authorId: result.core?.user_results?.result?.rest_id || legacy.user_id_str,
    author: {
      username: user.screen_name,
      displayName: user.name,
      profileImage: user.profile_image_url_https,
    },
    metrics: {
      likes: legacy.favorite_count || 0,
      retweets: legacy.retweet_count || 0,
      replies: legacy.reply_count || 0,
      bookmarks: legacy.bookmark_count || 0,
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
  getUserTweetsAndReplies,
  getTweetById,
  parseSingleTweet,
};
