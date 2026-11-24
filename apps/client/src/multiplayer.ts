import type { Application } from 'pixi.js';
import type { CompatibilityVersions, MatchManifest, PlayerInfo, RoomMode, RoomSeat, Slot } from '@aoe/protocol';
import { ATTR_FOOD, ATTR_GOLD, ATTR_HEADROOM, ATTR_POPULATION, ATTR_POPULATION_LIMIT, ATTR_STONE, ATTR_WOOD, CIV_EGYPTIAN, HOUSE, MARKET, TECH_DONE, TOWN_CENTER, WONDER, type Command, type GameResult, type Score, type World } from '@aoe/sim';
import { createAssetProvider } from './assets';
import { GameSounds, type SoundTrigger } from './audio/game-sounds';
import { MusicPlayer } from './audio/music-player';
import { SoundPlayer } from './audio/sound-player';
import { Lockstep, SYNC_INTERVAL_TURNS, showEndDialog, type LockstepStart } from './lockstep';
import { FrameClock } from './lockstep/frame-clock';
import { LobbyView, Session, type LobbyState, type StartMessage } from './lobby';
import { copyInviteUrl, inviteUrl, isLocalhostOrigin, parseInviteRoom } from './lobby/invite-link';
import { exposeMapDebug, MapView } from './map';
import { constructionProgress, researchStatus, trainingStatus } from './hud/commands';
import { GameHud } from './hud/game-hud';
import { resourcesOf, type Resources } from './hud/resource-bar';
import { connect, type Link } from './net/link';
import { getClientVersions, verifyVersionGate, type VersionGateResult } from './net/version-gate';
import { isBuildingObject, isUnit, UnitLayer, type Ghost } from './units/unit-layer';
import { placeNavalStart } from './naval-start';

/** What `?debug=net` exposes as `window.__game`, for tests and manual poking. */
export interface NetDebug {
  /** Queue a `test` command from this client. */
  issueTest(x: number, y: number): void;
  /** Next turn to execute (== turns executed so far). */
  turn(): number;
  /** The checksum of the last sync-check turn (every 4th, `SYNC_INTERVAL_TURNS`) at or before `turn`; undefined before it ran. */
  hash(turn: number): number | undefined;
  /** Commands applied so far, from each slot. */
  applied(): { type: string }[][];
  /** Entities made by `test` commands (no sprite), by owner. */
  entityOwners(): number[];
  /** Sim player number of this client. */
  player(): number;
  /**
   * Each player's civ (Gaia first), the victory type and the time limit's clock, and per player its object types, done
   * techs and explored tile count: what the lobby started.
   */
  gameSetup(): { civs: number[]; victory: { type: number; countdown: number }; objects: number[][]; techsDone: number[][]; explored: number[] };
  /** Units in the sim, in id order; `col`/`row` is the tile under the unit. */
  units(): DebugUnit[];
  /** Queue a move order for `units` to tile coordinates (x, y), as a right click would. */
  issueMove(units: number[], x: number, y: number): void;
  /** Ids the selection holds; null before the map is drawn. */
  selection(): number[] | null;
  /** `selected_obj`, the object the panel shows; null for none. */
  primary(): number | null;
  /** The group numbers drawn over selected own objects now (frame 1-9 of groupnum.shp). */
  groupNumbers(): { id: number; group: number }[];
  /** Canvas pixel where unit `id` stands, as drawn now; null before the map is drawn. */
  unitScreenPos(id: number): { x: number; y: number } | null;
  /** Objects drawn with pack sprites (not debug shapes). */
  packSprites(): number;
  /** Objects near the view the player's fog lets it see; every one shows pack art once `packSprites()` equals it. */
  shownObjects(): number;
  /** Stockpile of `player` (default: this client's), whole numbers as the resource bar shows them. */
  resources(player?: number): Resources;
  /** Every sim object with a sprite (units, buildings, trees, mines, animals, carcasses), in id order. */
  objects(): DebugObject[];
  /** Stockpile of `player` right after turn `turn` ran, as logged by this client; undefined before that. */
  resourcesAt(turn: number, player: number): Resources | undefined;
  /** Queue a work order for `units` on object `target`, clicked at tile coordinates (x, y). */
  issueWork(units: number[], target: number, x: number, y: number): void;
  /** Canvas pixel at the middle of object `id`'s drawn sprite; null when it is not drawn. */
  objectScreenPos(id: number): { x: number; y: number } | null;
  /** Population of `player` (default: this client's): units (attribute 11), the room houses give (4) and the limit (32). */
  population(player?: number): DebugPopulation;
  /** Every building and foundation, in id order, with its construction progress and production queue. */
  buildings(): DebugBuilding[];
  /** Production queue of building `id`; null when there is no such building. */
  queue(id: number): DebugQueue | null;
  /** The building being placed and where its ghost stands; null when not placing. */
  ghost(): Ghost | null;
  /** Step size and buffer frames the sim runs at now, this client's mean frame time and the server's round trips. */
  net(): DebugNet;
  /** Hold every pong this long, faking a slow link to the server. */
  delayPongs(ms: number): void;
  /** Report this mean frame time instead of the measured one (0: measure again), faking a slow machine. */
  forceFrameMs(ms: number): void;
  /** Current age of `player` (default: this client's): 1 Stone .. 4 Iron (attribute 6). */
  age(player?: number): number;
  /** State of tech `tech` for `player` (default: this client's): -1 disabled, 0 locked, 1 available, 2 researching, 3 done. */
  techState(tech: number, player?: number): number;
  /** The name the object panel shows for object `id` (an upgrade's for an upgraded master); null without one or a HUD. */
  objectName(id: number): string | null;
  /** The order mode waiting for its click on the map (move, repair, attack-ground, heal, convert), or null. */
  commandMode(): string | null;
  /** The red X markers an order on open ground left, in canvas pixels, with the frame of moveto.shp each shows (units/move-marker.ts). */
  markers(): { x: number; y: number; frame: number; shown: boolean }[];
  /** The player whose colour object `id` is drawn in now; null when it is not drawn. */
  drawnOwner(id: number): number | null;
  /** The damage sprites (fire) drawn over object `id` now, by graphic, with pack art (docs/spec/sprites.md §6). */
  drawnOverlays(id: number): number[];
  /** The game canvas's CSS cursor now (a `url(...)` of the original's art, or a browser cursor). */
  cursor(): string;
  /** What `player` (default: this client's) knows of tile (col, row): 0x0F visible, 0x80 fogged, 0 unexplored. */
  tileVisibility(col: number, row: number, player?: number): number;
  /** The state tile (col, row) is drawn in: the fog under REVEAL MAP and NO FOG (0x0F, 0x80, 0); null before the HUD is up. */
  drawnTile(col: number, row: number): number | null;
  /** `player`'s stance towards `other` (0 ally, 1 neutral, 3 enemy; docs/spec/diplomacy.md §1) and its allied victory flag. */
  relation(player: number, other: number): number;
  alliedVictory(player: number): boolean;
  /** Pixel of the minimap canvas where tile (col, row)'s objects are drawn, or null before the HUD is up. */
  minimapPoint(col: number, row: number): { x: number; y: number } | null;
  /** The minimap's view frame: the tile it is centred on (the view's centre point's) and its rectangle on the canvas; null before the HUD is up. */
  minimapFrame(): { col: number; row: number; left: number; top: number; right: number; bottom: number } | null;
  /** Every sound triggered so far, oldest first (whether or not audio has started); empty before the HUD is up. */
  sounds(): SoundTrigger[];
  /**
   * The audio heard: is the context running, and the peak level (0-1) the sounds and the music put out since the last
   * call, measured on their outputs (docs/spec/sounds.md §8).
   */
  audioLevels(): { running: boolean; sound: number; music: number };
  /** The music file playing (null when none), whether the music is on, its volume slider position and track count. */
  music(): DebugMusic;
  /** How the game ended and who won (`World.gameResult`); null while it goes on. */
  /** `World.log.history[p]`: the population entries and the ages reached (the achievements timeline). */
  history(player?: number): { population: number[]; events: { time: number; event: number }[] };
  gameResult(): GameResult | null;
  /** Victory points of `player` (default: this client's) by achievements group (`World.score`). */
  score(player?: number): Score;
  /** Break the socket as a network fault would (close code 4000) and stay away `holdMs` before rejoining. */
  dropLink(holdMs: number): void;
  /** Queue any command from this client, as the soak test's bot does. */
  issue(command: Command): void;
  /** Sim clock, ms of game time (`World.worldTime`). */
  gameTime(): number;
  /** Ms of base time the turn loop has run (`Lockstep.baseTime`): game time advances it times the game speed. */
  baseTime(): number;
  /** The relay's report that the two games' hashes differ at `turn`; null while they agree. `hashes` is by slot. */
  desync(): { turn: number; hashes: number[] } | null;
  /** Authoritative match manifest frozen at game start (no tokens), or null on legacy starts. */
  manifest(): MatchManifest | null;
  /** Player names indexed 1..capacity (`names[0] === ''`), never compacted on drop/resign. */
  names(): string[];
  /** Sorted sim player IDs (1..capacity) currently marked dropped. */
  droppedPlayers(): number[];
  /** Authoritative protocol slot of this client. */
  slot(): number;
  /** Authoritative room mode (`'multiplayer'` | `'single-player'`). */
  mode(): RoomMode;
}

/** What `?debug=net` exposes as `window.__lobby`, without leaking `token` or `botToken`. */
export interface LobbyDebug {
  phase(): LobbyState['phase'];
  code(): string;
  you(): number;
  capacity(): number;
  hostSlot(): number;
  mode(): RoomMode;
  players(): PlayerInfo[];
  seats(): RoomSeat[];
  versions(): CompatibilityVersions | null;
  error(): { code: string; message: string } | null;
}

export interface DebugMusic {
  playing: string | null;
  on: boolean;
  volume: number;
  tracks: number;
}

/** What the debug hook reads of the audio. */
interface AudioDebug {
  levels(): { running: boolean; sound: number; music: number };
  music(): DebugMusic;
}

export interface DebugNet {
  granularity: number;
  frames: number;
  frameMs: number;
  /** Round trip from the server to each slot, ms. */
  rtt: number[];
  /** Each slot's mean frame time as the server last reported it, ms. */
  frameTimes: number[];
}

export interface DebugPopulation {
  count: number;
  headroom: number;
  limit: number;
}

export interface DebugQueue {
  /** Records in training order: unit type and how many are paid for. */
  records: { unit: number; count: number }[];
  /** The unit in training and its whole percent (0 before it starts); null with an empty queue. */
  training: { unit: number; progress: number } | null;
}

export interface DebugBuilding {
  id: number;
  owner: number;
  type: number;
  x: number;
  y: number;
  /** `object_state`: 0 foundation, 2 active. */
  state: number;
  hp: number;
  /** Whole percent built. */
  progress: number;
  /** Dat graphic of the sprite shown (the construction sprite while unbuilt) and the building's facet. */
  graphic: number;
  facet: number;
  queue: DebugQueue;
  /** The research under way and its whole percent; null when none. */
  research: { tech: number; progress: number } | null;
}

export interface DebugObject {
  id: number;
  owner: number;
  type: number;
  x: number;
  y: number;
  /** `object_state`. */
  state: number;
  /** Resource held (`attribute_type_held`, -1 none) and its amount. */
  heldType: number;
  heldAmount: number;
  hp: number;
  /** Dat graphic of the active sprite and its frame in the sim. */
  graphic: number;
  frame: number;
  /** The transport the object is aboard (`inside_obj`), or null; a transport's passengers, the last to board first. */
  inside: number | null;
  cargo: number[];
  /** Action type of the object's work action (gather, build, enter 3, trade 111, ...), or -1 without one. */
  work: number;
  /** The damage sprites in its sprite list (`Entity.overlays`), by graphic. */
  overlays: number[];
}

export interface DebugUnit {
  id: number;
  owner: number;
  type: number;
  x: number;
  y: number;
  col: number;
  row: number;
  facet: number;
  moving: boolean;
}

declare global {
  interface Window {
    __game?: NetDebug;
    __lobby?: LobbyDebug;
  }
}

export interface MultiplayerOptions {
  /** Expose debug hooks and the debug panel. */
  debug: boolean;
  /** Lockstep pace multiplier; 1 is the original's speed. */
  speed: number;
  /**
   * Debug only (`?debug=net&resources=N`): every player starts with N food, wood, gold and stone. Both clients must ask
   * for the same N, or their games differ from the first turn.
   */
  resources?: number;
  /**
   * Debug only (`?debug=net&bowmen=N`): every player starts with N Bowmen in a row above its Villagers, for a ranged
   * attack (and its flare) without building an Archery Range first. Both clients must ask for the same N.
   */
  bowmen?: number;
  /**
   * Debug only (`?debug=net&market=1`): every player starts with a built Market left of its Town Center, so its Farm is
   * enabled (tech 26) without the Tool Age first. Placed without a placement check: for the test map. Both clients must
   * ask for it.
   */
  market?: boolean;
  /**
   * Debug only (`?debug=net&houses=N`): every player starts with N built Houses in a column left of its Town Center,
   * for population room without building them. Placed without a placement check: for the test map. Both clients must
   * ask for the same N.
   */
  houses?: number;
  /**
   * Debug only (`?debug=net&relics=N`, `&ruins=N`): N Gaia relics in a row 2 tiles above player 1's first Villager, N
   * ruins in a column 3 tiles left of it, counted in the game's relics and ruins, so player 1 takes them and, holding
   * all, starts the countdown. Placed without a placement check: for the test map. Both clients must ask for the same N.
   */
  relics?: number;
  ruins?: number;
  /**
   * Debug only (`?debug=net&wonder=1`): player 1 starts with a built Wonder left of its Town Center, so its countdown
   * runs from the first steps (victory.md §8). Placed without a placement check: for the test map. Both clients must
   * ask for it.
   */
  wonder?: boolean;
  /**
   * Debug only (`?debug=net&buildings=12,87,101,0`): every player starts with one built building of each listed id, in
   * two columns of four, 10 and 14 tiles right of its Town Center, every 4 tiles from 11 tiles above it (on the test map
   * out of the sight of the other player's `&units=`), so their units and techs need no Villager to build them first.
   * Placed without a placement check: for the test map. Both clients must ask for the same list.
   */
  buildings?: number[];
  /**
   * Debug only (`?debug=net&units=75,76,77`): every player starts with one unit of each listed id, in rows of seven 2
   * tiles apart from 2 tiles above and 4 left of its first Villager, so each master can be seen (and clicked) without
   * its building or techs. Placed without a placement check: for the test map. Both clients must ask for the same list.
   */
  units?: number[];
  /**
   * Debug only (`?debug=net&naval=1`): every player starts with a built Dock on the shore nearest its Town Center and a
   * Transport Boat and a Trade Boat on the water near it (`placeNavalStart`), for a water map. Both clients must ask for it.
   */
  naval?: boolean;
  /** Debug only (`?debug=net&map=test`): play on the fixed test map (`createTestMap`, `startingObjects`). */
  testMap?: boolean;
  /** Debug only (`?debug=net&seed=N`): play the random map seed N instead of the server's. Both clients must pass the same N. */
  seed?: number;
  /**
   * Debug only (`?debug=net&perturb=N`): after turn N this client changes its own food by one, so the two games
   * disagree from turn N + 1: the soak test's check that a desync is caught. Only one client passes it.
   */
  perturb?: number;
  /** Optional room code parsed from the invite URL (`?room=CODE`). */
  initialRoomCode?: string;
  /** Builds a shareable invite URL for `code`, or null when invalid. */
  buildInviteUrl?: (code: string) => string | null;
  /** Copies an invite URL using clipboard API or manual selection fallback. */
  copyInvite?: (url: string) => Promise<{ copied: boolean; method: string } | boolean>;
  /** Checks whether `origin` is a localhost/loopback origin not shareable across devices. */
  isLocalOrigin?: (origin: string) => boolean;
  /** Client compatibility versions compared against `/api/versions`. */
  clientVersions?: CompatibilityVersions;
  /** Base URL for `/api/versions` (defaults to same-origin). */
  versionBaseUrl?: string;
  /** Allows legacy/offline test harnesses without `/api/versions` to fall back to `DEFAULT_COMPATIBILITY_VERSIONS`. */
  allowVersionFallback?: boolean;
  /** Optional dependency override for tests. */
  connectLink?: () => Promise<Link>;
  /** Optional fetch implementation override for tests. */
  fetchImpl?: typeof fetch;
  /** Show or hide the game canvas: hidden in the lobby, shown while a game runs. */
  setGameVisible(visible: boolean): void;
}

export interface ResolvedMatchStart {
  lockstepStart: LockstepStart;
  /** Player names indexed `1..capacity` (`names[0] === ''`), never compacted on drop/resign. */
  names: string[];
  /** Safe cloned manifest without tokens, or null for legacy capacity-2 starts without a manifest. */
  manifest: MatchManifest | null;
}

/**
 * Resolves `LockstepStart` and `GameHud` names from a server `start` message.
 * Consumes `start.manifest` when present (preserving slot ordering and fixed 1..capacity arrays),
 * falling back cleanly to legacy `start.players` / `start.settings` / `start.seed` for capacity-2 fixtures.
 */
export function resolveMatchStart(
  start: StartMessage,
  you: Slot,
  roomCode: string,
  overrides?: { debug?: boolean; seed?: number; testMap?: boolean },
): ResolvedMatchStart {
  const seed = overrides?.debug && overrides.seed !== undefined
    ? overrides.seed
    : (start.manifest ? start.manifest.seed : start.seed);
  const testMap = Boolean(overrides?.debug && overrides.testMap);

  if (start.manifest) {
    const manifest = start.manifest;
    const sortedPlayers = [...manifest.players].sort((a, b) => a.slot - b.slot);
    const capacity = manifest.capacity;
    const civs = Array.from({ length: capacity }, (_, slot) => {
      const entry = sortedPlayers.find((p) => p.slot === slot);
      return entry ? entry.civ : CIV_EGYPTIAN;
    });
    const names = Array.from({ length: capacity + 1 }, () => '');
    for (const p of sortedPlayers) {
      if (p.playerId >= 1 && p.playerId <= capacity) {
        names[p.playerId] = p.name;
      }
    }
    const manifestCopy: MatchManifest = {
      code: manifest.code,
      capacity: manifest.capacity,
      mode: manifest.mode,
      hostSlot: manifest.hostSlot,
      players: sortedPlayers.map((p) => ({ slot: p.slot, playerId: p.playerId, name: p.name, civ: p.civ })),
      seed: manifest.seed,
      settings: structuredClone(manifest.settings),
      versions: { ...manifest.versions },
    };
    return {
      lockstepStart: {
        seed,
        commandDelay: start.commandDelay,
        playerCount: capacity,
        mode: manifest.mode,
        slot: you,
        settings: manifest.settings,
        civs,
        rejoin: { code: manifest.code || roomCode, slot: you, token: start.token },
        testMap,
      },
      names,
      manifest: manifestCopy,
    };
  }

  const sortedLegacy = [...start.players].sort((a, b) => a.slot - b.slot);
  const capacity = start.capacity ?? sortedLegacy.length;
  const civs = sortedLegacy.map((p) => p.civ);
  const names = Array.from({ length: Math.max(capacity, sortedLegacy.length) + 1 }, () => '');
  for (const p of sortedLegacy) {
    names[p.slot + 1] = p.name;
  }
  return {
    lockstepStart: {
      seed,
      commandDelay: start.commandDelay,
      playerCount: capacity,
      mode: start.mode,
      slot: you,
      settings: start.settings,
      civs,
      rejoin: { code: roomCode, slot: you, token: start.token },
      testMap,
    },
    names,
    manifest: null,
  };
}

/** Exposes non-secret lobby state for `?debug=net` tests without exposing `token` or `botToken`. */
export function createLobbyDebug(session: Session): LobbyDebug {
  return {
    phase: () => session.state.phase,
    code: () => session.state.code,
    you: () => session.state.you,
    capacity: () => session.state.capacity ?? Math.max(2, session.state.players.length),
    hostSlot: () => session.state.hostSlot ?? 0,
    mode: () => session.state.mode ?? 'multiplayer',
    players: () => session.state.players.map((p) => ({ slot: p.slot, name: p.name, ready: p.ready, civ: p.civ })),
    seats: () => (session.state.seats ?? []).map((s) => ({ slot: s.slot, status: s.status, name: s.name, civ: s.civ, ready: s.ready })),
    versions: () => (session.state.versions ? { ...session.state.versions } : null),
    error: () => (session.state.error ? { code: session.state.error.code, message: session.state.error.message } : null),
  };
}

export function renderVersionGateError(
  host: HTMLElement,
  failure: Exclude<VersionGateResult, { ok: true }> | { ok: false; kind: 'connection'; message: string },
  onRetry: () => void,
): HTMLElement {
  const section = document.createElement('section');
  section.id = 'lobby';
  section.dataset.testid = 'version-gate';

  const panel = document.createElement('div');
  panel.className = 'panel';

  const heading = document.createElement('h2');
  heading.textContent = failure.kind === 'mismatch' ? 'Game Version Mismatch' : 'Server Connection Error';

  const alert = document.createElement('p');
  alert.className = 'error';
  alert.setAttribute('role', 'alert');
  alert.dataset.testid = 'version-gate-error';
  alert.textContent = failure.message;

  panel.append(heading, alert);

  if (failure.kind === 'mismatch' && failure.diagnostics.mismatches.length > 0) {
    const details = document.createElement('ul');
    details.className = 'players';
    details.dataset.testid = 'version-gate-details';
    for (const m of failure.diagnostics.mismatches) {
      const item = document.createElement('li');
      item.textContent = `${m.field}: client "${m.client}" vs server "${m.server}"`;
      details.append(item);
    }
    panel.append(details);
  }

  const row = document.createElement('div');
  row.className = 'row';
  const retry = document.createElement('button');
  retry.className = 'primary';
  retry.dataset.testid = 'version-gate-retry';
  retry.textContent = 'Retry';
  retry.addEventListener('click', () => {
    retry.disabled = true;
    onRetry();
  });
  row.append(retry);
  panel.append(row);

  section.append(panel);
  host.replaceChildren(section);
  return section;
}

// Master ids (empires.dat): Villager, Bowman.
const VILLAGER = 83;
const BOWMAN = 4;
/** The relic and the ruin (`Artifact1`, `Artifact_Ruins1`). */
const RELIC = 159;
const RUIN = 158;

/** `PLAYER_ATTRIBUTE_CURRENT_AGE`. */
const ATTR_CURRENT_AGE = 6;

/** Connects to the relay, verifies compatibility versions, shows the lobby in `host`, and runs lockstep once the game starts, drawing the map in `app`. */
export async function startMultiplayer(
  host: HTMLElement,
  app: Application,
  {
    debug,
    speed,
    resources,
    bowmen,
    market,
    houses,
    relics,
    ruins,
    wonder,
    buildings,
    units: startUnits,
    naval,
    testMap,
    seed,
    perturb,
    initialRoomCode,
    buildInviteUrl,
    copyInvite,
    isLocalOrigin,
    clientVersions,
    versionBaseUrl,
    allowVersionFallback,
    connectLink,
    fetchImpl,
    setGameVisible,
  }: MultiplayerOptions,
): Promise<void> {
  const defaultOrigin = typeof window !== 'undefined' ? window.location.origin : '';
  const resolvedInitialRoomCode =
    initialRoomCode ?? (typeof window !== 'undefined' ? parseInviteRoom(window.location.href) ?? undefined : undefined);
  const resolvedBuildInviteUrl =
    buildInviteUrl ??
    (defaultOrigin
      ? (code: string) => {
          try {
            return inviteUrl(defaultOrigin, code);
          } catch {
            return null;
          }
        }
      : undefined);
  const resolvedCopyInvite = copyInvite ?? ((url: string) => copyInviteUrl(url));
  const resolvedIsLocalOrigin = isLocalOrigin ?? ((origin: string) => isLocalhostOrigin(origin));

  const boot = async (): Promise<void> => {
    const gate = await verifyVersionGate({
      baseUrl: versionBaseUrl,
      clientVersions: clientVersions ?? getClientVersions(),
      fallbackToDefault: allowVersionFallback,
      fetchImpl,
    });
    if (!gate.ok) {
      renderVersionGateError(host, gate, () => {
        void boot();
      });
      return;
    }

    let link: Link;
    try {
      link = await (connectLink ? connectLink() : connect());
    } catch (err) {
      renderVersionGateError(
        host,
        {
          ok: false,
          kind: 'connection',
          message: err instanceof Error ? err.message : 'Cannot reach the game server.',
        },
        () => {
          void boot();
        },
      );
      return;
    }

    const session = new Session(link);
    session.setVersions(gate.clientVersions);
    if (debug) window.__lobby = createLobbyDebug(session);

    const view = new LobbyView(session, {
      testMap: debug && testMap,
      speed,
      initialRoomCode: resolvedInitialRoomCode,
      buildInviteUrl: resolvedBuildInviteUrl,
      copyInvite: resolvedCopyInvite,
      isLocalOrigin: resolvedIsLocalOrigin,
      versions: gate.clientVersions,
    });
    host.replaceChildren(view.root);
    // The setup screen's names (civs, maps, victory) from the pack's language strings once it loads.
    // Made before the lobby so its clicks start the audio (browsers allow it only after a gesture).
    const audio = new SoundPlayer();
    const music = new MusicPlayer(audio);
    void createAssetProvider().then((provider) => {
      view.setText((id, fallback) => provider.string(id) ?? fallback);
      // `start_menu`: open.mid once as the menu opens (src/tribegam.cpp:1360-1368).
      music.setTable(provider.soundTable()?.music ?? null);
      music.playFile('open.mid', false);
    });

    let lockstep: Lockstep | undefined;
    let panel: HTMLElement | undefined;
    let mapView: MapView | undefined;
    let units: UnitLayer | undefined;
    let hud: GameHud | undefined;
    let sounds: GameSounds | undefined;
    const soundTick = () => {
      sounds?.update();
      // `handle_terrain_sound` runs in the game, not in its game over mode.
      if (sounds && mapView && !hud?.gameOver.over) sounds.terrain(performance.now(), () => mapView!.drawnTerrains());
      audio.sample();
      music.sample();
    };
    app.ticker.add(soundTick);
    // The game screen's chat: a message from another player, outside the turns (docs/spec/chat.md §3). The lobby's
    // goes to the session.
    link.onMessage((m) => {
      if (m.t === 'chat' && session.state.phase === 'playing') hud?.receiveChat(m.from + 1, m.text);
    });

    // Back to the lobby: the game screen goes, the session leaves its room.
    const teardown = () => {
      lockstep?.stop();
      lockstep = undefined;
      panel?.remove();
      units?.destroy();
      units = undefined;
      hud?.destroy();
      hud = undefined;
      sounds = undefined;
      audio.stopStream();
      // Back at the menu, which plays open.mid again (`started_menu_music` was reset as the game started).
      music.playFile('open.mid', false);
      mapView?.destroy();
      mapView = undefined;
      window.__game = undefined;
      window.__map = undefined;
      setGameVisible(false);
      session.finish();
    };
    const end = (kind: 'desync' | 'peer-left', detail: string) => {
      teardown();
      showEndDialog(kind, detail, () => undefined);
    };

    // Mean frame time the server tunes the step size to (docs/spec/turn-timing.md §3.2).
    const frames = new FrameClock();
    app.ticker.add((ticker) => frames.sample(ticker.elapsedMS));

    session.onStart = (start, you) => {
      const player = you + 1;
      const resolved = resolveMatchStart(start, you, session.state.code, { debug, seed, testMap });
      const game = new Lockstep({
        link,
        speed,
        // A broken socket comes back to the same room and slot (docs/spec/turn-timing.md §9).
        start: resolved.lockstepStart,
        frameMs: () => frames.average(),
      });
      // Player names indexed 1..capacity (Gaia at 0), never compacted when a player drops or resigns.
      const names = resolved.names;
      const dropped = new Set<number>();
      game.onDropped = (slot) => dropped.add(slot + 1);
      game.onNotResponding = () => hud?.notResponding();
      lockstep = game;
    // Before the first turn runs: the relay releases turns asynchronously.
    if (debug && resources !== undefined) {
      for (const a of game.world.attributes.slice(1)) for (const r of [ATTR_FOOD, ATTR_WOOD, ATTR_GOLD, ATTR_STONE]) a[r] = resources;
    }
    if (debug && bowmen) {
      for (let p = 1; p < game.world.players; p++) {
        const villager = [...game.world.entities.ofPlayer(p)].find((e) => e.type === VILLAGER)!;
        for (let i = 0; i < bowmen; i++) game.world.createUnit({ owner: p, type: BOWMAN, x: villager.x + i, y: villager.y - 1 });
      }
    }
    if (debug && market) {
      for (let p = 1; p < game.world.players; p++) {
        const tc = [...game.world.entities.ofPlayer(p)].find((e) => e.type === TOWN_CENTER);
        if (tc) game.world.createUnit({ owner: p, type: MARKET, x: tc.x - 4, y: tc.y });
      }
    }
    if (debug && houses) {
      for (let p = 1; p < game.world.players; p++) {
        const tc = [...game.world.entities.ofPlayer(p)].find((e) => e.type === TOWN_CENTER);
        for (let i = 0; tc && i < houses; i++) game.world.createUnit({ owner: p, type: HOUSE, x: Math.floor(tc.x) - 8, y: Math.floor(tc.y) - 6 + 2 * i });
      }
    }
    if (debug && (relics || ruins)) {
      const villager = [...game.world.entities.ofPlayer(1)].find((e) => e.type === VILLAGER)!;
      for (let i = 0; i < (relics ?? 0); i++) game.world.createUnit({ owner: 0, type: RELIC, x: villager.x + i, y: villager.y - 2 });
      for (let i = 0; i < (ruins ?? 0); i++) game.world.createUnit({ owner: 0, type: RUIN, x: villager.x - 3, y: villager.y - 1 - 3 * i });
      game.world.victory.artifactCount += relics ?? 0;
      game.world.victory.ruinCount += ruins ?? 0;
    }
    if (debug && buildings) {
      for (let p = 1; p < game.world.players; p++) {
        const tc = [...game.world.entities.ofPlayer(p)].find((e) => e.type === TOWN_CENTER);
        buildings.forEach((type, i) => tc && game.world.createUnit({ owner: p, type, x: Math.floor(tc.x) + 10.5 + 4 * (i >> 2), y: Math.floor(tc.y) - 10.5 + 4 * (i % 4) }));
      }
    }
    if (debug && startUnits) {
      for (let p = 1; p < game.world.players; p++) {
        const villager = [...game.world.entities.ofPlayer(p)].find((e) => e.type === VILLAGER)!;
        startUnits.forEach((type, i) => game.world.createUnit({ owner: p, type, x: villager.x - 4 + 2 * (i % 7), y: villager.y - 2 - 2 * Math.floor(i / 7) }));
      }
    }
    if (debug && naval) placeNavalStart(game.world);
    if (debug && wonder) {
      const tc = [...game.world.entities.ofPlayer(1)].find((e) => e.type === TOWN_CENTER);
      if (tc) game.world.createUnit({ owner: 1, type: WONDER, x: Math.floor(tc.x) - 4.5, y: tc.y });
    }
    setGameVisible(true);
    // The original keeps the game screen and says so there; the dialog is only for a game that has no screen yet.
    game.onDesync = (turn) => (hud ? hud.outOfSync() : end('desync', `The two games disagreed at turn ${turn}. The game cannot continue.`));
    game.onEnded = (reason) => {
      if (reason === 'lost') {
        // The server dropped this player (or the link never came back): the game is over for it.
        if (hud) hud.droppedSelf();
        else end('peer-left', 'You were dropped from the game.');
      } else if (!hud?.gameOver.over) {
        end('peer-left', 'Your opponent left the game.');
      }
      // After the end of the game the other player leaving changes nothing: this one stays until Menu/Quit Game.
    };
    const audioDebug: AudioDebug = {
      levels: () => ({ running: audio.running, sound: audio.level(), music: music.level() }),
      music: () => ({ playing: music.playing, on: music.on, volume: music.volume, tracks: music.tracks }),
    };
    if (debug) panel = debugPanel(host, game, link, player, () => units, () => hud, () => sounds, frames, audioDebug, resolved.manifest, names, dropped);
    if (debug && perturb !== undefined) {
      const shown = game.onTurn;
      game.onTurn = (turn, hash) => {
        shown(turn, hash);
        if (turn === perturb) game.world.attributes[player]![ATTR_FOOD]! += 1;
      };
    }
    void createAssetProvider().then(async (provider) => {
      const view = await MapView.create(app, game.world.map, provider);
      if (lockstep !== game) return view.destroy();
      mapView = view;
      // REVEAL MAP and NO FOG set the shared map's drawing flags (chat.md §7.2): every client draws them.
      view.setMapFlags(() => game.world.cheats);
      const gameSounds = new GameSounds({ world: game.world, player, table: provider.soundTable(), audio });
      sounds = gameSounds;
      // `start_game`: every track in order, looped (src/tribegam.cpp:3469-3478).
      music.playTracks(1, music.tracks, true);
      // An order acknowledges itself with the unit's sound as the player gives it (`command_make_*`); none in the game
      // over mode.
      const order = (c: Command) => {
        if (hud?.gameOver.over) return;
        gameSounds.command(c);
        game.issue(c);
      };
      const layer = new UnitLayer({
        app,
        view,
        world: game.world,
        provider,
        player,
        issue: order,
        stepMs: () => game.stepMs(),
        onPlacement: (unit) => hud?.commands.placementChanged(unit),
        onRollover: (text) => hud?.rollover(text),
        inBuildMenu: () => hud?.commands.gameMode === 'build-menu',
        onMessage: (id) => hud?.say(id),
        sounds: gameSounds,
      });
      units = layer;
      hud = new GameHud({
        parent: app.canvas.parentElement!,
        app,
        world: game.world,
        provider,
        player,
        selection: layer,
        issue: order,
        startPlacement: (unit) => layer.startPlacement(unit),
        cancelPlacement: () => layer.cancelPlacement(),
        map: { view, units: layer },
        sounds: gameSounds,
        music,
        game: {
          singlePlayerSpeed: game.mode === 'single-player' && you === 0,
          pause: {
            get allowed() { return game.canPause(); },
            get paused() { return game.isPaused(); },
            toggle: (paused) => paused === undefined ? game.togglePause() : game.requestPause(paused),
            onChange: (handler) => {
              const previous = game.onPauseChange;
              const listener: typeof previous = (paused, state) => { previous(paused, state); handler(paused); };
              game.onPauseChange = listener;
              return () => { if (game.onPauseChange === listener) game.onPauseChange = previous; };
            },
          },
          names,
          resign: () => game.issue({ type: 'resign' }),
          // The original resigns a player who quits a game still on (`SendIResignMsg`): the other one wins.
          disconnect: () => {
            game.quit(game.world.gameOver || game.world.playerStatus(player) !== 0 ? [] : [{ type: 'resign' }]);
            link.send({ t: 'leave' });
          },
          leave: teardown,
          dropped: (p) => dropped.has(p),
          onGameOver: () => layer.unselect(),
          reveal: () => layer.revealMap(),
          sendChat: (text, to) => link.send({ t: 'chat', text, to: to.map((p) => p - 1) }),
          net: () => ({ rtt: game.rtt, frameMs: game.frameTimes }),
        },
      });
      // Start looking at this player's Town Center, else its newest object (`TRIBE_Player::random_start`'s view).
      const own = [...game.world.entities.ofPlayer(player)];
      const start = own.find((e) => e.type === TOWN_CENTER) ?? own.at(-1);
      if (start) {
        view.lookAt(start.x, start.y);
      }
      if (debug) exposeMapDebug(view);
    });
    };
  };

  await boot();
}

function debugPanel(
  host: HTMLElement,
  game: Lockstep,
  link: Link,
  player: number,
  layer: () => UnitLayer | undefined,
  hud: () => GameHud | undefined,
  sounds: () => GameSounds | undefined,
  frames: FrameClock,
  audio: AudioDebug,
  manifest: MatchManifest | null,
  names: readonly string[],
  dropped: ReadonlySet<number>,
): HTMLElement {
  const panel = document.createElement('div');
  panel.dataset.testid = 'net-debug';
  const status = document.createElement('span');
  status.dataset.testid = 'net-status';
  const speed = document.createElement('span');
  speed.dataset.testid = 'net-speed';
  const net = (): DebugNet => ({ granularity: game.world.granularity, frames: game.world.frames, frameMs: frames.average(), rtt: game.rtt, frameTimes: game.frameTimes });
  const button = document.createElement('button');
  button.dataset.testid = 'send-test';
  button.textContent = 'Send test command';
  let n = 0;
  const issue = (x: number, y: number) => game.issue({ type: 'test', x, y });
  button.addEventListener('click', () => issue(10 + n++, 20));
  const stock = new Map<number, Resources[]>();
  let desync: { turn: number; hashes: number[] } | null = null;
  const shownDesync = game.onDesync;
  game.onDesync = (turn, hashes) => {
    desync = { turn, hashes };
    shownDesync(turn, hashes);
  };
  game.onTurn = (turn, hash) => {
    status.textContent = `turn ${turn} hash ${hash}`;
    const n = net();
    speed.textContent = `G ${n.granularity} ms F ${n.frames} frame ${n.frameMs} ms RTT ${n.rtt.length > 0 ? n.rtt.join(' + ') : '?'} ms`;
    stock.set(turn, Array.from({ length: game.world.players }, (_, p) => resourcesOf(game.world, p)));
  };
  panel.append(status, speed, button);
  host.append(panel);
  window.__game = {
    issueTest: issue,
    turn: () => game.turn,
    hash: (turn) => game.hashes.get(turn - (turn % SYNC_INTERVAL_TURNS)),
    applied: () => game.applied,
    entityOwners: () => [...game.world.entities.all()].filter((e) => !e.sprite).map((e) => e.owner),
    player: () => player,
    gameSetup: () => {
      const { world } = game;
      return {
        civs: [...world.civs],
        victory: { type: world.victory.type, countdown: world.victory.countdownClock },
        objects: world.civs.map((_, p) => [...world.entities.ofPlayer(p)].map((e) => e.type)),
        techsDone: world.techs.map((states) => states.flatMap((s, i) => (s === TECH_DONE ? [i] : []))),
        explored: [...world.visibility.explored],
      };
    },
    units: () =>
      [...game.world.entities.all()]
        .filter(isUnit)
        .map((e) => ({
          id: e.id,
          owner: e.owner,
          type: e.type,
          x: e.x,
          y: e.y,
          col: Math.floor(e.x),
          row: Math.floor(e.y),
          facet: e.mover!.facet,
          moving: e.mover!.action !== null,
        })),
    issueMove: (units, x, y) => game.issue({ type: 'move', units, x, y }),
    selection: () => {
      const l = layer();
      return l ? [...l.selected] : null;
    },
    primary: () => layer()?.primary ?? null,
    groupNumbers: () => layer()?.groupNumbers ?? [],
    unitScreenPos: (id) => layer()?.screenPos(id) ?? null,
    packSprites: () => layer()?.packSprites ?? 0,
    shownObjects: () => layer()?.shownObjects ?? 0,
    resources: (p = player) => resourcesOf(game.world, p),
    resourcesAt: (turn, p) => stock.get(turn)?.[p],
    objects: () =>
      [...game.world.entities.all()]
        .filter((e) => e.sprite)
        .map((e) => ({
          id: e.id,
          owner: e.owner,
          type: e.type,
          x: e.x,
          y: e.y,
          state: e.state,
          heldType: e.heldType,
          heldAmount: e.heldAmount,
          hp: e.hp,
          graphic: e.sprite!.graphic,
          frame: e.sprite!.frame,
          inside: e.inside ?? null,
          cargo: [...(e.cargo ?? [])],
          work: e.work?.type ?? -1,
          overlays: (e.overlays ?? []).map((o) => o.graphic),
        })),
    issueWork: (units, target, x, y) => game.issue({ type: 'work', units, target, x, y }),
    objectScreenPos: (id) => layer()?.objectCentre(id) ?? null,
    population: (p = player) => {
      const a = game.world.attributes[p]!;
      return { count: a[ATTR_POPULATION]!, headroom: a[ATTR_HEADROOM]!, limit: a[ATTR_POPULATION_LIMIT]! };
    },
    buildings: () =>
      [...game.world.entities.all()].filter(isBuildingObject).map((e) => ({
        id: e.id,
        owner: e.owner,
        type: e.type,
        x: e.x,
        y: e.y,
        state: e.state,
        hp: e.hp,
        progress: constructionProgress(game.world, e),
        graphic: e.sprite?.graphic ?? -1,
        facet: e.facet ?? 0,
        queue: queueOf(game.world, e.id)!,
        research: researchStatus(game.world, e),
      })),
    queue: (id) => queueOf(game.world, id),
    ghost: () => layer()?.ghost ?? null,
    net,
    delayPongs: (ms) => (game.pongDelayMs = ms),
    forceFrameMs: (ms) => (frames.forcedMs = ms),
    age: (p = player) => game.world.attributes[p]![ATTR_CURRENT_AGE]!,
    techState: (tech, p = player) => game.world.techs[p]![tech]!,
    objectName: (id) => hud()?.nameOf(id) ?? null,
    commandMode: () => layer()?.commandMode ?? null,
    markers: () => layer()?.markers ?? [],
    drawnOwner: (id) => layer()?.drawnOwner(id) ?? null,
    drawnOverlays: (id) => layer()?.drawnOverlays(id) ?? [],
    cursor: () => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=game-canvas]');
      return canvas ? getComputedStyle(canvas).cursor : '';
    },
    tileVisibility: (col, row, p = player) => game.world.tileVisibility(p, col, row),
    drawnTile: (col, row) => hud()?.drawnTile(col, row) ?? null,
    relation: (p, q) => game.world.relation(p, q),
    alliedVictory: (p) => game.world.diplomacy.alliedVictory[p] ?? false,
    minimapPoint: (col, row) => hud()?.minimapView?.tilePoint(col, row) ?? null,
    minimapFrame: () => hud()?.minimapView?.viewFrame() ?? null,
    sounds: () => [...(sounds()?.log ?? [])],
    audioLevels: () => audio.levels(),
    music: () => audio.music(),
    gameResult: () => game.world.gameResult(),
    history: (p = player) => {
      const h = game.world.log.history[p]!;
      return { population: [...h.population], events: h.events.map((e) => ({ time: e.time, event: e.event })) };
    },
    score: (p = player) => game.world.score(p),
    dropLink: (ms) => link.drop?.(ms),
    issue: (command) => game.issue(command),
    gameTime: () => game.world.worldTime,
    baseTime: () => game.baseTime,
    desync: () => desync,
    manifest: () => (manifest ? structuredClone(manifest) : null),
    names: () => [...names],
    droppedPlayers: () => [...dropped].sort((a, b) => a - b),
    slot: () => game.slot,
    mode: () => game.mode,
  };
  return panel;
}

function queueOf(world: World, id: number): DebugQueue | null {
  const e = world.entities.get(id);
  if (!e || !isBuildingObject(e)) return null;
  return { records: (e.queue ?? []).map((r) => ({ unit: r.unit, count: r.count })), training: trainingStatus(world, e) };
}
