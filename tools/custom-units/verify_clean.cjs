const path = require('path');
const { chromium } = require('playwright');

async function captureCleanGame() {
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

  console.log('Navigating to http://localhost:8787/?debug=combat');
  await page.goto('http://localhost:8787/?debug=combat');

  await page.waitForSelector('canvas[data-testid="game-canvas"]', { state: 'visible', timeout: 15000 });

  // Wait 1.2 seconds for walking
  await page.waitForTimeout(1200);

  const artifactDir = 'C:/Users/lehon/.gemini/antigravity/brain/a549dc14-1983-4eec-8a36-8eb122959484';
  const outPath1 = path.join(artifactDir, 'in_game_clean_spearman_walk.png');
  await page.screenshot({ path: outPath1 });
  console.log('Saved screenshot 1 (walking) to:', outPath1);

  // Wait another 2.5 seconds for combat thrusting
  await page.waitForTimeout(2500);
  const outPath2 = path.join(artifactDir, 'in_game_clean_spearman_combat.png');
  await page.screenshot({ path: outPath2 });
  console.log('Saved screenshot 2 (combat) to:', outPath2);

  await browser.close();
}

captureCleanGame().catch(console.error);
