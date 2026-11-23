import { Container, Texture, type Application } from 'pixi.js';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { startingObjects, TILE_VISIBLE, VILLAGER, World, type Command } from '@aoe/sim';
import type { AssetProvider } from '../assets';
import { Camera } from '../map/camera';
import { Ground } from '../map/elevation';
import type { MapView } from '../map/map-view';
import { UnitLayer } from './unit-layer';

const SMALL_WALL = 72;

type Listener = (event: unknown) => void;

interface MockCanvas {
  element: HTMLCanvasElement;
  captured: Set<number>;
  emit: (type: string, event?: Record<string, unknown>) => void;
  listenerCount: (type?: string) => number;
}

function createMockCanvas(options: { allowCapture?: boolean } = {}): MockCanvas {
  const allowCapture = options.allowCapture ?? true;
  const listeners = new Map<string, Set<Listener>>();
  const captured = new Set<number>();

  const element = {
    style: { cursor: '' },
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }),
    addEventListener: (type: string, fn: Listener) => {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      listeners.get(type)?.delete(fn);
    },
    setPointerCapture: vi.fn((id: number) => {
      if (!allowCapture) throw new Error('NotFoundError: synthetic pointer');
      captured.add(id);
    }),
    releasePointerCapture: vi.fn((id: number) => {
      captured.delete(id);
    }),
    hasPointerCapture: vi.fn((id: number) => captured.has(id)),
  } as unknown as HTMLCanvasElement;

  return {
    element,
    captured,
    emit(type: string, event: Record<string, unknown> = {}) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
    listenerCount(type?: string) {
      if (type) return listeners.get(type)?.size ?? 0;
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
  };
}

interface MockWindow {
  emit: (type: string, event?: Record<string, unknown>) => void;
  listenerCount: (type?: string) => number;
}

function createMockWindow(): MockWindow {
  const listeners = new Map<string, Set<Listener>>();
  vi.stubGlobal('window', {
    addEventListener: (type: string, fn: Listener) => {
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(fn);
    },
    removeEventListener: (type: string, fn: Listener) => {
      listeners.get(type)?.delete(fn);
    },
  });
  return {
    emit(type: string, event: Record<string, unknown> = {}) {
      for (const fn of listeners.get(type) ?? []) fn(event);
    },
    listenerCount(type?: string) {
      if (type) return listeners.get(type)?.size ?? 0;
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    },
  };
}

function pointer(overrides: Partial<{ pointerId: number; button: number; buttons: number; clientX: number; clientY: number; shiftKey: boolean; ctrlKey: boolean }> = {}) {
  return {
    pointerId: 1,
    button: 2,
    buttons: 2,
    clientX: 200,
    clientY: 200,
    shiftKey: false,
    ctrlKey: false,
    ...overrides,
  };
}

function createHarness(options: { allowCapture?: boolean; wallAge?: boolean } = {}) {
  const win = createMockWindow();
  const canvas = createMockCanvas({ allowCapture: options.allowCapture });
  const world = new World({ players: 3, units: startingObjects(3) });
  if (options.wallAge) {
    // Enable Small Wall (tech 11 in Stone/Tool -> Bronze Age start, or enable master directly for testing wall placement).
    world.masters[1]![SMALL_WALL]!.enabled = true;
    world.attributes[1]![2] = 1000; // Stone
  }
  const camera = new Camera(world.map.width, world.map.height, 800, 600);
  const ground = new Ground(world.map, new Set());
  const center = ground.pixel(12, 12);
  camera.centerOn(center.x, center.y);

  const view = {
    camera,
    ground,
    layer: Object.assign(new Container(), { sortableChildren: true }),
    terrainLayer: Object.assign(new Container(), { sortableChildren: true }),
    get view() {
      return { x: camera.x, y: camera.y, w: camera.viewW, h: camera.viewH };
    },
    setFog: () => {},
    fogState: () => TILE_VISIBLE,
    lookAt: (x: number, y: number) => {
      const p = ground.pixel(x, y);
      camera.centerOn(p.x, p.y);
    },
  } as unknown as MapView;

  const app = {
    canvas: canvas.element,
    stage: new Container(),
    screen: { width: 800, height: 600 },
    ticker: { add: vi.fn(), remove: vi.fn() },
    renderer: { extract: { pixels: () => ({ pixels: new Uint8ClampedArray(4), width: 1 }) } },
  } as unknown as Application;

  const provider = {
    kind: 'debug',
    graphicInfo: () => null,
    graphicFrames: async () => [{ texture: Texture.EMPTY, hotspotX: 0, hotspotY: 0 }],
    interfaceFrame: () => null,
    unitInfo: () => null,
    mapArt: () => null,
    string: () => null,
  } as unknown as AssetProvider;

  const issued: Command[] = [];
  const layer = new UnitLayer({
    app,
    view,
    world,
    provider,
    player: 1,
    issue: (cmd) => issued.push(cmd),
    stepMs: () => 90,
  });

  const villager = [...world.entities.ofPlayer(1)].find((e) => e.type === VILLAGER)!;
  layer.selected.add(villager.id);

  return { win, canvas, world, camera, ground, layer, issued, villager };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test('right-click with 0px and <14px jitter dispatches order on pointerup at pointerdown coords', () => {
  const { canvas, camera, ground, layer, issued } = createHarness();
  const camBefore = { x: camera.x, y: camera.y };

  // 0px click
  canvas.emit('pointerdown', pointer({ clientX: 250, clientY: 220 }));
  expect(issued).toHaveLength(0);
  canvas.emit('pointerup', pointer({ clientX: 250, clientY: 220, buttons: 0 }));
  expect(issued).toHaveLength(1);
  const expectedFirst = ground.pointAt(250 + camBefore.x, 220 + camBefore.y);
  expect(issued[0]).toEqual({ type: 'move', units: [layer.primary!], x: expectedFirst.col, y: expectedFirst.row });
  expect(canvas.captured.size).toBe(0);

  // < 14px jitter (distance = hypot(8, 6) = 10 < 14) still dispatches at pointerdown coords (300, 260)
  canvas.emit('pointerdown', pointer({ clientX: 300, clientY: 260 }));
  canvas.emit('pointermove', pointer({ clientX: 308, clientY: 266 }));
  expect(camera.x).toBe(camBefore.x);
  expect(camera.y).toBe(camBefore.y);
  expect(canvas.element.style.cursor).not.toBe('grabbing');
  expect(issued).toHaveLength(1);

  canvas.emit('pointerup', pointer({ clientX: 308, clientY: 266, buttons: 0 }));
  expect(issued).toHaveLength(2);
  const expectedJitter = ground.pointAt(300 + camBefore.x, 260 + camBefore.y);
  expect(issued[1]).toEqual({ type: 'move', units: [layer.primary!], x: expectedJitter.col, y: expectedJitter.row });

  layer.destroy();
});

test('right-drag >=14px captures pointer, pans camera outside canvas, resets cursor/state, and emits no commands', () => {
  const { canvas, camera, layer, issued } = createHarness({ allowCapture: true });
  const startCam = { x: camera.x, y: camera.y };

  canvas.emit('pointerdown', pointer({ pointerId: 7, clientX: 400, clientY: 300 }));
  expect(canvas.element.setPointerCapture).toHaveBeenCalledWith(7);
  expect(canvas.captured.has(7)).toBe(true);

  // Move >= 14px activates drag & grabbing cursor (without jumping on the threshold step)
  canvas.emit('pointermove', pointer({ pointerId: 7, clientX: 420, clientY: 310 }));
  expect(canvas.element.style.cursor).toBe('grabbing');
  expect(camera.x).toBe(startCam.x);
  expect(camera.y).toBe(startCam.y);

  // Subsequent move pans camera smoothly
  canvas.emit('pointermove', pointer({ pointerId: 7, clientX: 450, clientY: 330 }));
  expect(camera.x).toBe(startCam.x - 30);
  expect(camera.y).toBe(startCam.y - 20);

  // Moving outside canvas bounds continues panning because pointer is captured
  canvas.emit('pointermove', pointer({ pointerId: 7, clientX: -50, clientY: -20 }));
  expect(camera.x).toBe(startCam.x - 30 - (-50 - 450));
  expect(camera.y).toBe(startCam.y - 20 - (-20 - 330));

  // Releasing outside canvas ends drag cleanly, releases capture, resets cursor, and emits 0 commands
  canvas.emit('pointerup', pointer({ pointerId: 7, clientX: -50, clientY: -20, buttons: 0 }));
  expect(canvas.element.releasePointerCapture).toHaveBeenCalledWith(7);
  expect(canvas.captured.has(7)).toBe(false);
  expect(canvas.element.style.cursor).toBe('');
  expect(issued).toHaveLength(0);

  // Subsequent move does not pan
  const settledCam = { x: camera.x, y: camera.y };
  canvas.emit('pointermove', pointer({ pointerId: 7, clientX: 100, clientY: 100, buttons: 0 }));
  expect(camera.x).toBe(settledCam.x);
  expect(camera.y).toBe(settledCam.y);

  layer.destroy();
});

test('rightDown cleans up on uncaptured pointerleave, pointercancel, lostpointercapture, window blur, and window pointerup without double-firing', () => {
  // 1. Uncaptured pointerleave clears rightDown; captured pointerleave preserves drag
  {
    const uncaptured = createHarness({ allowCapture: false });
    uncaptured.canvas.emit('pointerdown', pointer({ pointerId: 3, clientX: 400, clientY: 300 }));
    uncaptured.canvas.emit('pointermove', pointer({ pointerId: 3, clientX: 430, clientY: 300 }));
    expect(uncaptured.canvas.element.style.cursor).toBe('grabbing');
    const camAfterDrag = uncaptured.camera.x;

    uncaptured.canvas.emit('pointerleave', pointer({ pointerId: 3 }));
    expect(uncaptured.canvas.element.style.cursor).toBe('');
    uncaptured.canvas.emit('pointermove', pointer({ pointerId: 3, clientX: 460, clientY: 300 }));
    expect(uncaptured.camera.x).toBe(camAfterDrag);
    uncaptured.canvas.emit('pointerup', pointer({ pointerId: 3, clientX: 460, clientY: 300, buttons: 0 }));
    expect(uncaptured.issued).toHaveLength(0);
    uncaptured.layer.destroy();

    const captured = createHarness({ allowCapture: true });
    captured.canvas.emit('pointerdown', pointer({ pointerId: 4, clientX: 400, clientY: 300 }));
    captured.canvas.emit('pointermove', pointer({ pointerId: 4, clientX: 420, clientY: 300 }));
    captured.canvas.emit('pointerleave', pointer({ pointerId: 4 }));
    expect(captured.canvas.element.style.cursor).toBe('grabbing');
    captured.canvas.emit('pointermove', pointer({ pointerId: 4, clientX: 450, clientY: 300 }));
    expect(captured.camera.x).toBeLessThan(400); // Continued panning
    captured.layer.destroy();
  }

  // 2. pointercancel and lostpointercapture clear rightDown
  for (const eventName of ['pointercancel', 'lostpointercapture'] as const) {
    const { canvas, camera, layer, issued } = createHarness();
    canvas.emit('pointerdown', pointer({ pointerId: 5, clientX: 300, clientY: 300 }));
    canvas.emit('pointermove', pointer({ pointerId: 5, clientX: 325, clientY: 300 }));
    const camX = camera.x;
    canvas.emit(eventName, pointer({ pointerId: 5 }));
    expect(canvas.element.style.cursor).toBe('');
    canvas.emit('pointermove', pointer({ pointerId: 5, clientX: 350, clientY: 300 }));
    expect(camera.x).toBe(camX);
    canvas.emit('pointerup', pointer({ pointerId: 5, clientX: 350, clientY: 300, buttons: 0 }));
    expect(issued).toHaveLength(0);
    layer.destroy();
  }

  // 3. window.blur clears rightDown (and selection press/box)
  {
    const { win, canvas, camera, layer, issued } = createHarness();
    canvas.emit('pointerdown', pointer({ pointerId: 6, clientX: 300, clientY: 300 }));
    canvas.emit('pointermove', pointer({ pointerId: 6, clientX: 330, clientY: 300 }));
    const camX = camera.x;
    win.emit('blur');
    expect(canvas.element.style.cursor).toBe('');
    canvas.emit('pointermove', pointer({ pointerId: 6, clientX: 360, clientY: 300 }));
    expect(camera.x).toBe(camX);
    canvas.emit('pointerup', pointer({ pointerId: 6, clientX: 360, clientY: 300, buttons: 0 }));
    expect(issued).toHaveLength(0);
    layer.destroy();
  }

  // 4. window.pointerup cleans up uncaptured release outside canvas without emitting orderAt,
  //    and bubbling after canvas.pointerup does not double-fire orderAt.
  {
    const { win, canvas, camera, layer, issued } = createHarness({ allowCapture: false });
    canvas.emit('pointerdown', pointer({ pointerId: 8, clientX: 300, clientY: 300 }));
    canvas.emit('pointermove', pointer({ pointerId: 8, clientX: 320, clientY: 300 }));
    const camX = camera.x;
    win.emit('pointerup', pointer({ pointerId: 8, button: 2, buttons: 0 }));
    expect(canvas.element.style.cursor).toBe('');
    canvas.emit('pointermove', pointer({ pointerId: 8, clientX: 360, clientY: 300 }));
    expect(camera.x).toBe(camX);
    expect(issued).toHaveLength(0);

    // Normal click: canvas pointerup fires orderAt once; subsequent bubbled window pointerup does not double-fire
    canvas.emit('pointerdown', pointer({ pointerId: 8, clientX: 250, clientY: 250 }));
    canvas.emit('pointerup', pointer({ pointerId: 8, button: 2, buttons: 0, clientX: 250, clientY: 250 }));
    win.emit('pointerup', pointer({ pointerId: 8, button: 2, buttons: 0, clientX: 250, clientY: 250 }));
    expect(issued).toHaveLength(1);
    layer.destroy();
  }
});

test('startPlacement and armCommand clear rightDown, and wallDrag prioritizes placing while preserving chorded right-cancel', () => {
  const { canvas, camera, ground, layer, issued } = createHarness({ wallAge: true });
  const p9 = ground.pixel(9.5, 9.5);
  const s9 = { x: p9.x - camera.x, y: p9.y - camera.y };
  const p12 = ground.pixel(12.5, 9.5);
  const s12 = { x: p12.x - camera.x, y: p12.y - camera.y };

  // Start a right-drag and do NOT release before entering wall placement
  canvas.emit('pointerdown', pointer({ pointerId: 10, clientX: 200, clientY: 200 }));
  canvas.emit('pointermove', pointer({ pointerId: 10, clientX: 225, clientY: 200 }));
  expect(canvas.element.style.cursor).toBe('grabbing');
  const camAfterPan = { x: camera.x, y: camera.y };

  layer.startPlacement(SMALL_WALL);
  expect(canvas.element.style.cursor).toBe('');
  expect(canvas.captured.has(10)).toBe(false);

  // A stray right pointermove/pointerup must not pan or issue orderAt
  canvas.emit('pointermove', pointer({ pointerId: 10, clientX: s9.x, clientY: s9.y, buttons: 0 }));
  expect(camera.x).toBe(camAfterPan.x);
  canvas.emit('pointerup', pointer({ pointerId: 10, button: 2, buttons: 0, clientX: s9.x, clientY: s9.y }));
  expect(issued).toHaveLength(0);

  // Left-drag wall line updates ghost segments and issues build-wall on release
  canvas.emit('pointerdown', pointer({ pointerId: 11, button: 0, buttons: 1, clientX: s9.x, clientY: s9.y }));
  canvas.emit('pointermove', pointer({ pointerId: 11, button: 0, buttons: 1, clientX: s12.x, clientY: s12.y }));
  (layer as unknown as { draw: () => void }).draw();
  expect(layer.ghost?.segments?.length).toBe(4);
  canvas.emit('pointerup', pointer({ pointerId: 11, button: 0, buttons: 0, clientX: s12.x, clientY: s12.y }));
  expect(issued).toEqual([{ type: 'build-wall', units: [layer.primary!], unitType: SMALL_WALL, x1: 9, y1: 9, x2: 12, y2: 9 }]);
  expect(layer.ghost).toBeNull();

  // Chorded right-press during wallDrag still cancels placement without issuing build-wall or orderAt
  layer.startPlacement(SMALL_WALL);
  canvas.emit('pointermove', pointer({ pointerId: 11, button: 0, buttons: 0, clientX: s9.x, clientY: s9.y }));
  canvas.emit('pointerdown', pointer({ pointerId: 11, button: 0, buttons: 1, clientX: s9.x, clientY: s9.y }));
  canvas.emit('pointermove', pointer({ pointerId: 11, button: 0, buttons: 3, clientX: s12.x, clientY: s12.y }));
  expect(layer.ghost).toBeNull();
  canvas.emit('pointerup', pointer({ pointerId: 11, button: 0, buttons: 0, clientX: s12.x, clientY: s12.y }));
  expect(issued).toHaveLength(1);

  // armCommand clears rightDown too
  canvas.emit('pointerdown', pointer({ pointerId: 12, clientX: 200, clientY: 200 }));
  canvas.emit('pointermove', pointer({ pointerId: 12, clientX: 230, clientY: 200 }));
  expect(canvas.element.style.cursor).toBe('grabbing');
  layer.armCommand('move');
  expect(canvas.element.style.cursor).toBe('');
  expect(canvas.captured.has(12)).toBe(false);

  layer.destroy();
});

test('multi-pointer isolation ignores foreign pointerIds and destroy() removes all canvas/window listeners', () => {
  const { win, canvas, camera, layer, issued } = createHarness();
  expect(canvas.listenerCount()).toBeGreaterThan(0);
  expect(win.listenerCount()).toBeGreaterThan(0);

  canvas.emit('pointerdown', pointer({ pointerId: 1, clientX: 300, clientY: 300 }));
  canvas.emit('pointermove', pointer({ pointerId: 1, clientX: 320, clientY: 300 }));
  const camDuringDrag = { x: camera.x, y: camera.y };

  // Foreign pointerId 2 must not move camera, overwrite cursor, cancel, or finish pointer 1's rightDown
  canvas.emit('pointermove', pointer({ pointerId: 2, clientX: 500, clientY: 500, buttons: 0 }));
  expect(camera.x).toBe(camDuringDrag.x);
  expect(canvas.element.style.cursor).toBe('grabbing');
  canvas.emit('pointercancel', pointer({ pointerId: 2 }));
  canvas.emit('lostpointercapture', pointer({ pointerId: 2 }));
  canvas.emit('pointerup', pointer({ pointerId: 2, button: 2, buttons: 0, clientX: 300, clientY: 300 }));
  win.emit('pointerup', pointer({ pointerId: 2, button: 2, buttons: 0 }));
  expect(canvas.captured.has(1)).toBe(true);
  expect(issued).toHaveLength(0);

  // destroy() clears rightDown, releases capture, resets cursor, and unregisters all listeners
  layer.destroy();
  expect(canvas.captured.size).toBe(0);
  expect(canvas.element.style.cursor).toBe('');
  expect(canvas.listenerCount()).toBe(0);
  expect(win.listenerCount()).toBe(0);
});
