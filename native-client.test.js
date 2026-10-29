import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {createRelay} from './server.js';
const exe=fileURLToPath(new URL('../work/native_regression/build/Release/production_relay_probe.exe',import.meta.url));
test('production WinHTTP client connects, late joins, translates timestamps and shuts down',{skip:process.platform!=='win32'||!existsSync(exe),timeout:25000},async t=> {
  const relay=createRelay();relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');t.after(()=>relay.close());
  const url=`ws://127.0.0.1:${relay.server.address().port}/v1`;
  function run(id,mode) {
    const child=spawn(exe,[url,id,mode,'ChuggaChugga'],{windowsHide:true});
    let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    const finished=once(child,'exit');return {child,finished,output:()=>output};
  }
  const publisher=run('76561198000000001','publish');t.after(()=>publisher.child.kill());
  const end=Date.now()+8000;
  while(!publisher.output().includes('CONNECTED') && Date.now()<end)await new Promise(r=>setTimeout(r,20));
  assert.match(publisher.output(),/CONNECTED/);
  await new Promise(r=>setTimeout(r,500));
  const observer=run('76561198000000002','observe');t.after(()=>observer.child.kill());
  const [code]=await observer.finished;assert.equal(code,0,observer.output());assert.match(observer.output(),/RECEIVED/);
  const [publisherCode]=await publisher.finished;assert.equal(publisherCode,0,publisher.output());
  assert.equal((publisher.output().match(/relay: connected/g)||[]).length,1,publisher.output());
});

test('production WinHTTP client receives its server-assigned joined wagon role',{skip:process.platform!=='win32'||!existsSync(exe),timeout:15000},async t=> {
  const relay=createRelay();relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');t.after(()=>relay.close());
  const url=`ws://127.0.0.1:${relay.server.address().port}/v1`;
  const leader=new WebSocket(url);await once(leader,'open');t.after(()=>leader.terminate());
  // Read the production client's catalog from the generated server catalog.
  const {readFileSync}=await import('node:fs');const catalog=JSON.parse(readFileSync(new URL('./catalog.json',import.meta.url)));
  leader.send(JSON.stringify({t:'hello',v:1,id:'76561198000000001',room:'match:probe',catalog:catalog.id,token:''}));
  leader.send(JSON.stringify({t:'start',emote:'ChuggaChugga',start:Date.now()-1000}));
  const child=spawn(exe,[url,'76561198000000002','join','ChuggaChugga','76561198000000001'],{windowsHide:true});t.after(()=>child.kill());
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  assert.equal((await once(child,'exit'))[0],0,output);assert.match(output,/role=1/);
});

test('production WinHTTP client reconnects and republishes its original timestamp',{skip:process.platform!=='win32'||!existsSync(exe),timeout:25000},async t=> {
  let relay=createRelay();relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
  t.after(()=>relay.close());const port=relay.server.address().port;
  const child=spawn(exe,[`ws://127.0.0.1:${port}/v1`,'76561198000000001','publish','ChuggaChugga'],{windowsHide:true});t.after(()=>child.kill());
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const exit=once(child,'exit');
  const state=()=>[...relay.rooms.values()].flatMap(r=>[...r.values()]).find(p=>p.state)?.state;
  async function until(predicate){const end=Date.now()+8000;while(Date.now()<end){const value=predicate();if(value)return value;await new Promise(r=>setTimeout(r,20));}throw Error(output||'native reconnect timed out');}
  const original=(await until(state)).start;
  await relay.close();relay=createRelay();relay.server.listen(port,'127.0.0.1');await once(relay.server,'listening');
  const recovered=await until(state);assert.ok(Math.abs(recovered.start-original)<50,`${recovered.start} vs ${original}`);
  assert.equal((await exit)[0],0,output);
});
