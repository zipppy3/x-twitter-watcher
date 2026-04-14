'use strict';

/**
 * Twitter API — Lightweight GraphQL wrapper for tweet fetching.
 * 
 * Uses the same endpoint hashes, params, and auth patterns as twspace-crawler
 * to stay in sync with Twitter's API changes.
 */

const axios = require('axios');

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
    const url = buildUrl(twitterGraphqlEndpoints.UserTweets);
    const params = cloneParams(twitterGraphqlParams.UserTweets, {
      variables: { userId, count },
    });

    const { data } = await axios.get(url, { headers, params });
    return parseTweetsResponse(data);
  } catch (err) {
    console.error(`[TwitterAPI] getUserTweets error:`, err.response?.status, err.message);
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

  // Try V2 endpoint first (uses rest_id param instead of userId)
  const v2Endpoint = twitterGraphqlEndpoints.UserWithProfileTweetsAndRepliesQueryV2;
  const v2Params = twitterGraphqlParams.UserWithProfileTweetsAndRepliesQueryV2;

  if (v2Endpoint && v2Params) {
    try {
      const url = buildUrl(v2Endpoint);
      const params = cloneParams(v2Params, {
        variables: { rest_id: userId },
      });

      const { data } = await axios.get(url, { headers, params });
      return parseTweetsResponse(data);
    } catch (err) {
      console.error(`[TwitterAPI] V2 TweetsAndReplies error:`, err.response?.status, err.message);
      // Fall through to old endpoint
    }
  }

  // Fallback: old UserTweetsAndReplies endpoint
  try {
    const url = buildUrl(twitterGraphqlEndpoints.UserTweetsAndReplies);
    const params = cloneParams(twitterGraphqlParams.UserTweetsAndReplies, {
      variables: { userId, count },
    });

    const { data } = await axios.get(url, { headers, params });
    return parseTweetsResponse(data);
  } catch (err) {
    console.error(`[TwitterAPI] getUserTweetsAndReplies error:`, err.response?.status, err.message);
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
