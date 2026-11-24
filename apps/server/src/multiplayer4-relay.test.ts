import { describe, expect, test } from 'vitest';
import { DEFAULT_COMPATIBILITY_VERSIONS as versions, MAX_TURNS_AHEAD, type ServerMessage } from '@aoe/protocol';
import { RoomRegistry, type Peer } from './rooms';
class Client implements Peer {
  messages: ServerMessage[]=[];
  send(m:ServerMessage):void{this.messages.push(m);}
  all<T extends ServerMessage['t']>(t:T):Extract<ServerMessage,{t:T}>[]{return this.messages.filter(m=>m.t===t) as Extract<ServerMessage,{t:T}>[];}
}
function fixture(){
  let clock=0;let serial=0;const timers=new Set<()=>void>();
  const registry=new RoomRegistry({generateCode:()=> 'ABCDE',generateCiv:()=>7,generateToken:()=>`token${serial++}`,now:()=>clock,schedule:fn=>{timers.add(fn);return()=>{timers.delete(fn);};}});
  const peers=Array.from({length:4},()=>new Client());registry.handle(peers[0]!,{t:'create',name:'0',capacity:4,versions});
  for(let i=1;i<4;i++)registry.handle(peers[i]!,{t:'join',name:`${i}`,code:'ABCDE',versions});
  for(const p of peers)registry.handle(p,{t:'ready',ready:true});registry.handle(peers[0]!,{t:'start'});
  return{registry,peers,room:registry.roomOf(peers[0]!)!,timers,setClock:(n:number)=>{clock=n;}};
}
describe('multiplayer4 relay',()=>{
  test('four out-of-order senders release identical slot-ordered batches exactly once',()=>{
    const {registry,peers,room}=fixture();
    for(const slot of [3,1,0])for(let turn=0;turn<2;turn++)registry.handle(peers[slot]!,{t:'turn',turn,commands:[{type:'test',x:slot,y:turn}]});
    expect(room.log).toHaveLength(0);registry.handle(peers[2]!,{t:'turn',turn:0,commands:[]});expect(room.log).toHaveLength(1);
    registry.handle(peers[2]!,{t:'turn',turn:0,commands:[{type:'noop'}]});expect(peers[2]!.all('error').at(-1)?.code).toBe('bad-turn');
    registry.handle(peers[2]!,{t:'turn',turn:1,commands:[]});expect(room.log).toHaveLength(2);
    expect(room.log[0]!.batches).toEqual([{slot:0,commands:[{type:'test',x:0,y:0}]},{slot:1,commands:[{type:'test',x:1,y:0}]},{slot:2,commands:[]},{slot:3,commands:[{type:'test',x:3,y:0}]}]);
    for(const p of peers)expect(p.all('turn')).toEqual(peers[0]!.all('turn'));
  });
  test('relay speed uses the largest two round trips rather than all four legs',()=>{
    const {registry,peers,room,setClock}=fixture();for(let slot=0;slot<4;slot++){setClock((slot+1)*100);registry.handle(peers[slot]!,{t:'pong',n:1});}
    const samples:number[]=[];room.speed.boundary=(_turn,_frame,latency)=>{samples.push(latency);return null;};
    for(const p of peers)registry.handle(p,{t:'turn',turn:0,commands:[]});expect(samples).toEqual([700]);
  });
  test('slot3 reconnect restores original manifest, pending cursor, and only missing turns',()=>{
    const {registry,peers,room,timers}=fixture();const start=peers[3]!.all('start')[0]!;
    for(const p of peers)registry.handle(p,{t:'turn',turn:0,commands:[]});
    registry.handle(peers[3]!,{t:'turn',turn:1,commands:[{type:'noop'}]});registry.disconnect(peers[3]!,true);
    for(const p of peers.slice(0,3))registry.handle(p,{t:'turn',turn:1,commands:[]});
    const bad=new Client();registry.handle(bad,{t:'rejoin',code:'ABCDE',slot:3,token:'wrong',received:1});expect(bad.all('error')[0]?.code).toBe('bad-rejoin');expect(timers.size).toBe(1);
    for(const received of [-1,0.5,3]){registry.handle(bad,{t:'rejoin',code:'ABCDE',slot:3,token:start.token,received});expect(registry.roomOf(bad)).toBeUndefined();}
    const back=new Client();registry.handle(back,{t:'rejoin',code:'ABCDE',slot:3,token:start.token,received:1});
    expect(back.all('rejoined')[0]).toMatchObject({nextTurn:2,capacity:4,hostSlot:0,manifest:start.manifest});expect(back.all('turn').map(m=>m.turn)).toEqual([1]);expect(timers.size).toBe(0);
    expect(room.members.find(m=>m.peer===back)?.slot).toBe(3);expect(back.all('rtt')[0]!.rtt).toHaveLength(4);
  });
  test('same-turn zero hashes are real samples and missing samples never imply divergence',()=>{
    const {registry,peers}=fixture();for(const p of peers.slice(0,3))registry.handle(p,{t:'hash',turn:0,hash:0});expect(peers[0]!.all('desync')).toEqual([]);
    registry.handle(peers[3]!,{t:'hash',turn:0,hash:1});expect(peers[0]!.all('desync')).toEqual([{t:'desync',turn:0,hashes:[0,0,0,1]}]);
    for(const p of peers)registry.handle(p,{t:'hash',turn:0,hash:999});expect(peers[0]!.all('desync')).toHaveLength(1);
  });
  test('dropping a missing checksum voter rechecks pending samples against remaining peers',()=>{
    const {registry,peers,timers}=fixture();for(const p of peers.slice(0,3))registry.handle(p,{t:'hash',turn:0,hash:p===peers[2]?9:0});
    expect(peers[0]!.all('desync')).toHaveLength(0);registry.disconnect(peers[3]!,true);for(const fire of timers)fire();
    expect(peers[0]!.all('desync')).toEqual([{t:'desync',turn:0,hashes:[0,0,9,0]}]);
  });
  test('checksum storage rejects future samples and prunes uncompleted old rounds',()=>{
    const {registry,peers,room}=fixture();registry.handle(peers[0]!,{t:'hash',turn:MAX_TURNS_AHEAD,hash:2});expect(peers[0]!.all('error').at(-1)?.code).toBe('bad-turn');
    for(let turn=0;turn<MAX_TURNS_AHEAD*3;turn++){for(const p of peers)registry.handle(p,{t:'turn',turn,commands:[]});registry.handle(peers[0]!,{t:'hash',turn,hash:0});}
    expect(room.members[0]!.hashes.size).toBeLessThanOrEqual(MAX_TURNS_AHEAD+1);
    registry.handle(peers[0]!,{t:'hash',turn:0,hash:5});expect(room.members[0]!.hashes.has(0)).toBe(false);
  });
});
