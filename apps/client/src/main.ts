import './style.css';
import { Application } from 'pixi.js';
import { createAssetProvider } from './assets';
import { renderAssetsDebug, type DebugViewReport } from './assets/debug-view';
import { copyInviteUrl, inviteUrl, isLocalhostOrigin, parseInviteRoom } from './lobby/invite-link';
import { exposeMapDebug, MapView } from './map';
import { startMultiplayer } from './multiplayer';
import { getClientVersions } from './net/version-gate';
import { startSkirmish } from './skirmish';
import { createTestMap } from '@aoe/sim';
import { GAME_TITLE } from './title';

declare global {
  interface Window {
    __assetsDebug?: DebugViewReport;
  }
}

export function readStartupInviteCode(href: string): string | undefined {
  return parseInviteRoom(href) ?? undefined;
}

export function buildClientInviteHooks(origin: string): {
  buildInviteUrl: (code: string) => string | null;
  copyInvite: (url: string) => Promise<{ copied: boolean; method: string } | boolean>;
  isLocalOrigin: (candidateOrigin: string) => boolean;
} {
  return {
    buildInviteUrl: (code: string) => {
      try {
        return inviteUrl(origin, code);
      } catch {
        return null;
      }
    },
    copyInvite: (url: string) => copyInviteUrl(url),
    isLocalOrigin: (candidateOrigin: string) => isLocalhostOrigin(candidateOrigin),
  };
}

export async function main(): Promise<void> {
  const host = document.getElementById('game');
  if (!host) throw new Error('missing #game element');

  const app = new Application();
  // Black outside the map, as in the original; the canvas follows the window size.
  await app.init({ resizeTo: window, background: '#000000' });
  app.canvas.dataset.testid = 'game-canvas';
  host.append(app.canvas);
  document.title = GAME_TITLE;

  const params = new URLSearchParams(location.search);
  // The canvas stays hidden behind the lobby until a game starts; the debug views have no lobby.
  const setGameVisible = (visible: boolean) => (host.hidden = !visible);
  setGameVisible(['assets', 'map', 'combat'].includes(params.get('debug') ?? ''));
  if (params.get('debug') === 'assets') {
    // Unit 83 is the villager in the shipped dat; terrain 0 is Grass.
    const view = await renderAssetsDebug(app, await createAssetProvider(), {
      terrainId: Number(params.get('terrain') ?? 0),
      unitId: Number(params.get('unit') ?? 83),
      owner: Number(params.get('owner') ?? 1),
    });
    window.__assetsDebug = view;
    app.canvas.dataset.assetsSource = view.source;
    return;
  }

  if (params.get('debug') === 'map') {
    // The fixed test map without a lobby; `col` and `row` pick the tile in the middle of the view.
    const view = await MapView.create(app, createTestMap(), await createAssetProvider());
    const debug = exposeMapDebug(view);
    if (params.has('col') && params.has('row')) debug.centerOnTile(Number(params.get('col')), Number(params.get('row')));
    app.canvas.dataset.assetsSource = view.source;
    return;
  }

  if (params.get('debug') === 'combat') {
    // A local fight without a lobby (Bowmen, Clubmen, Villagers); `speed` multiplies the pace.
    window.__skirmish = await startSkirmish(app, Number(params.get('speed') ?? 1) || 1);
    return;
  }

  const lobbyHost = document.getElementById('multiplayer');
  if (!lobbyHost) throw new Error('missing #multiplayer element');
  const resources = params.has('resources') ? Number(params.get('resources')) : undefined;
  const bowmen = Number(params.get('bowmen') ?? 0);
  const houses = Number(params.get('houses') ?? 0);
  const relics = Number(params.get('relics') ?? 0);
  const ruins = Number(params.get('ruins') ?? 0);
  /** A comma-separated list of master ids (`&buildings=`, `&units=`); undefined when absent or not all integers. */
  const ids = (name: string): number[] | undefined => {
    const list = (params.get(name) ?? '').split(',').filter((s) => s !== '').map(Number);
    return list.length > 0 && list.every((n) => Number.isInteger(n) && n >= 0) ? list : undefined;
  };
  const inviteHooks = buildClientInviteHooks(window.location.origin);
  await startMultiplayer(lobbyHost, app, {
    debug: params.get('debug') === 'net',
    speed: Number(params.get('speed') ?? 1) || 1,
    resources: resources !== undefined && Number.isFinite(resources) ? resources : undefined,
    bowmen: Number.isInteger(bowmen) && bowmen > 0 ? bowmen : undefined,
    market: params.get('market') === '1',
    houses: Number.isInteger(houses) && houses > 0 ? houses : undefined,
    relics: Number.isInteger(relics) && relics > 0 ? relics : undefined,
    ruins: Number.isInteger(ruins) && ruins > 0 ? ruins : undefined,
    wonder: params.get('wonder') === '1',
    buildings: ids('buildings'),
    units: ids('units'),
    naval: params.get('naval') === '1',
    testMap: params.get('map') === 'test',
    seed: params.has('seed') && Number.isInteger(Number(params.get('seed'))) ? Number(params.get('seed')) : undefined,
    perturb: params.has('perturb') && Number.isInteger(Number(params.get('perturb'))) ? Number(params.get('perturb')) : undefined,
    initialRoomCode: readStartupInviteCode(window.location.href),
    ...inviteHooks,
    clientVersions: getClientVersions(),
    setGameVisible,
  });
}

if (typeof document !== 'undefined') void main();
