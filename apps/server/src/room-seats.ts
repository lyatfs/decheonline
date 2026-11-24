import type { RoomCapacity, RoomSeat } from '@aoe/protocol';

interface SeatMember {
  readonly slot: number;
  name: string;
  civ: number;
  ready: boolean;
  peer: unknown | null;
  resigned: boolean;
  dropped: boolean;
}

/** Membership is a collection; only these wire projections are indexed by seat. */
export function orderedMembers<T extends { readonly slot: number }>(members: readonly T[]): T[] {
  return [...members].sort((a, b) => a.slot - b.slot);
}

export function openSlot(capacity: RoomCapacity, members: readonly { readonly slot: number }[]): number | undefined {
  for (let slot = 0; slot < capacity; slot++) if (!members.some(m => m.slot === slot)) return slot;
  return undefined;
}

export function roomSeats(capacity: RoomCapacity, members: readonly SeatMember[]): RoomSeat[] {
  return Array.from({ length: capacity }, (_, slot) => {
    const m = members.find(m => m.slot === slot);
    if (!m) return { slot, status: 'open', name: null, civ: null, ready: false };
    return { slot, status: m.dropped ? 'dropped' : m.resigned ? 'resigned' : m.peer === null ? 'away' : 'occupied', name: m.name, civ: m.civ, ready: m.ready };
  });
}

/** Freeze every nested settings/manifest array as well as the root object. */
export function freezeSnapshot<T>(value: T): T {
  if (typeof value === 'object' && value !== null) {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
