import {test} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {createRelay} from './server.js';
import catalog from './catalog.json' with {type:'json'};

test('removed Chugga emote is absent from the published catalog',()=> {
  assert.equal(catalog.emotes.some(emote=>emote.emote==='ChuggaChugga'),false);
});

const ids=['76561198000000001','76561198000000002','76561198000000003','76561198000000004'];
test('joining capability is advertised in both health and welcome',async t=> {
  const f=await fixture(t),client=await f.client(ids[0],'diagnostic:capability','fnemotes-group-v2');
  assert.equal(client.messages.find(m=>m.t==='welcome').groupProtocol,2);
  const health=await fetch(`http://127.0.0.1:${f.server.address().port}/healthz`).then(r=>r.json());
  assert.equal(health.groupProtocol,2);assert.equal(health.ok,true);
  assert.equal(health.build,'native-join-leave-v1');assert.equal(client.messages.find(m=>m.t==='welcome').build,health.build);
});
async function fixture(t,options={}) {
  const relay=createRelay(options);relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
  t.after(()=>relay.close());
  const clients=[];
  async function client(id,room='match:test',catalog='fnemotes-v1') {
    const ws=new WebSocket(`ws://127.0.0.1:${relay.server.address().port}/v1`);
    const messages=[];ws.on('message',b=>messages.push(JSON.parse(b)));await once(ws,'open');clients.push(ws);
    ws.send(JSON.stringify({t:'hello',v:1,id,room,catalog,token:options.token||''}));
    await wait(()=>messages.find(m=>m.t==='snapshotEnd'));
    return {ws,messages,send:m=>ws.send(JSON.stringify(m))};
  }
  return {...relay,client};
}
async function wait(predicate) {const end=Date.now()+2000;while(Date.now()<end){const result=predicate();if(result)return result;await new Promise(r=>setTimeout(r,5));}throw Error('timed out');}

test('group v2 reserves one canonical pose, validates arrival and preserves it in snapshots',async t=> {
  const f=await fixture(t),host=await f.client(ids[0],'match:test','fnemotes-group-v2'),a=await f.client(ids[1],'match:test','fnemotes-group-v2');
  const start=Date.now(),group={id:'test-group',match:true,frame:{p:[100,20,5],yaw:90},slots:[{p:[40,-10,0],yaw:30,asset:'role-sha'}]};
  host.send({t:'start',emote:'FutureBand',start,roles:1,group});
  await wait(()=>a.messages.find(m=>m.group));
  a.send({t:'join',leader:ids[0],groupId:'wrong-pack'});
  await wait(()=>a.messages.find(m=>m.t==='joinRejected'));
  a.send({t:'join',leader:ids[0],groupId:group.id});
  const member=await wait(()=>a.messages.find(m=>m.leader));
  assert.deepEqual(member.slot,{p:[110,60,5],yaw:120});assert.equal(member.slotAsset,'role-sha');
  a.send({t:'ready',reservation:'stale',arrival:member.slot});
  host.send({t:'start',emote:'FutureBand',start,roles:1,group:{...group,frame:{p:[900,900,0],yaw:0}}});
  await wait(()=>host.messages.filter(m=>m.id===ids[0] && m.group).length>=2);
  const room=[...f.rooms.values()][0];assert.equal(room.get(ids[1]).state.approaching,true);
  assert.deepEqual(room.get(ids[0]).state.group.frame,group.frame);
  a.send({t:'ready',reservation:member.reservation,arrival:{p:[999,0,0],yaw:120}});
  await wait(()=>a.messages.filter(m=>m.t==='joinRejected').length===2);
  assert.equal(room.get(ids[1]).state.approaching,true);
  const arrived={p:[111,60,6],yaw:120};
  a.send({t:'ready',reservation:member.reservation,arrival:arrived});
  const ready=await wait(()=>host.messages.find(m=>m.leader && !m.approaching));assert.deepEqual(ready.slot,arrived);
  const late=await f.client(ids[2],'match:test','fnemotes-group-v2');
  assert.deepEqual(late.messages.find(m=>m.leader).slot,arrived);
  host.send({t:'start',emote:'FutureBand',start:start+200,roles:1,group});
  await wait(()=>room.get(ids[1]).state===null);
});

test('state changes reach the same room; other rooms and catalogs remain isolated',async t=> {
  const f=await fixture(t),a=await f.client(ids[0]),b=await f.client(ids[1]);
  const other=await f.client(ids[2],'match:other'),old=await f.client(ids[3],'match:test','old-catalog');
  a.send({t:'start',id:ids[1],emote:'LilSupercar',start:Date.now()});
  const event=await wait(()=>b.messages.find(m=>m.t==='state'));
  assert.equal(event.id,ids[0]);assert.equal(event.emote,'LilSupercar');
  assert.equal(other.messages.some(m=>m.t==='state'),false);assert.equal(old.messages.some(m=>m.t==='state'),false);
});
test('late join gets the original timestamp; stop clears only the sender state',async t=> {
  const f=await fixture(t),a=await f.client(ids[0]);const start=Date.now()-5000;
  a.send({t:'start',emote:'LilSupercar',start});await wait(()=>a.messages.find(m=>m.emote));
  const b=await f.client(ids[1]),c=await f.client(ids[2]);
  assert.equal(b.messages.find(m=>m.emote)?.start,start);
  assert.equal(c.messages.find(m=>m.id===ids[0] && m.emote)?.start,start);
  a.send({t:'stop'});
  await wait(()=>b.messages.find(m=>m.id===ids[0] && !m.emote));
  assert.equal([...f.rooms.values()][0].get(ids[1]).state,null);
  assert.equal([...f.rooms.values()][0].get(ids[2]).state,null);
});
test('disconnect removes player and empty rooms are reclaimed',async t=> {
  const f=await fixture(t),a=await f.client(ids[0]),b=await f.client(ids[1]);
  a.send({t:'start',emote:'LilSupercar',start:Date.now()});await wait(()=>b.messages.find(m=>m.emote));
  a.ws.close();await wait(()=>b.messages.find(m=>m.t==='remove'));
  assert.equal([...f.rooms.values()][0].get(ids[1]).state,null);
  b.ws.close();await wait(()=>f.rooms.size===0);
});

test('same emote shares its song epoch through late joins and leader departure',async t=> {
  const f=await fixture(t),a=await f.client(ids[0]),b=await f.client(ids[1]);
  const first=Date.now()-7000,second=Date.now()-1000;
  a.send({t:'start',emote:'PizzaParty',start:first});
  await wait(()=>b.messages.find(m=>m.id===ids[0] && m.emote));
  b.send({t:'start',emote:'PizzaParty',start:second});
  const joined=await wait(()=>b.messages.find(m=>m.id===ids[1] && m.emote));
  assert.equal(joined.start,second);assert.equal(joined.musicStart,first);
  a.ws.close();await wait(()=>b.messages.find(m=>m.t==='remove'));
  const c=await f.client(ids[2]);
  assert.equal(c.messages.find(m=>m.id===ids[1] && m.emote).musicStart,first);
  c.send({t:'start',emote:'PizzaParty',start:Date.now()});
  assert.equal((await wait(()=>c.messages.find(m=>m.id===ids[2] && m.emote))).musicStart,first);
  b.send({t:'stop'});c.send({t:'stop'});
  await wait(()=>[...f.rooms.values()][0].get(ids[2]).state===null);
  const fresh=Date.now();b.send({t:'start',emote:'PizzaParty',start:fresh});
  const restarted=await wait(()=>b.messages.find(m=>m.id===ids[1] && m.start===fresh));
  assert.equal(restarted.musicStart,fresh);
});
test('clock echo supplies epoch time; malformed and oversized packets are rejected',async t=> {
  const f=await fixture(t),a=await f.client(ids[0]);
  a.send({t:'ping',client:123});const pong=await wait(()=>a.messages.find(m=>m.t==='pong'));
  assert.equal(pong.client,123);assert.ok(Math.abs(Date.now()-pong.server)<1000);
  a.send({t:'start',emote:'bad/path',start:Date.now()});const [code]=await once(a.ws,'close');assert.equal(code,1008);
  const b=await f.client(ids[1]);b.ws.send('x'.repeat(5000));assert.equal((await once(b.ws,'close'))[0],1009);
});
test('every current emote and a future pack entry relay without a server allowlist',async t=> {
  const f=await fixture(t),a=await f.client(ids[0]),b=await f.client(ids[1]),observer=await f.client(ids[2]);
  const names=catalog.emotes.map(row=>row.emote).concat('FuturePackEmote_2027');
  // Distribute publishers to stay below each connection's normal burst limit.
  for(let index=0;index<names.length;index++) {
    if(index && index%50===0)await new Promise(resolve=>setTimeout(resolve,2600));
    const publisher=index%2?a:b;
    const emote=names[index];
    publisher.send({t:'start',emote,start:Date.now()});
    const event=await wait(()=>observer.messages.find(message=>message.t==='state' && message.emote===emote));
    assert.equal(event.emote,emote);
  }
  const late=await f.client(ids[3]);
  assert.ok(late.messages.some(message=>message.emote==='FuturePackEmote_2027'));
});
test('shared access token is checked before rooms are joined',async t=> {
  const f=await fixture(t,{token:'correct-token'});
  const ws=new WebSocket(`ws://127.0.0.1:${f.server.address().port}/v1`);await once(ws,'open');
  ws.send(JSON.stringify({t:'hello',v:1,id:ids[0],room:'match:test',catalog:'fnemotes-v1',token:'wrong'}));
  assert.equal((await once(ws,'close'))[0],1008);assert.equal(f.rooms.size,0);
});

test('joining reserves unique participant roles, requires arrival, and shares the host epoch',async t=> {
  const f=await fixture(t),host=await f.client(ids[0]),a=await f.client(ids[1]),b=await f.client(ids[2]);
  const start=Date.now()-3000;
  host.send({t:'start',emote:'FutureBand',start,roles:2,duplicates:false});
  await wait(()=>a.messages.find(m=>m.id===ids[0] && m.emote));
  a.send({t:'join',leader:ids[0]});b.send({t:'join',leader:ids[0]});
  const joinedA=await wait(()=>a.messages.find(m=>m.id===ids[1] && m.leader));
  const joinedB=await wait(()=>b.messages.find(m=>m.id===ids[2] && m.leader));
  assert.equal(joinedA.approaching,true);assert.equal(joinedB.approaching,true);
  assert.notEqual(joinedA.role,joinedB.role);assert.equal(joinedA.start,start);
  const c=await f.client(ids[3]);c.send({t:'join',leader:ids[0]});
  assert.equal((await wait(()=>c.messages.find(m=>m.t==='joinRejected'))).reason,'full');
  a.send({t:'ready'});
  await wait(()=>b.messages.find(m=>m.id===ids[1] && m.leader && !m.approaching));
  b.send({t:'ready'});
  await wait(()=>a.messages.find(m=>m.id===ids[2] && m.leader && !m.approaching));
  // Updating duplicate visibility must not evict already joined players.
  host.send({t:'start',emote:'FutureBand',start,roles:2,duplicates:true});
  await wait(()=>[...f.rooms.values()][0].get(ids[0]).state?.duplicates===true);
  assert.equal([...f.rooms.values()][0].get(ids[1]).state.leader,ids[0]);
  b.send({t:'stop'});await wait(()=>[...f.rooms.values()][0].get(ids[2]).state===null);
  assert.equal([...f.rooms.values()][0].get(ids[0]).state.start,start);
  assert.equal([...f.rooms.values()][0].get(ids[1]).state.leader,ids[0]);
  c.send({t:'join',leader:ids[0]});
  const replacement=await wait(()=>c.messages.find(m=>m.id===ids[3] && m.leader));
  assert.equal(replacement.role,joinedB.role);assert.equal(replacement.start,start);
  a.ws.close();await wait(()=>![...f.rooms.values()][0].has(ids[1]));
  assert.equal([...f.rooms.values()][0].get(ids[0]).state.start,start);
  assert.equal([...f.rooms.values()][0].get(ids[3]).state.leader,ids[0]);
});

test('vehicle join colors are randomized non-red variants, consistent in late snapshots',async t=> {
  const f=await fixture(t),host=await f.client(ids[0]),a=await f.client(ids[1]),b=await f.client(ids[2]);
  host.send({t:'start',emote:'FutureVehicle',start:Date.now(),variants:3,traversal:true});
  await wait(()=>a.messages.find(m=>m.id===ids[0] && m.emote));
  a.send({t:'join',leader:ids[0]});b.send({t:'join',leader:ids[0]});
  const one=await wait(()=>a.messages.find(m=>m.id===ids[1] && m.leader));
  const two=await wait(()=>b.messages.find(m=>m.id===ids[2] && m.leader));
  assert.ok(one.variant>=1 && one.variant<=3);assert.ok(two.variant>=1 && two.variant<=3);
  assert.notEqual(one.variant,two.variant);assert.equal(one.approaching,false);
  const late=await f.client(ids[3]);assert.equal(late.messages.find(m=>m.id===ids[1] && m.leader).variant,one.variant);
  a.send({t:'stop'});await wait(()=>[...f.rooms.values()][0].get(ids[1]).state===null);
  assert.ok([...f.rooms.values()][0].get(ids[0]).state);assert.ok([...f.rooms.values()][0].get(ids[2]).state);
  host.ws.close();await wait(()=>[...f.rooms.values()][0].get(ids[2]).state===null);
});

test('host switches and disconnects remove joined participants',async t=> {
  const f=await fixture(t),host=await f.client(ids[0]),a=await f.client(ids[1]);
  host.send({t:'start',emote:'BandA',roles:1,start:Date.now()});
  await wait(()=>a.messages.find(m=>m.emote==='BandA'));
  a.send({t:'join',leader:ids[0]});await wait(()=>a.messages.find(m=>m.id===ids[1] && m.leader));
  host.send({t:'start',emote:'BandB',roles:1,start:Date.now()});
  await wait(()=>[...f.rooms.values()][0].get(ids[1]).state===null);
  a.send({t:'join',leader:ids[0]});await wait(()=>a.messages.find(m=>m.id===ids[1] && m.emote==='BandB'));
  host.ws.close();await wait(()=>[...f.rooms.values()][0].get(ids[1]).state===null);
});
