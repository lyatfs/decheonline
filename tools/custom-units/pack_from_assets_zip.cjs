const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

async function processAll() {
  const rootDir = path.resolve(__dirname, '../..');
  const zipDir = path.join(__dirname, 'extracted_zip');
  const sheet1Path = path.join(__dirname, 'asian_spearman_sheet1.png');

  console.log('Launching browser to process assets...');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();

  // Read all source images to base64
  const sheet1B64 = fs.readFileSync(sheet1Path).toString('base64');

  const moveFilesB64 = [];
  for (let i = 0; i < 8; i++) {
    const p = path.join(zipDir, 'move_east', `move_east_0${i}.png`);
    moveFilesB64.push(fs.readFileSync(p).toString('base64'));
  }

  const attackFilesB64 = [];
  for (let i = 0; i < 8; i++) {
    const p = path.join(zipDir, 'attack_thrust_east', `attack_thrust_east_0${i}.png`);
    attackFilesB64.push(fs.readFileSync(p).toString('base64'));
  }

  const deathFilesB64 = [];
  for (let i = 0; i < 8; i++) {
    const p = path.join(zipDir, 'death_east', `death_east_0${i}.png`);
    deathFilesB64.push(fs.readFileSync(p).toString('base64'));
  }

  const packedData = await page.evaluate(async ({ sheet1B64, moveFilesB64, attackFilesB64, deathFilesB64 }) => {
    function loadImg(b64) {
      return new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.src = 'data:image/png;base64,' + b64;
      });
    }

    const SCALE = 0.25;

    function isBg(r, g, b, a) {
      return a < 25 || (r > 240 && g > 240 && b > 240);
    }

    function shiftColor(data, owner) {
      if (owner === 2) return; // Keep authentic red
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        if (a < 25) continue;
        // Target red plumes, cape, tunic trim
        if (r > 100 && r > g * 1.3 && r > b * 1.3) {
          if (owner === 1) { // Blue
            data[i] = Math.round(b * 0.4 + g * 0.2);
            data[i + 1] = Math.round(g * 0.7 + r * 0.2);
            data[i + 2] = Math.min(255, Math.round(r * 1.25 + 30));
          } else if (owner === 3) { // Yellow
            data[i] = Math.min(255, Math.round(r * 1.1));
            data[i + 1] = Math.min(255, Math.round(r * 0.95));
            data[i + 2] = Math.round(b * 0.3);
          } else if (owner === 4) { // Teal / Cyan
            data[i] = Math.round(r * 0.2);
            data[i + 1] = Math.min(255, Math.round(r * 0.9));
            data[i + 2] = Math.min(255, Math.round(r * 0.9));
          }
        }
      }
    }

    // Clean a single frame image: isolates the central soldier component and removes any border artifacts/bleed
    function cleanSingleImage(img) {
      const cvs = document.createElement('canvas');
      cvs.width = img.width;
      cvs.height = img.height;
      const ctx = cvs.getContext('2d');
      ctx.drawImage(img, 0, 0);
      const imgData = ctx.getImageData(0, 0, img.width, img.height);
      const data = imgData.data;

      const visited = new Uint8Array(img.width * img.height);
      const comps = [];

      for (let y = 0; y < img.height; y++) {
        for (let x = 0; x < img.width; x++) {
          const idx = y * img.width + x;
          if (visited[idx]) continue;
          visited[idx] = 1;
          if (isBg(data[idx * 4], data[idx * 4 + 1], data[idx * 4 + 2], data[idx * 4 + 3])) continue;

          let count = 0;
          let minX = x, maxX = x, minY = y, maxY = y;
          const pixels = [idx];
          const q = [x, y];
          let head = 0;

          while (head < q.length) {
            const qx = q[head++];
            const qy = q[head++];
            count++;
            if (qx < minX) minX = qx;
            if (qx > maxX) maxX = qx;
            if (qy < minY) minY = qy;
            if (qy > maxY) maxY = qy;

            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const nx = qx + dx;
                const ny = qy + dy;
                if (nx >= 0 && nx < img.width && ny >= 0 && ny < img.height) {
                  const nidx = ny * img.width + nx;
                  if (!visited[nidx]) {
                    visited[nidx] = 1;
                    if (!isBg(data[nidx * 4], data[nidx * 4 + 1], data[nidx * 4 + 2], data[nidx * 4 + 3])) {
                      q.push(nx, ny);
                      pixels.push(nidx);
                    }
                  }
                }
              }
            }
          }

          // A valid component must not be just a tiny border sliver
          comps.push({ count, minX, maxX, minY, maxY, pixels });
        }
      }

      // Sort by size
      comps.sort((a, b) => b.count - a.count);
      const mainComp = comps[0];

      // Keep only pixels belonging to mainComp
      const keep = new Set(mainComp.pixels);
      for (let i = 0; i < img.width * img.height; i++) {
        if (!keep.has(i)) {
          data[i * 4 + 3] = 0;
        }
      }

      // Calculate foot position: bottom-most rows of the soldier
      const footY = mainComp.maxY;
      let sumFootX = 0, countFoot = 0;
      for (const idx of mainComp.pixels) {
        const py = Math.floor(idx / img.width);
        const px = idx % img.width;
        if (py >= footY - 12) {
          sumFootX += px;
          countFoot++;
        }
      }
      const rawFootX = countFoot > 0 ? (sumFootX / countFoot) : ((mainComp.minX + mainComp.maxX) / 2);

      const cropW = mainComp.maxX - mainComp.minX + 1;
      const cropH = mainComp.maxY - mainComp.minY + 1;

      // Extract raw cropped canvas
      const rawCvs = document.createElement('canvas');
      rawCvs.width = cropW;
      rawCvs.height = cropH;
      const rCtx = rawCvs.getContext('2d');
      const croppedData = rCtx.createImageData(cropW, cropH);

      for (let cy = 0; cy < cropH; cy++) {
        for (let cx = 0; cx < cropW; cx++) {
          const sx = mainComp.minX + cx;
          const sy = mainComp.minY + cy;
          const sIdx = (sy * img.width + sx) * 4;
          const dIdx = (cy * cropW + cx) * 4;
          croppedData.data[dIdx] = data[sIdx];
          croppedData.data[dIdx + 1] = data[sIdx + 1];
          croppedData.data[dIdx + 2] = data[sIdx + 2];
          croppedData.data[dIdx + 3] = data[sIdx + 3];
        }
      }
      rCtx.putImageData(croppedData, 0, 0);

      // Scaled dimensions
      const sw = Math.max(1, Math.round(cropW * SCALE));
      const sh = Math.max(1, Math.round(cropH * SCALE));
      const hotspotX = Math.round((rawFootX - mainComp.minX) * SCALE);
      const hotspotY = sh - 2;

      return {
        rawCanvas: rawCvs,
        cropW, cropH,
        sw, sh,
        hotspotX, hotspotY
      };
    }

    // 1. Process Standing (Row 1 of Sheet 1: 8 clean directions)
    const s1Img = await loadImg(sheet1B64);
    const s1Cvs = document.createElement('canvas');
    s1Cvs.width = s1Img.width;
    s1Cvs.height = s1Img.height;
    const s1Ctx = s1Cvs.getContext('2d');
    s1Ctx.drawImage(s1Img, 0, 0);

    const standingFrames = [];
    // 8 distinct non-overlapping bounds in Row 1 (y: 5 to 180)
    const standingBounds = [
      { minX: 34, maxX: 117, minY: 7, maxY: 176 },
      { minX: 162, maxX: 238, minY: 9, maxY: 176 },
      { minX: 288, maxX: 359, minY: 10, maxY: 175 },
      { minX: 410, maxX: 480, minY: 18, maxY: 176 },
      { minX: 534, maxX: 612, minY: 16, maxY: 173 },
      { minX: 661, maxX: 739, minY: 9, maxY: 173 },
      { minX: 778, maxX: 857, minY: 8, maxY: 173 },
      { minX: 897, maxX: 969, minY: 7, maxY: 174 }
    ];

    for (const b of standingBounds) {
      const cw = b.maxX - b.minX + 1;
      const ch = b.maxY - b.minY + 1;
      const fCvs = document.createElement('canvas');
      fCvs.width = cw;
      fCvs.height = ch;
      const fCtx = fCvs.getContext('2d');
      const d = s1Ctx.getImageData(b.minX, b.minY, cw, ch);
      for (let i = 0; i < d.data.length; i += 4) {
        if (isBg(d.data[i], d.data[i + 1], d.data[i + 2], d.data[i + 3])) {
          d.data[i + 3] = 0;
        }
      }
      fCtx.putImageData(d, 0, 0);

      const sw = Math.round(cw * SCALE);
      const sh = Math.round(ch * SCALE);
      standingFrames.push({
        rawCanvas: fCvs,
        cropW: cw, cropH: ch,
        sw, sh,
        hotspotX: Math.round(sw / 2),
        hotspotY: sh - 2
      });
    }

    // 2. Process Move East (8 frames from zip)
    const moveFrames = [];
    for (const b64 of moveFilesB64) {
      const img = await loadImg(b64);
      moveFrames.push(cleanSingleImage(img));
    }

    // 3. Process Attack Thrust East (8 frames from zip)
    const attackFrames = [];
    for (const b64 of attackFilesB64) {
      const img = await loadImg(b64);
      attackFrames.push(cleanSingleImage(img));
    }

    // 4. Process Death East (8 frames from zip)
    const deathFrames = [];
    for (const b64 of deathFilesB64) {
      const img = await loadImg(b64);
      deathFrames.push(cleanSingleImage(img));
    }

    // Pack into vertical atlases
    function buildAtlas(frames, angleCount, frameCount, duration, layer, soundId) {
      let maxW = 0;
      let totalH = 0;
      for (const f of frames) {
        if (f.sw > maxW) maxW = f.sw;
        totalH += f.sh;
      }

      const packFrames = [];
      let curY = 0;
      for (const f of frames) {
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

        for (let fi = 0; fi < frames.length; fi++) {
          const f = frames[fi];
          const pf = packFrames[fi];

          // Draw raw canvas scaled and color shifted
          const tmp = document.createElement('canvas');
          tmp.width = f.cropW;
          tmp.height = f.cropH;
          const tCtx = tmp.getContext('2d');
          tCtx.drawImage(f.rawCanvas, 0, 0);

          const tData = tCtx.getImageData(0, 0, f.cropW, f.cropH);
          shiftColor(tData.data, owner);
          tCtx.putImageData(tData, 0, 0);

          aCtx.drawImage(tmp, 0, 0, f.cropW, f.cropH, 0, pf.y, f.sw, f.sh);
        }

        atlases[owner] = aCvs.toDataURL('image/png');
      }

      return {
        atlasWidth: maxW,
        atlasHeight: totalH,
        packFrames,
        atlases,
        angleCount,
        frameCount,
        duration,
        layer,
        sound: soundId
      };
    }

    const results = {
      standing: buildAtlas(standingFrames, 8, 1, 0.2, 20, -1),
      walking: buildAtlas(moveFrames, 1, 8, 0.08, 20, -1),
      attack: buildAtlas(attackFrames, 1, 8, 0.09, 20, 38),
      dying: buildAtlas(deathFrames, 1, 8, 0.1, 20, -1)
    };

    // Build HUD Icon (50x50) from Standing Frame 0
    const iconCvs = document.createElement('canvas');
    iconCvs.width = 50;
    iconCvs.height = 50;
    const iCtx = iconCvs.getContext('2d');
    iCtx.imageSmoothingEnabled = true;

    const st0 = standingFrames[0];
    const iconTmp = document.createElement('canvas');
    iconTmp.width = st0.cropW;
    iconTmp.height = st0.cropH;
    const itCtx = iconTmp.getContext('2d');
    itCtx.drawImage(st0.rawCanvas, 0, 0);
    const iData = itCtx.getImageData(0, 0, st0.cropW, st0.cropH);
    shiftColor(iData.data, 1); // Blue player icon
    itCtx.putImageData(iData, 0, 0);

    iCtx.drawImage(iconTmp, 0, 0, st0.cropW, st0.cropH, 6, 2, 38, 46);
    const iconDataUrl = iconCvs.toDataURL('image/png');

    return { results, iconDataUrl };
  }, { sheet1B64, moveFilesB64, attackFilesB64, deathFilesB64 });

  await browser.close();

  // Save atlases to disk
  const gDir = path.join(rootDir, 'assets-local/pack/sprites/graphics');
  const actionToId = { standing: 950, walking: 951, attack: 952, dying: 953 };

  for (const [actionName, id] of Object.entries(actionToId)) {
    const data = packedData.results[actionName];
    for (const [owner, dataUrl] of Object.entries(data.atlases)) {
      const b64 = dataUrl.replace(/^data:image\/png;base64,/, '');
      const outPath = path.join(gDir, `${id}.o${owner}.png`);
      fs.writeFileSync(outPath, Buffer.from(b64, 'base64'));
    }
    console.log(`Saved clean graphic ${id} (${actionName}) atlases.`);
  }

  // Dead unit graphic (954)
  const dyingData = packedData.results.dying;
  const lastDyingFrame = dyingData.packFrames[dyingData.packFrames.length - 1];

  // Update manifest.json
  const manifestPath = path.join(rootDir, 'assets-local/pack/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

  for (const [actionName, id] of Object.entries(actionToId)) {
    const data = packedData.results[actionName];
    const slpKey = `graphics/${id}`;
    manifest.slps[slpKey] = {
      source: 'graphics',
      id,
      atlasWidth: data.atlasWidth,
      atlasHeight: data.atlasHeight,
      frames: data.packFrames,
      playerColour: true
    };

    manifest.graphics[id] = {
      name: `AsianSpear_${actionName}`,
      slp: slpKey,
      frameCount: data.frameCount,
      angleCount: data.angleCount,
      mirroringMode: 0,
      frameDuration: data.duration,
      layer: data.layer,
      deltas: [],
      sound: data.sound,
      frameSounds: null
    };
  }

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

  // Update HUD Icon
  const iconB64 = packedData.iconDataUrl.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(path.join(rootDir, 'assets-local/pack/sprites/interface/icon_asian_spear.png'), Buffer.from(iconB64, 'base64'));

  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log('Successfully updated manifest.json and clean atlases with 0 border artifacts!');
}

processAll().catch(console.error);
