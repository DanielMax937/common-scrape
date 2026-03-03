#!/usr/bin/env node
/**
 * Browser Profile Launcher
 * 
 * Launches Chrome with a specific profile for manual login and setup.
 * Sessions are persisted in browser-profiles/browser-{id}/ directories.
 * 
 * Usage:
 *   node launch-browser.js <profile-id>
 *   node launch-browser.js 1
 *   node launch-browser.js 2
 * 
 * Or with npm:
 *   npm run browser 1
 *   npm run browser 2
 */

const { chromium } = require('patchright');
const path = require('path');
const fs = require('fs');

const PROJECT_ROOT = __dirname;

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(`
Browser Profile Launcher
========================

Launches Chrome with a specific profile for manual login and setup.

Usage:
  node launch-browser.js <profile-id>
  npm run browser <profile-id>

Examples:
  node launch-browser.js 1        # Launch profile 1
  node launch-browser.js 2        # Launch profile 2
  npm run browser 1               # Launch profile 1 via npm
  npm run browser 2               # Launch profile 2 via npm

What to do after launching:
  1. Browser opens with the specified profile
  2. Navigate to platforms you want to scrape:
     - Twitter/X: https://x.com (log in)
     - Weibo: https://weibo.com (log in)
  3. Complete login for all platforms
  4. Close the browser when done
  5. Your sessions will be saved in browser-profiles/browser-{id}/

Profile storage: browser-profiles/browser-{id}/
`);
    process.exit(0);
  }

  const profileId = parseInt(args[0], 10);
  
  if (isNaN(profileId) || profileId < 1) {
    console.error('❌ Error: Profile ID must be a positive number (1, 2, 3, ...)');
    console.error('   Usage: node launch-browser.js <profile-id>');
    process.exit(1);
  }

  const userDataDir = path.join(PROJECT_ROOT, 'browser-profiles', `browser-${profileId}`);
  
  console.log('');
  console.log('╔═══════════════════════════════════════════════════════════╗');
  console.log('║          🌐 Browser Profile Launcher                     ║');
  console.log('╠═══════════════════════════════════════════════════════════╣');
  console.log(`║  Profile:   ${String(profileId).padEnd(46)} ║`);
  console.log(`║  Location:  ${userDataDir.substring(0, 46).padEnd(46)} ║`);
  console.log('╚═══════════════════════════════════════════════════════════╝');
  console.log('');

  // Create browser-profiles directory if it doesn't exist
  const profilesDir = path.join(PROJECT_ROOT, 'browser-profiles');
  if (!fs.existsSync(profilesDir)) {
    fs.mkdirSync(profilesDir, { recursive: true });
    console.log(`✓ Created browser-profiles directory`);
  }

  // Check if profile exists (first time vs returning)
  const isNewProfile = !fs.existsSync(userDataDir);
  if (isNewProfile) {
    console.log(`📁 Creating new profile #${profileId}...`);
  } else {
    console.log(`📂 Loading existing profile #${profileId}...`);
  }

  // Load proxy configuration if available
  const launchOptions = {
    channel: 'chrome',
    headless: false,
  };

  const proxyConfigPath = path.join(PROJECT_ROOT, 'proxy-config.json');
  if (fs.existsSync(proxyConfigPath)) {
    try {
      const proxies = JSON.parse(fs.readFileSync(proxyConfigPath, 'utf-8'));
      const proxyIndex = profileId - 1;
      if (Array.isArray(proxies) && proxies[proxyIndex]) {
        const proxy = proxies[proxyIndex];
        launchOptions.proxy = {
          server: `http://${proxy.server}`,
          username: proxy.username,
          password: proxy.password,
        };
        console.log(`🔒 Using proxy: ${proxy.server}`);
      }
    } catch (err) {
      console.warn(`⚠️  Failed to load proxy config: ${err.message}`);
    }
  }

  console.log('');
  console.log('🚀 Launching Chrome...');
  console.log('');
  
  if (isNewProfile) {
    console.log('📝 Setup Instructions:');
    console.log('   1. Browser will open in a moment');
    console.log('   2. Navigate to platforms you want to use:');
    console.log('      • Twitter/X: https://x.com');
    console.log('      • Weibo: https://weibo.com');
    console.log('   3. Log in to each platform');
    console.log('   4. Close the browser when done');
    console.log('   5. Your login sessions will be saved');
    console.log('');
  } else {
    console.log('✓ Your previous login sessions will be restored');
    console.log('');
  }

  try {
    const context = await chromium.launchPersistentContext(userDataDir, launchOptions);
    
    // Grant clipboard permissions
    try {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    } catch (err) {
      // Not critical
    }

    // Open a welcome page
    const page = await context.newPage();
    
    const welcomeHTML = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>Browser Profile ${profileId}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      max-width: 800px;
      margin: 50px auto;
      padding: 20px;
      background: #f5f5f5;
    }
    .container {
      background: white;
      padding: 40px;
      border-radius: 8px;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }
    h1 { color: #333; margin-top: 0; }
    h2 { color: #666; margin-top: 30px; }
    .profile-badge {
      display: inline-block;
      background: #007bff;
      color: white;
      padding: 8px 16px;
      border-radius: 20px;
      font-size: 14px;
      font-weight: bold;
      margin-bottom: 20px;
    }
    .platform-list {
      list-style: none;
      padding: 0;
    }
    .platform-list li {
      margin: 10px 0;
      padding: 15px;
      background: #f8f9fa;
      border-radius: 4px;
      border-left: 4px solid #007bff;
    }
    .platform-list a {
      color: #007bff;
      text-decoration: none;
      font-weight: 600;
    }
    .platform-list a:hover {
      text-decoration: underline;
    }
    .info-box {
      background: #e7f3ff;
      padding: 15px;
      border-radius: 4px;
      border-left: 4px solid #0066cc;
      margin: 20px 0;
    }
    .success-box {
      background: #d4edda;
      padding: 15px;
      border-radius: 4px;
      border-left: 4px solid #28a745;
      margin: 20px 0;
    }
    code {
      background: #f4f4f4;
      padding: 2px 6px;
      border-radius: 3px;
      font-family: 'Courier New', monospace;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="profile-badge">Profile ${profileId}</div>
    <h1>🌐 Browser Profile Launcher</h1>
    
    ${isNewProfile ? `
    <div class="info-box">
      <strong>🎉 New Profile Created!</strong><br>
      This is a fresh browser profile. Your login sessions will be saved when you close the browser.
    </div>
    ` : `
    <div class="success-box">
      <strong>✓ Existing Profile Loaded</strong><br>
      Your previous login sessions have been restored.
    </div>
    `}
    
    <h2>📝 Quick Login Guide</h2>
    <p>Navigate to the platforms you want to use and log in:</p>
    
    <ul class="platform-list">
      <li>
        <strong>Twitter/X</strong><br>
        <a href="https://x.com" target="_blank">https://x.com</a>
        <div style="color: #666; font-size: 13px; margin-top: 5px;">
          Required for: <code>npm run scrape:twitter</code>
        </div>
      </li>
      <li>
        <strong>Weibo (微博)</strong><br>
        <a href="https://weibo.com" target="_blank">https://weibo.com</a>
        <div style="color: #666; font-size: 13px; margin-top: 5px;">
          Required for: <code>npm run scrape:weibo</code>, <code>npm run scrape:weibo-user</code>
        </div>
      </li>
    </ul>
    
    <h2>🎯 Next Steps</h2>
    <ol>
      <li>Click the links above to open the platforms</li>
      <li>Log in to each platform you need</li>
      <li><strong>Keep browser open</strong> - sessions are saved automatically</li>
      <li>Close browser manually when you're done</li>
      <li>Run your scraping tasks: <code>npm run scrape:twitter -- --profile ${profileId}</code></li>
    </ol>
    
    <div class="info-box" style="margin-top: 20px;">
      <strong>💡 Tip:</strong> You can press <code>Ctrl+C</code> in the terminal to exit the launcher script. 
      The browser will continue running and your login sessions will be saved.
    </div>
    
    <h2>💾 Session Storage</h2>
    <p>Your login sessions are stored in:</p>
    <code>${userDataDir}</code>
    
    <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #ddd; color: #666; font-size: 13px;">
      Profile location: <code>browser-profiles/browser-${profileId}/</code><br>
      Profile size: ~135 MB (with login data)
    </div>
  </div>
</body>
</html>
    `;
    
    await page.setContent(welcomeHTML);
    
    console.log('✓ Browser launched successfully!');
    console.log('');
    console.log('👆 Click the links in the browser to log in to platforms');
    console.log('🔒 Close the browser manually when you are done');
    console.log('');
    console.log('💡 Your sessions will be saved automatically');
    console.log('');
    console.log('🎯 After closing, you can use this profile:');
    console.log(`   npm run scrape:twitter -- --profile ${profileId}`);
    console.log(`   npm run scrape:weibo -- --profile ${profileId}`);
    console.log('');
    console.log('⏳ Browser will stay open... (Press Ctrl+C to exit this script)');
    console.log('');
    
    // Keep the script running but don't wait for browser close
    // This allows the browser to stay open for pre-login
    // User can close browser manually when done
    
    // Keep process alive
    await new Promise(() => {}); // Never resolves, keeps script running
    
  } catch (error) {
    console.error('');
    console.error('❌ Error launching browser:', error.message);
    console.error('');
    process.exit(1);
  }
}

// Handle interruption
process.on('SIGINT', () => {
  console.log('\n\n🛑 Script interrupted');
  console.log('ℹ️  Browser will continue running in the background');
  console.log('💡 Close the browser manually when you are done with login');
  console.log('✅ Your sessions will be saved automatically\n');
  process.exit(0);
});

main().catch(err => {
  console.error('❌ Fatal error:', err);
  process.exit(1);
});
