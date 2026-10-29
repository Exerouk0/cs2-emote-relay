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
