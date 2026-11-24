import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditMultiplayerAssets } from '@aoe/assets-import/multiplayer-audit';
import { PACK_VERSION, type PackManifest } from '@aoe/assets-import/manifest';
import { defineConfig, type Plugin } from 'vite';

// Google Tag Manager (the captain's container; Google Analytics is configured inside it). Only in `vite build`, so dev sends
// nothing; the e2e config sets NO_GTM=1 so its build sends nothing either. An async script: a blocked host leaves the page as is.
const GTM_ID = 'GTM-PFVT9V9G';
const gtm = (): Plugin => ({
  name: 'gtm',
  apply: 'build',
  transformIndexHtml: () =>
    process.env.NO_GTM
      ? []
      : [
          {
            tag: 'script',
            injectTo: 'head-prepend',
            children: `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${GTM_ID}');`,
          },
          {
            tag: 'noscript',
            injectTo: 'body-prepend',
            children: `<iframe src="https://www.googletagmanager.com/ns.html?id=${GTM_ID}" height="0" width="0" style="display:none;visibility:hidden"></iframe>`,
          },
        ],
});

const CLIENT_ROOT = dirname(fileURLToPath(import.meta.url));
const BUILD_VERSION_META_RE = /<meta\s+name="aoe-build-version"\s+content="[^"]*">/gi;

function collectFilesSorted(rootDir: string, prefix = ''): string[] {
  const entries = readdirSync(rootDir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const files: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? posix.join(prefix, entry.name) : entry.name;
    const full = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFilesSorted(full, rel));
    } else if (entry.isFile()) {
      files.push(rel);
    }
  }
  return files;
}

function computeDistBuildId(distDir: string): string | null {
  const root = resolve(distDir);
  try {
    if (!statSync(root).isDirectory()) return null;
    const files = collectFilesSorted(root);
    if (!files.includes('index.html')) return null;
    const rawHtml = readFileSync(join(root, 'index.html'), 'utf8');
    if (!rawHtml || rawHtml.includes('/src/main.ts')) return null;
    if (!files.some((rel) => rel.startsWith('bundle/') && rel.endsWith('.js'))) return null;

    const digest = createHash('sha256');
    for (const rel of files) {
      const raw = readFileSync(join(root, ...rel.split('/')));
      const bytes =
        rel === 'index.html'
          ? Buffer.from(raw.toString('utf8').replace(BUILD_VERSION_META_RE, ''), 'utf8')
          : raw;
      digest.update(rel).update('\0').update(bytes);
    }
    return `build-${digest.digest('hex').slice(0, 16)}`;
  } catch {
    return null;
  }
}

function resolvePackFileSync(root: string, relPath: string): string | null {
  if (!relPath || isAbsolute(relPath)) return null;
  try {
    const base = resolve(root);
    const candidate = resolve(base, relPath);
    if (!candidate.startsWith(base + sep)) return null;
    const info = statSync(candidate);
    return info.isFile() && info.size > 0 ? candidate : null;
  } catch {
    return null;
  }
}

function computeAssetsPackId(assetsDir: string): string | null {
  try {
    const report = auditMultiplayerAssets(assetsDir);
    if (!report.ok) return null;
    const root = resolve(assetsDir);
    const hash = createHash('sha256').update(report.manifestHash || 'empty');
    const manifestFile = resolvePackFileSync(root, 'manifest.json');
    if (manifestFile) {
      const parsed = JSON.parse(readFileSync(manifestFile, 'utf8')) as Partial<PackManifest>;
      if (typeof parsed.palette === 'string') {
        const paletteFile = resolvePackFileSync(root, parsed.palette);
        if (paletteFile) hash.update('\0palette\0').update(readFileSync(paletteFile));
      }
      if (typeof parsed.dat === 'string') {
        const datFile = resolvePackFileSync(root, parsed.dat);
        if (datFile) hash.update('\0dat\0').update(readFileSync(datFile));
      }
    }
    const digest = hash.digest('hex').slice(0, 16);
    const versionTag = (report.packVersion || String(PACK_VERSION)).replace(/[^a-zA-Z0-9._-]/g, '').slice(0, 16) || '0';
    return `pack-${versionTag}-${digest}`.slice(0, 128);
  } catch {
    return null;
  }
}

export const buildVersionStamp = (outDir: string): Plugin => ({
  name: 'aoe-build-version-stamp',
  apply: 'build',
  closeBundle() {
    const buildId = computeDistBuildId(outDir);
    if (!buildId) return;
    const indexPath = join(outDir, 'index.html');
    const cleaned = readFileSync(indexPath, 'utf8').replace(BUILD_VERSION_META_RE, '');
    const metaTag = `<meta name="aoe-build-version" content="${buildId}">`;
    const stamped = cleaned.includes('</head>')
      ? cleaned.replace('</head>', `${metaTag}</head>`)
      : `${metaTag}${cleaned}`;
    writeFileSync(indexPath, stamped, 'utf8');
  },
});

const port = Number(process.env.CLIENT_PORT ?? 5173);
const serverPort = Number(process.env.PORT ?? 8787);
// The game server serves the API endpoints, the imported pack at /assets and the relay on WebSocket /ws.
const proxy = {
  '/api': `http://localhost:${serverPort}`,
  '/assets': `http://localhost:${serverPort}`,
  '/ws': { target: `ws://localhost:${serverPort}`, ws: true },
};

export default defineConfig(({ command, mode, isPreview }) => {
  const isVitest = mode === 'test' || Boolean(process.env.VITEST);
  const distDir = resolve(CLIENT_ROOT, 'dist');
  const assetsDir = process.env.ASSETS_DIR?.trim()
    ? resolve(process.env.ASSETS_DIR.trim())
    : resolve(CLIENT_ROOT, '../../assets-local/pack');

  const define: Record<string, string> = {};
  if (!isVitest) {
    if (!process.env.VITE_ASSETS_VERSION) {
      const assetsId = computeAssetsPackId(assetsDir);
      if (assetsId) define['import.meta.env.VITE_ASSETS_VERSION'] = JSON.stringify(assetsId);
    }
    if (command === 'serve' && !isPreview && !process.env.VITE_BUILD_VERSION) {
      const distBuildId = computeDistBuildId(distDir);
      if (distBuildId) define['import.meta.env.VITE_BUILD_VERSION'] = JSON.stringify(distBuildId);
    }
  }

  return {
    plugins: isVitest ? [gtm()] : [gtm(), buildVersionStamp(distDir)],
    ...(Object.keys(define).length > 0 ? { define } : {}),
    // Not the default `assets`: that path belongs to the game server's pack (proxied above), also under `vite preview`.
    build: { assetsDir: 'bundle' },
    server: { port, strictPort: true, proxy },
    preview: { port, strictPort: true, proxy },
  };
});
