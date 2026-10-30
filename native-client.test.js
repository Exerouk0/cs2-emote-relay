import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {once} from 'node:events';
import {WebSocket} from 'ws';
import {createRelay} from './server.js';
const exe=fileURLToPath(new URL('../work/native_regression/build/Release/production_relay_probe.exe',import.meta.url));

test('production client reserves a role and confirms arrival over WinHTTP',{skip:process.platform!=='win32'||!existsSync(exe),timeout:20000},async t=> {
  const relay=createRelay();relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');t.after(()=>relay.close());
  const url=`ws://127.0.0.1:${relay.server.address().port}/v1`;
  const host=new WebSocket(url);await once(host,'open');const messages=[];
  host.on('message',b=>messages.push(JSON.parse(b)));t.after(()=>host.close());
  host.send(JSON.stringify({t:'hello',v:1,id:'76561198000000001',room:'match:probe',catalog:'fnemotes-group-v2',token:''}));
  const until=async predicate=>{const end=Date.now()+8000;while(Date.now()<end){const value=predicate();if(value)return value;await new Promise(r=>setTimeout(r,10));}throw Error('native joining timed out');};
  await until(()=>messages.find(m=>m.t==='welcome'));
  host.send(JSON.stringify({t:'start',emote:'FutureGroup',roles:1,start:Date.now()-2000,duplicates:false,group:{id:'native-group-v2',frame:{p:[100,20,0],yaw:90},match:true,slots:[{p:[40,-10,0],yaw:0,asset:'native-role'}]}}));
  await until(()=>messages.find(m=>m.emote==='FutureGroup'));
  const child=spawn(exe,[url,'76561198000000002','join','FutureGroup','76561198000000001'],{windowsHide:true});t.after(()=>child.kill());
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const exit=once(child,'exit');
  const pending=await until(()=>messages.find(m=>m.id==='76561198000000002' && m.approaching));
  assert.equal(pending.role,1);assert.equal(pending.leader,'76561198000000001');
  await until(()=>messages.find(m=>m.id==='76561198000000002' && m.leader && m.approaching===false));
  assert.equal((await exit)[0],0,output);assert.match(output,/RECEIVED/);
});
test('production WinHTTP client connects, late joins, translates timestamps and shuts down',{skip:process.platform!=='win32'||!existsSync(exe),timeout:25000},async t=> {
  const relay=createRelay();relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');t.after(()=>relay.close());
  const url=`ws://127.0.0.1:${relay.server.address().port}/v1`;
  function run(id,mode) {
    const child=spawn(exe,[url,id,mode,'LilSupercar'],{windowsHide:true});
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

test('production WinHTTP client reconnects and republishes its original timestamp',{skip:process.platform!=='win32'||!existsSync(exe),timeout:25000},async t=> {
  let relay=createRelay();relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');
  t.after(()=>relay.close());const port=relay.server.address().port;
  const child=spawn(exe,[`ws://127.0.0.1:${port}/v1`,'76561198000000001','publish','LilSupercar'],{windowsHide:true});t.after(()=>child.kill());
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const exit=once(child,'exit');
  const state=()=>[...relay.rooms.values()].flatMap(r=>[...r.values()]).find(p=>p.state)?.state;
  async function until(predicate){const end=Date.now()+8000;while(Date.now()<end){const value=predicate();if(value)return value;await new Promise(r=>setTimeout(r,20));}throw Error(output||'native reconnect timed out');}
  const original=(await until(state)).start;
  await relay.close();relay=createRelay();relay.server.listen(port,'127.0.0.1');await once(relay.server,'listening');
  const recovered=await until(state);assert.ok(Math.abs(recovered.start-original)<50,`${recovered.start} vs ${original}`);
  assert.equal((await exit)[0],0,output);
});


test('practice roster change preserves the production client start timestamp',{skip:process.platform!=='win32'||!existsSync(exe),timeout:25000},async t=> {
  const relay=createRelay();relay.server.listen(0,'127.0.0.1');await once(relay.server,'listening');t.after(()=>relay.close());
  const child=spawn(exe,[`ws://127.0.0.1:${relay.server.address().port}/v1`,'76561198000000001','move','LilSupercar'],{windowsHide:true});t.after(()=>child.kill());
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const exit=once(child,'exit');
  async function until(predicate){const end=Date.now()+8000;while(Date.now()<end){const value=predicate();if(value)return value;await new Promise(r=>setTimeout(r,20));}throw Error(output||'room change timed out');}
  const stateFor=room=>[...relay.rooms.entries()].filter(([key])=>key.endsWith(':'+room)).flatMap(([,r])=>[...r.values()]).find(p=>p.state)?.state;
  const original=(await until(()=>stateFor('match:probe'))).start;
  const moved=await until(()=>stateFor('players:3:changed-roster'));
  assert.ok(Math.abs(moved.start-original)<50,`${moved.start} vs ${original}`);
  assert.equal((await exit)[0],0,output);
});
