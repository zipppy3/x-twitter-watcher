'use strict';

/**
 * One-off script to upload old `.m4a` and `.txt` space recordings
 * to Telegram using the existing notify.js logic.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { uploadTelegramAudio, uploadTelegramDocument } = require('./notify');
const watchlist = require('./watchlist-manager');

const DOWNLOAD_DIR = path.join(__dirname, 'download');

async function uploadOldRecordings() {
  console.log('🔄 Scanning for old Space recordings to upload...\n');

  if (!fs.existsSync(DOWNLOAD_DIR)) {
    console.log('❌ Download directory not found.');
    return;
  }

  const users = fs.readdirSync(DOWNLOAD_DIR)
    .filter(f => fs.statSync(path.join(DOWNLOAD_DIR, f)).isDirectory());

  let totalUploaded = 0;

  for (const user of users) {
    const userDir = path.join(DOWNLOAD_DIR, user);
    const files = fs.readdirSync(userDir)
      .filter(f => !fs.statSync(path.join(userDir, f)).isDirectory());

    const m4aFiles = files.filter(f => f.endsWith('.m4a'));

    if (m4aFiles.length > 0) {
      console.log(`📁 Found ${m4aFiles.length} recording(s) for @${user}`);
    }

    const audioTopicId = watchlist.getTopicId(user, 'audio');
    const metaTopicId = watchlist.getTopicId(user, 'metadata');

    for (const audioFile of m4aFiles) {
      const audioPath = path.join(userDir, audioFile);
      const baseName = path.basename(audioFile, '.m4a');
      const metaName = `${baseName} — speakers.txt`;
      const metaPath = path.join(userDir, metaName);

      let title = baseName;
      let durationSec = 0;

      // Try to parse metadata if it exists
      if (fs.existsSync(metaPath)) {
        try {
          const content = fs.readFileSync(metaPath, 'utf8');
          const titleMatch = content.match(/Space:\s+"(.*?)"/);
          if (titleMatch) title = titleMatch[1];

          const durMatch = content.match(/Duration:\s+(\d+):(\d+):(\d+)/);
          if (durMatch) {
            durationSec = parseInt(durMatch[1]) * 3600 + parseInt(durMatch[2]) * 60 + parseInt(durMatch[3]);
          }
        } catch (e) {
          // ignore parsing errors
        }
      }

      console.log(`\n  Uploading: ${title}`);
      
      // Upload Audio
      console.log(`  -> Sending audio...`);
      const okAudio = await uploadTelegramAudio(audioPath, title, user, durationSec, audioTopicId);
      if (!okAudio) {
        console.log(`  ❌ Failed to upload audio: ${audioFile}`);
        continue;
      }
      
      // Upload Metadata if exists
      if (fs.existsSync(metaPath)) {
        console.log(`  -> Sending metadata...`);
        await uploadTelegramDocument(metaPath, metaTopicId);
      }

      totalUploaded++;
    }
  }

  console.log(`\n✅ Finished uploading ${totalUploaded} old recording(s).`);
}

uploadOldRecordings().catch(console.error);
