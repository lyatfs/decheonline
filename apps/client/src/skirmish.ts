import type { Application } from 'pixi.js';
import { STEP_MS, startingObjects, World, type Command, type StartUnit } from '@aoe/sim';
import { createAssetProvider } from './assets';
import { exposeMapDebug, MapView } from './map';
import { UnitLayer } from './units/unit-layer';

// Master ids (empires.dat): Bowman, Clubman, Villager, Asian Spearman.
const BOWMAN = 4;
const CLUBMAN = 73;
const VILLAGER = 83;
const ASIAN_SPEARMAN = 400;
/** Where the fight is, between the two bases. */
const MIDDLE = { x: 20, y: 20 };

/** What `?debug=combat` exposes as `window.__skirmish`, for the real-art screenshot. */
export interface SkirmishDebug {
  turn(): number;
  /** Every sim object with a sprite, in id order, with its height and the dat graphic shown. */
  objects(): { id: number; owner: number; type: number; x: number; y: number; z: number; state: number; graphic: number }[];
  /** Objects drawn with pack sprites (not debug shapes). */
  packSprites(): number;
  /** Objects near the view the player's fog lets it see; every one shows pack art once `packSprites()` equals it. */
  shownObjects(): number;
  /** Canvas pixel at the middle of object `id`'s drawn sprite; null when it is not drawn. */
  objectScreenPos(id: number): { x: number; y: number } | null;
}

declare global {
  interface Window {
    __skirmish?: SkirmishDebug;
  }
}

/**
 * `?debug=combat`: a local fight without a lobby or a peer, for looking at combat art. The usual start plus, in the
 * middle of the map, four of player 1's Bowmen and a Clubman against three of player 2's Villagers and two Clubmen;
 * each side is ordered to attack the other. This client is player 1 and can give orders; turns run at the original's
 * pace times `speed`.
 */
export async function startSkirmish(app: Application, speed: number): Promise<SkirmishDebug> {
  const at = (owner: number, type: number, dx: number, dy: number): StartUnit => ({ owner, type, x: MIDDLE.x + dx, y: MIDDLE.y + dy });
  const fighters = [
    ...[0, 1, 2, 3].map((i) => at(1, BOWMAN, -3.5, -1.5 + i)),
    at(1, CLUBMAN, -2.5, 0.5),
    at(1, ASIAN_SPEARMAN, -2.0, -0.8),
    at(1, ASIAN_SPEARMAN, -2.0, 1.8),
    ...[0, 1, 2].map((i) => at(2, VILLAGER, 2.5, -1.5 + i * 1.5)),
    at(2, CLUBMAN, 3.5, -0.5),
    at(2, CLUBMAN, 3.5, 1.5),
  ];
  const players = 3;
  const world = new World({ players, randomSeed: 1, units: [...startingObjects(players), ...fighters] });
  const ids = (owner: number, type: number) => [...world.entities.ofPlayer(owner)].filter((e) => e.type === type).map((e) => e.id);
  const villagers = ids(2, VILLAGER).filter((id) => world.entities.get(id)!.x > MIDDLE.x);
  const bowmen = ids(1, BOWMAN);
  world.addBatch(0, 1, [
    { type: 'attack', units: bowmen, target: villagers[0]! },
    { type: 'attack', units: ids(1, ASIAN_SPEARMAN), target: villagers[1] ?? villagers[0]! },
  ]);
  world.addBatch(0, 2, [{ type: 'attack', units: ids(2, CLUBMAN), target: bowmen[0]! }]);

  const provider = await createAssetProvider();
  const view = await MapView.create(app, world.map, provider);
  let pending: Command[] = [];
  const stepMs = () => STEP_MS / speed;
  const layer = new UnitLayer({ app, view, world, provider, player: 1, issue: (c) => pending.push(c), stepMs });
  view.lookAt(MIDDLE.x, MIDDLE.y);
  exposeMapDebug(view);
  // One step at a time, so the units slide from step to step as in a game.
  const run = () => {
    if (world.turnStep === 0) {
      world.addBatch(world.turn, 1, pending);
      pending = [];
    }
    world.runStep();
    setTimeout(run, stepMs());
  };
  run();
  return {
    turn: () => world.turn,
    objects: () =>
      [...world.entities.all()]
        .filter((e) => e.sprite)
        .map((e) => ({ id: e.id, owner: e.owner, type: e.type, x: e.x, y: e.y, z: e.z, state: e.state, graphic: e.sprite!.graphic })),
    packSprites: () => layer.packSprites,
    shownObjects: () => layer.shownObjects,
    objectScreenPos: (id) => layer.objectCentre(id),
  };
}
