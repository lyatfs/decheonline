// The slice of the client's `window.__assetsDebug` (apps/client/src/assets/debug-view.ts) that tests read.
interface Window {
  dataLayer?: Record<string, unknown>[];
  __assetsDebug?: {
    source: 'pack' | 'debug';
    terrainFrames: number;
    terrainRects: { x: number; y: number; width: number; height: number }[];
    unitRect: { x: number; y: number; width: number; height: number } | null;
    pixel(x: number, y: number): [number, number, number, number];
  };
}

// The slice of `window.__game` (apps/client/src/multiplayer.ts, `?debug=net`) that tests read.
interface Window {
  __game?: {
    issueTest(x: number, y: number): void;
    turn(): number;
    /** Checksum of the last sync-check turn (every 4th) at or before `turn`. */
    hash(turn: number): number | undefined;
    applied(): { type: string }[][];
    entityOwners(): number[];
    player(): number;
    /** Each player's civ (Gaia first), the victory type and the time limit's clock; per player its object types, done techs, explored tiles (docs/spec/lobby.md). */
    gameSetup(): { civs: number[]; victory: { type: number; countdown: number }; objects: number[][]; techsDone: number[][]; explored: number[] };
    units(): { id: number; owner: number; type: number; x: number; y: number; col: number; row: number; facet: number; moving: boolean }[];
    issueMove(units: number[], x: number, y: number): void;
    selection(): number[] | null;
    primary(): number | null;
    groupNumbers(): { id: number; group: number }[];
    unitScreenPos(id: number): { x: number; y: number } | null;
    packSprites(): number;
    shownObjects(): number;
    resources(player?: number): { food: number; wood: number; gold: number; stone: number };
    resourcesAt(turn: number, player: number): { food: number; wood: number; gold: number; stone: number } | undefined;
    objects(): { id: number; owner: number; type: number; x: number; y: number; state: number; heldType: number; heldAmount: number; hp: number; graphic: number; frame: number; inside: number | null; cargo: number[]; work: number; overlays: number[] }[];
    issueWork(units: number[], target: number, x: number, y: number): void;
    objectScreenPos(id: number): { x: number; y: number } | null;
    population(player?: number): { count: number; headroom: number; limit: number };
    buildings(): {
      id: number;
      owner: number;
      type: number;
      x: number;
      y: number;
      state: number;
      hp: number;
      progress: number;
      graphic: number;
      facet: number;
      queue: { records: { unit: number; count: number }[]; training: { unit: number; progress: number } | null };
      research: { tech: number; progress: number } | null;
    }[];
    queue(id: number): { records: { unit: number; count: number }[]; training: { unit: number; progress: number } | null } | null;
    ghost(): { unit: number; x: number; y: number; fits: boolean; segments?: { x: number; y: number; facet: number; fits: boolean }[] } | null;
    net(): { granularity: number; frames: number; frameMs: number; rtt: number[]; frameTimes: number[] };
    delayPongs(ms: number): void;
    forceFrameMs(ms: number): void;
    age(player?: number): number;
    techState(tech: number, player?: number): number;
    objectName(id: number): string | null;
    commandMode(): string | null;
    markers(): { x: number; y: number; frame: number; shown: boolean }[];
    drawnOwner(id: number): number | null;
    drawnOverlays(id: number): number[];
    cursor(): string;
    tileVisibility(col: number, row: number, player?: number): number;
    drawnTile(col: number, row: number): number | null;
    relation(player: number, other: number): number;
    alliedVictory(player: number): boolean;
    minimapPoint(col: number, row: number): { x: number; y: number } | null;
    minimapFrame(): { col: number; row: number; left: number; top: number; right: number; bottom: number } | null;
    sounds(): { event: string; sound: number; game: number; wav: number | null; source: number; file?: string }[];
    audioLevels(): { running: boolean; sound: number; music: number };
    music(): { playing: string | null; on: boolean; volume: number; tracks: number };
    history(player?: number): { population: number[]; events: { time: number; event: number }[] };
    gameResult(): { endCondition: number; winners: number[]; status: number[] } | null;
    score(player?: number): { total: number; military: number; economy: number; religion: number; technology: number; survival: number; wonder: number };
    dropLink(holdMs: number): void;
    issue(command: { type: string; [field: string]: unknown }): void;
    gameTime(): number;
    baseTime(): number;
    desync(): { turn: number; hashes: number[] } | null;
    manifest(): {
      code: string;
      capacity: 2 | 4;
      mode: 'multiplayer' | 'single-player';
      hostSlot: number;
      players: { slot: number; playerId: number; name: string; civ: number }[];
      seed: number;
      settings: Record<string, unknown>;
      versions: { protocol: string; rules: string; build: string; assets: string };
    } | null;
    names(): string[];
    droppedPlayers(): number[];
    slot(): number;
    mode(): 'multiplayer' | 'single-player';
  };
  __lobby?: {
    phase(): 'idle' | 'lobby' | 'playing' | 'ended';
    code(): string;
    you(): number;
    capacity(): number;
    hostSlot(): number;
    mode(): 'multiplayer' | 'single-player';
    players(): { slot: number; name: string; ready: boolean; civ: number }[];
    seats(): { slot: number; status: 'open' | 'occupied' | 'away' | 'resigned' | 'dropped'; name: string | null; civ: number | null; ready: boolean }[];
    versions(): { protocol: string; rules: string; build: string; assets: string } | null;
    error(): { code: string; message: string } | null;
  };
}

// The slice of `window.__map` (apps/client/src/map/debug.ts, `?debug=map` or `?debug=net`) that tests read.
interface Window {
  __map?: {
    source: 'pack' | 'debug';
    width: number;
    height: number;
    mapHash: number;
    camera(): { x: number; y: number };
    centerOnTile(col: number, row: number): void;
    setCamera(x: number, y: number): void;
    drawnTiles(): number;
    tileScreenPos(col: number, row: number): { x: number; y: number };
    tileAt(canvasX: number, canvasY: number): { col: number; row: number } | null;
    tileInfo(col: number, row: number): { terrain: number; height: number; type: number; border: number; borderShape: number };
    debugTerrains(): number[];
    showAll(): void;
  };
}

// The slice of `window.__skirmish` (apps/client/src/skirmish.ts, `?debug=combat`) that tests read.
interface Window {
  __skirmish?: {
    turn(): number;
    objects(): { id: number; owner: number; type: number; x: number; y: number; z: number; state: number; graphic: number }[];
    packSprites(): number;
    shownObjects(): number;
    objectScreenPos(id: number): { x: number; y: number } | null;
  };
}
