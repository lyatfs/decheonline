import { describe, expect, test, vi } from 'vitest';
import { PauseControl, type PauseState } from './pause-control';

describe('PauseControl', () => {
  test('canToggle allows only single-player host when game is not over', () => {
    const hostSp = new PauseControl({ mode: 'single-player', isHost: true });
    expect(hostSp.canToggle()).toBe(true);
    expect(hostSp.canToggle('single-player', false)).toBe(true);
    expect(hostSp.canToggle('single-player', true)).toBe(false);
    expect(hostSp.canToggle('multiplayer', false)).toBe(false);

    const botSp = new PauseControl({ mode: 'single-player', isHost: false });
    expect(botSp.canToggle()).toBe(false);
    expect(botSp.canToggle('single-player', false)).toBe(false);

    const mp = new PauseControl({ mode: 'multiplayer', isHost: true });
    expect(mp.canToggle()).toBe(false);
  });

  test('toggle sends pause request with current epoch and blocks duplicate requests while pending (Q04)', () => {
    const sent: { t: 'pause'; paused: boolean; epoch: number }[] = [];
    const ctrl = new PauseControl({
      mode: 'single-player',
      isHost: true,
      send: (m) => sent.push(m),
    });

    expect(ctrl.toggle()).toBe(true);
    expect(sent).toEqual([{ t: 'pause', paused: true, epoch: 0 }]);
    expect(ctrl.pending).toBe(true);
    expect(ctrl.desiredPaused).toBe(true);
    expect(ctrl.paused).toBe(false);

    // Repeated F3 while awaiting server ack is ignored
    expect(ctrl.toggle()).toBe(false);
    expect(sent).toHaveLength(1);

    // Server confirms pause with epoch 1
    expect(ctrl.applyPaused({ paused: true, boundary: 4, epoch: 1 })).toBe(true);
    expect(ctrl.paused).toBe(true);
    expect(ctrl.boundary).toBe(4);
    expect(ctrl.epoch).toBe(1);
    expect(ctrl.pending).toBe(false);

    // Next toggle requests resume at epoch 1
    expect(ctrl.toggle()).toBe(true);
    expect(sent).toEqual([
      { t: 'pause', paused: true, epoch: 0 },
      { t: 'pause', paused: false, epoch: 1 },
    ]);
  });

  test('ignores stale and duplicate epoch paused messages (Q04)', () => {
    const changes: PauseState[] = [];
    const ctrl = new PauseControl({
      mode: 'single-player',
      isHost: true,
      onChange: (s) => changes.push(s),
    });

    expect(ctrl.applyPaused({ paused: true, boundary: 5, epoch: 2 })).toBe(true);
    expect(changes).toHaveLength(1);

    // Duplicate epoch 2
    expect(ctrl.applyPaused({ paused: false, boundary: 99, epoch: 2 })).toBe(false);
    // Stale epoch 1
    expect(ctrl.applyPaused({ paused: false, boundary: 1, epoch: 1 })).toBe(false);
    expect(ctrl.paused).toBe(true);
    expect(ctrl.boundary).toBe(5);
    expect(ctrl.epoch).toBe(2);
    expect(changes).toHaveLength(1);
  });

  test('applySnapshot recovers pause state from rejoined and ignores stale snapshots (Q05)', () => {
    const onChange = vi.fn();
    const ctrl = new PauseControl({ mode: 'single-player', isHost: true, onChange });

    expect(ctrl.applySnapshot({ paused: true, pauseBoundary: 8, pauseEpoch: 3 })).toBe(true);
    expect(ctrl.paused).toBe(true);
    expect(ctrl.boundary).toBe(8);
    expect(ctrl.epoch).toBe(3);
    expect(ctrl.pending).toBe(false);
    expect(onChange).toHaveBeenCalledTimes(1);

    // Stale snapshot (epoch 2 < 3) is ignored
    expect(ctrl.applySnapshot({ paused: false, pauseBoundary: 2, pauseEpoch: 2 })).toBe(false);
    expect(ctrl.paused).toBe(true);
    expect(ctrl.epoch).toBe(3);

    // Newer snapshot resumes
    expect(ctrl.applySnapshot({ paused: false, pauseBoundary: 8, pauseEpoch: 4 })).toBe(true);
    expect(ctrl.paused).toBe(false);
    expect(ctrl.epoch).toBe(4);
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
