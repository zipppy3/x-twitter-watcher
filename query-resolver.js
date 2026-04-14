/**
 * Dynamically resolves Twitter GraphQL queryIds by scraping the JS bundles.
 * Twitter rotates these hashes frequently, so we extract them at runtime.
 */

'use strict';

const axios = require('axios');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

// Operations we want to find
const TARGET_OPERATIONS = [
  'UserTweets',
  'UserTweetsAndReplies',
  'UserByScreenName',
  'TweetDetail',
];

let cachedEndpoints = null;
let cacheTime = 0;
const CACHE_TTL = 3600000; // 1 hour

/**
 * Fetch Twitter's main page and extract JS bundle URLs.
 */
async function getScriptUrls() {
  const { data: html } = await axios.get('https://x.com', {
    headers: { 'User-Agent': UA },
    timeout: 15000,
  });

  const urls = [];
  const regex = /https:\/\/abs\.twimg\.com\/responsive-web\/client-web[^"'\s]+\.js/g;
  let match;
  while ((match = regex.exec(html)) !== null) {
    urls.push(match[0]);
  }
  return urls;
}

/**
 * Search a JS bundle for GraphQL operation queryIds.
 * Pattern: {queryId:"XXXXX",operationName:"UserTweetsAndReplies",...}
 */
function extractQueryIds(jsContent) {
  const found = {};
  for (const opName of TARGET_OPERATIONS) {
    // Two common patterns in Twitter's bundles:
    // 1. {queryId:"abc123",operationName:"UserTweetsAndReplies"
    // 2. queryId:"abc123",operationName:"UserTweetsAndReplies"
    const patterns = [
      new RegExp(`queryId:"([^"]+)",operationName:"${opName}"`),
      new RegExp(`queryId:\\s*"([^"]+)"\\s*,\\s*operationName:\\s*"${opName}"`),
      new RegExp(`\\{queryId:"([^"]+)",operationName:"${opName}"`),
    ];

    for (const re of patterns) {
      const m = jsContent.match(re);
      if (m) {
        found[opName] = m[1];
        break;
      }
    }
  }
  return found;
}

/**
 * Resolve all target queryIds from Twitter's live JS bundles.
 * Results are cached for 1 hour.
 * 
 * @returns {Object} Map of operationName -> queryId
 */
async function resolveQueryIds() {
  // Return cached if fresh enough
  if (cachedEndpoints && (Date.now() - cacheTime) < CACHE_TTL) {
    return cachedEndpoints;
  }

  console.log('[QueryResolver] Fetching fresh queryIds from Twitter...');

  try {
    const urls = await getScriptUrls();
    console.log(`[QueryResolver] Found ${urls.length} JS bundles to scan`);

    const allFound = {};

    for (const url of urls) {
      // Skip if we already found everything
      if (TARGET_OPERATIONS.every(op => allFound[op])) break;

      try {
        const { data: js } = await axios.get(url, {
          headers: { 'User-Agent': UA },
          timeout: 15000,
        });
        const found = extractQueryIds(js);
        Object.assign(allFound, found);

        if (Object.keys(found).length > 0) {
          console.log(`[QueryResolver] Found ${Object.keys(found).join(', ')} in ${url.split('/').pop()}`);
        }
      } catch {
        // Skip failed bundles
      }
    }

    if (Object.keys(allFound).length > 0) {
      cachedEndpoints = allFound;
      cacheTime = Date.now();
      console.log('[QueryResolver] Resolved:', JSON.stringify(allFound, null, 2));
    } else {
      console.error('[QueryResolver] Could not find any queryIds in Twitter bundles');
    }

    return allFound;
  } catch (err) {
    console.error('[QueryResolver] Failed to resolve queryIds:', err.message);
    return cachedEndpoints || {};
  }
}

/**
 * Get the queryId for a specific operation, resolving dynamically if needed.
 * 
 * @param {string} operationName - e.g. 'UserTweetsAndReplies'
 * @returns {string|null} The queryId, or null if not found
 */
async function getQueryId(operationName) {
  const ids = await resolveQueryIds();
  return ids[operationName] || null;
}

/**
 * Clear the cache to force a fresh resolve on next call.
 */
function clearCache() {
  cachedEndpoints = null;
  cacheTime = 0;
}

module.exports = {
  resolveQueryIds,
  getQueryId,
  clearCache,
};

// If run directly, print the results
if (require.main === module) {
  resolveQueryIds().then(ids => {
    console.log('\nResults:');
    for (const [op, id] of Object.entries(ids)) {
      console.log(`  ${op}: ${id}`);
    }
    if (!Object.keys(ids).length) {
      console.log('  (none found)');
    }
  });
}
