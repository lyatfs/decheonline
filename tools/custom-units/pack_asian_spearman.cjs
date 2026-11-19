const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

async function packAsianSpearman() {
  const imagePath = path.join(__dirname, 'asian_spearman_sheet1.png');
  const f1Base64 = fs.readFileSync(imagePath).toString('base64');

  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();

  const generated = await page.evaluate(async (b64) => {
    function loadImg(b64) {
      return new Promise(res => {
        const img = new Image();
        img.onload = () => res(img);
        img.src = 'data:image/png;base64,' + b64;
      });
    }

    const img = await loadImg(b64);
    const srcCvs = document.createElement('canvas');
    srcCvs.width = img.width;
    srcCvs.height = img.height;
    const sCtx = srcCvs.getContext('2d');
    sCtx.drawImage(img, 0, 0);

    const isBg = (r, g, b, a) => a < 20 || (r > 240 && g > 240 && b > 240);

    function shiftColor(data, owner) {
      if (owner === 2) return; // Keep original red
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i+1], b = data[i+2], a = data[i+3];
        if (a < 20) continue;
        if (r > 100 && r > g * 1.35 && r > b * 1.35) {
          if (owner === 1) { // Blue
            data[i] = Math.round(b * 0.4 + g * 0.2);
            data[i+1] = Math.round(g * 0.7 + r * 0.2);
            data[i+2] = Math.min(255, Math.round(r * 1.25 + 30));
          } else if (owner === 3) { // Yellow
            data[i] = Math.min(255, Math.round(r * 1.1));
            data[i+1] = Math.min(255, Math.round(r * 0.95));
            data[i+2] = Math.round(b * 0.3);
          } else if (owner === 4) { // Cyan/Teal
            data[i] = Math.round(r * 0.2);
            data[i+1] = Math.min(255, Math.round(r * 0.9));
            data[i+2] = Math.min(255, Math.round(r * 0.9));
          }
        }
      }
    }

    const SCALE = 0.38; // Downscale to match AoE 1 isometric proportion (tall slender warrior ~45-55px)

    const rows = [
      { name: 'standing', id: 950, y1: 5, y2: 185, cols: 8, angleCount: 8, frameCount: 1, duration: 0.2, layer: 20 },
      { name: 'walking', id: 951, y1: 200, y2: 350, cols: 8, angleCount: 1, frameCount: 8, duration: 0.08, layer: 20 },
      { name: 'attack', id: 952, y1: 355, y2: 515, cols: 10, angleCount: 1, frameCount: 10, duration: 0.09, layer: 20 },
      { name: 'dying', id: 953, y1: 520, y2: 678, cols: 8, angleCount: 1, frameCount: 8, duration: 0.1, layer: 20 }
    ];

    const results = {};

    for (const r of rows) {
      const colW = img.width / r.cols;
      const rawFrames = [];

      for (let c = 0; c < r.cols; c++) {
        const rx1 = Math.round(c * colW);
        const rx2 = Math.round((c + 1) * colW);
        const rw = rx2 - rx1;
        const rh = r.y2 - r.y1;

        const cellData = sCtx.getImageData(rx1, r.y1, rw, rh).data;
        let minX = rw, maxX = 0, minY = rh, maxY = 0;
        let count = 0;

        for (let y = 0; y < rh; y++) {
          for (let x = 0; x < rw; x++) {
            const idx = (y * rw + x) * 4;
            if (!isBg(cellData[idx], cellData[idx+1], cellData[idx+2], cellData[idx+3])) {
              if (x < minX) minX = x;
              if (x > maxX) maxX = x;
              if (y < minY) minY = y;
              if (y > maxY) maxY = y;
              count++;
            }
          }
        }

        if (count > 10 && minX <= maxX && minY <= maxY) {
          const cropW = maxX - minX + 1;
          const cropH = maxY - minY + 1;
          const cropX = rx1 + minX;
          const cropY = r.y1 + minY;

          // Scaled size
          const sw = Math.max(1, Math.round(cropW * SCALE));
          const sh = Math.max(1, Math.round(cropH * SCALE));
          const hX = Math.round(sw / 2);
          const hY = sh - 2;

          rawFrames.push({
            cropX, cropY, cropW, cropH,
            sw, sh,
            hotspotX: hX,
            hotspotY: hY
          });
        }
      }

      let totalH = 0;
      let maxW = 0;
      for (const f of rawFrames) {
        totalH += f.sh;
        if (f.sw > maxW) maxW = f.sw;
      }

      const packFrames = [];
      let curY = 0;

      for (let fi = 0; fi < rawFrames.length; fi++) {
        const f = rawFrames[fi];
        packFrames.push({
          x: 0,
          y: curY,
          w: f.sw,
          h: f.sh,
          hotspotX: f.hotspotX,
          hotspotY: f.hotspotY
        });
        curY += f.sh;
      }

      const atlases = {};

      for (const owner of [1, 2, 3, 4]) {
        const aCvs = document.createElement('canvas');
        aCvs.width = maxW;
        aCvs.height = totalH;
        const aCtx = aCvs.getContext('2d');
        aCtx.imageSmoothingEnabled = true;

        for (let fi = 0; fi < rawFrames.length; fi++) {
          const f = rawFrames[fi];
          const pf = packFrames[fi];
          const spriteData = sCtx.getImageData(f.cropX, f.cropY, f.cropW, f.cropH);

          for (let i = 0; i < spriteData.data.length; i += 4) {
            if (isBg(spriteData.data[i], spriteData.data[i+1], spriteData.data[i+2], spriteData.data[i+3])) {
              spriteData.data[i+3] = 0;
            }
          }

          shiftColor(spriteData.data, owner);

          const tmp = document.createElement('canvas');
          tmp.width = f.cropW;
          tmp.height = f.cropH;
          tmp.getContext('2d').putImageData(spriteData, 0, 0);

          // Draw scaled down
          aCtx.drawImage(tmp, 0, 0, f.cropW, f.cropH, pf.x, pf.y, f.sw, f.sh);
        }

        atlases[owner] = aCvs.toDataURL('image/png');
      }

      results[r.name] = {
        id: r.id,
        angleCount: r.angleCount,
        frameCount: r.frameCount,
        duration: r.duration,
        layer: r.layer,
        packFrames,
        atlasWidth: maxW,
        atlasHeight: totalH,
        atlases
      };
    }

    // Extract Icon (50x50) from unscaled standing frame 0
    const st0 = results.standing.packFrames[0];
    const iconCvs = document.createElement('canvas');
    iconCvs.width = 50;
    iconCvs.height = 50;
    const iCtx = iconCvs.getContext('2d');
    iCtx.imageSmoothingEnabled = true;

    // Load full resolution standing frame 0
    const cropX = Math.round(0);
    const sData = sCtx.getImageData(25, 10, 80, 165);
    for (let i = 0; i < sData.data.length; i += 4) {
      if (isBg(sData.data[i], sData.data[i+1], sData.data[i+2], sData.data[i+3])) {
        sData.data[i+3] = 0;
      }
    }
    shiftColor(sData.data, 1); // Blue player icon
    const tmpIcon = document.createElement('canvas');
    tmpIcon.width = 80;
    tmpIcon.height = 165;
    tmpIcon.getContext('2d').putImageData(sData, 0, 0);

    iCtx.drawImage(tmpIcon, 0, 0, 80, 165, 4, 1, 42, 48);
    const iconDataUrl = iconCvs.toDataURL('image/png');

    return { results, iconDataUrl };
  }, f1Base64);

  await browser.close();
  return generated;
}

packAsianSpearman().then(async ({ results, iconDataUrl }) => {
  const rootDir = path.resolve(__dirname, '../..');
  const gDir = path.join(rootDir, 'assets-local/pack/sprites/graphics');
  for (const [actionName, data] of Object.entries(results)) {
    for (const [owner, dataUrl] of Object.entries(data.atlases)) {
      const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      const outPath = path.join(gDir, `${data.id}.o${owner}.png`);
      fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
    }
    console.log(`Saved scaled graphics ${data.id} (${actionName}) atlases.`);
  }

  const manifestPath = path.join(rootDir, 'assets-local/pack/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  for (const [actionName, data] of Object.entries(results)) {
    const slpKey = `graphics/${data.id}`;
    manifest.slps[slpKey] = {
      source: 'graphics',
      id: data.id,
      atlasWidth: data.atlasWidth,
      atlasHeight: data.atlasHeight,
      frames: data.packFrames,
      playerColour: true
    };

    manifest.graphics[data.id] = {
      name: `AsianSpear_${actionName}`,
      slp: slpKey,
      frameCount: data.frameCount,
      angleCount: data.angleCount,
      mirroringMode: 0,
      frameDuration: data.duration,
      layer: data.layer,
      deltas: [],
      sound: actionName === 'attack' ? 38 : -1,
      frameSounds: null
    };
  }

  // Update dead unit
  const dyingData = results.dying;
  const lastDyingFrame = dyingData.packFrames[dyingData.packFrames.length - 1];
  manifest.slps['graphics/954'] = {
    source: 'graphics',
    id: 954,
    atlasWidth: dyingData.atlasWidth,
    atlasHeight: dyingData.atlasHeight,
    frames: [lastDyingFrame],
    playerColour: true
  };
  manifest.graphics[954] = {
    name: 'AsianSpear_dead',
    slp: 'graphics/953',
    frameCount: 1,
    angleCount: 1,
    mirroringMode: 0,
    frameDuration: 15,
    layer: 10,
    deltas: [],
    sound: -1,
    frameSounds: null
  };

  // Update icon in 50730.o1.png
  const iconB64 = iconDataUrl.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(path.join(rootDir, 'assets-local/pack/sprites/interface/icon_asian_spear.png'), Buffer.from(iconB64, 'base64'));

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log('Manifest updated with perfectly scaled Asian Spearman!');
}).catch(console.error);
