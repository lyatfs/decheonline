import { describe, expect, test } from 'vitest';
import { DEFAULT_COMPATIBILITY_VERSIONS as versions, DEFAULT_GAME_SETTINGS, type ServerMessage } from '@aoe/protocol';
import { RoomRegistry, type Peer } from './rooms';
class Client implements Peer {
  messages: ServerMessage[] = [];
  send(message: ServerMessage): void { this.messages.push(message); }
  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, {t:T}> { return this.messages.filter(m => m.t === t).at(-1) as Extract<ServerMessage, {t:T}>; }
}
function fixture(capacity: 2 | 4 = 4) {
  const registry = new RoomRegistry({ generateCode: () => 'ABCDE', generateCiv: () => 5, generateSeed: () => 123 });
  const peers = Array.from({length: capacity}, () => new Client());
  registry.handle(peers[0]!, {t:'create', name:'P0', capacity, versions});
  for (let i=1;i<capacity;i++) registry.handle(peers[i]!, {t:'join',code:'ABCDE', name:`P${i}`,versions});
  return {registry, peers, room: registry.rooms.get('ABCDE')!};
}
describe('multiplayer4 membership', () => {
  test('fills four stable seats, denies a fifth, and starts only when all four ready', () => {
    const {registry,peers,room}=fixture();
    expect(peers[3]!.last('lobby')).toMatchObject({capacity:4,hostSlot:0,you:3,seats:[{slot:0},{slot:1},{slot:2},{slot:3}]});
    const fifth=new Client(); registry.handle(fifth,{t:'join',code:'ABCDE',name:'fifth',versions});
    expect(fifth.last('error')?.code).toBe('room-full'); expect(room.members).toHaveLength(4);
    for(const p of peers.slice(0,3)) registry.handle(p,{t:'ready',ready:true});
    registry.handle(peers[0]!,{t:'start'}); expect(peers[0]!.last('error')?.code).toBe('not-ready');
    registry.handle(peers[3]!,{t:'ready',ready:true}); registry.handle(peers[0]!,{t:'start'});
    expect(peers[3]!.last('start')).toMatchObject({capacity:4,hostSlot:0,manifest:{players:[{slot:0,playerId:1},{slot:1,playerId:2},{slot:2,playerId:3},{slot:3,playerId:4}],versions}});
  });
  test('three occupied ready seats cannot start room4', () => {
    const {registry,peers,room}=fixture(); registry.handle(peers[3]!,{t:'leave'});
    for(const p of peers.slice(0,3)) registry.handle(p,{t:'ready',ready:true});
    registry.handle(peers[0]!,{t:'start'}); expect(peers[0]!.last('error')?.code).toBe('not-ready'); expect(room.started).toBe(false);
  });
  test('every compatibility identifier is authoritative before membership and ready mutations', () => {
    for (const key of ['protocol','rules','build','assets'] as const) {
      const {registry,peers,room}=fixture(); registry.handle(peers[0]!,{t:'ready',ready:true});
      const before=peers[1]!.messages.length;
      registry.handle(peers[0]!,{t:'ready',ready:false,versions:{...versions,[key]:'wrong'}});
      expect(peers[0]!.last('error')?.code).toBe('version-mismatch'); expect(room.members[0]!.ready).toBe(true); expect(peers[1]!.messages).toHaveLength(before);
    }
  });
  test('start snapshot preserves settings and participant identity independently of lobby data', () => {
    const {registry,peers,room}=fixture(); for(const p of peers) registry.handle(p,{t:'ready',ready:true}); registry.handle(peers[0]!,{t:'start'});
    room.settings.mapSize=96; room.members[3]!.civ=12;
    expect(peers[0]!.last('start').manifest).toMatchObject({settings:{mapSize:144},players:[{slot:0},{slot:1},{slot:2},{slot:3,civ:5}]});
    expect(Object.isFrozen(room.manifest!.settings)).toBe(true); expect(Object.isFrozen(room.manifest!.players[3])).toBe(true);
  });
  test('host leaves a lobby hole without changing any remaining slot or civ', () => {
    const {registry,peers,room}=fixture();
    registry.handle(peers[2]!,{t:'civ',civ:9});
    registry.handle(peers[1]!,{t:'leave'}); registry.handle(peers[0]!,{t:'leave'});
    expect(peers[2]!.last('lobby')).toMatchObject({you:2,hostSlot:2,players:[{slot:2,civ:9},{slot:3,civ:5}],seats:[{slot:0,status:'open'},{slot:1,status:'open'},{slot:2,status:'occupied'},{slot:3,status:'occupied'}]});
    const newcomer=new Client(); registry.handle(newcomer,{t:'join',code:'ABCDE',name:'new',versions});
    expect(newcomer.last('lobby').you).toBe(0);
    registry.handle(newcomer,{t:'settings',settings:DEFAULT_GAME_SETTINGS}); expect(newcomer.last('error')?.code).toBe('not-host');
    registry.handle(peers[2]!,{t:'settings',settings:{...DEFAULT_GAME_SETTINGS,mapSize:96}}); expect(room.settings.mapSize).toBe(96);
  });
  test('version mismatch rejects create/join/ready without changing membership or readiness', () => {
    const bad={...versions,rules:'different'}; const r=new RoomRegistry({generateCode:()=> 'ABCDE'}); const p=new Client();
    r.handle(p,{t:'create',name:'x',capacity:4}); expect(p.last('error')?.code).toBe('version-mismatch'); expect(r.rooms.size).toBe(0);
    r.handle(p,{t:'create',name:'x',capacity:4,versions}); const guest=new Client();
    r.handle(guest,{t:'join',code:'ABCDE',name:'bad',versions:bad}); expect(guest.last('error')?.code).toBe('version-mismatch');
    r.handle(p,{t:'ready',ready:true,versions:bad}); expect(p.last('error')?.code).toBe('version-mismatch'); expect(r.roomOf(p)!.members[0]!.ready).toBe(false);
    const authority={...versions,build:'fixture'}; const custom=new RoomRegistry({versions:authority,generateCode:()=> 'ABCDE'}); const cp=new Client();
    custom.handle(cp,{t:'create',name:'x',capacity:4,versions}); expect(cp.last('error')?.code).toBe('version-mismatch');
    custom.handle(cp,{t:'create',name:'x',capacity:4,versions:authority}); expect(cp.last('lobby').versions).toEqual(authority);
  });
  test('chat rejects any recipient outside room capacity or an open seat before delivery', () => {
    const {registry,peers}=fixture(2);
    for(const to of [[1,3],[1,-1],[1,0.5]]) {
      const before=peers[1]!.messages.length; registry.handle(peers[0]!,{t:'chat',text:'no partial delivery',to});
      expect(peers[0]!.last('error')?.code).toBe('bad-message'); expect(peers[1]!.messages).toHaveLength(before);
    }
    const four=fixture(); four.registry.handle(four.peers[3]!,{t:'leave'});
    const before=four.peers[1]!.messages.length; four.registry.handle(four.peers[0]!,{t:'chat',text:'open seat',to:[1,3]});
    expect(four.peers[0]!.last('error')?.code).toBe('bad-message'); expect(four.peers[1]!.messages).toHaveLength(before);
  });
  test('legacy rooms default to two and single-player rejects four before creating a room', () => {
    const r=new RoomRegistry({generateCode:()=> 'ABCDE'}); const p=new Client(); r.handle(p,{t:'create',name:'x'});
    expect(p.last('lobby')).toMatchObject({capacity:2,seats:[{slot:0,status:'occupied'},{slot:1,status:'open'}]});
    const solo=new RoomRegistry(); const s=new Client(); solo.handle(s,{t:'create',name:'x',mode:'single-player',capacity:4,versions}); expect(s.last('error')?.code).toBe('invalid-settings'); expect(solo.rooms.size).toBe(0);
  });
});
