import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
const catalog=JSON.parse(readFileSync(new URL('./catalog.json',import.meta.url),'utf8'));

const idOK = x => typeof x === 'string' && /^[0-9]{15,20}$/.test(x);
const keyOK = x => typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,96}$/.test(x);
const emoteOK = x => typeof x === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(x);
const same = (a,b) => { const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length && timingSafeEqual(x,y); };

// RAM only. One instance owns a room; horizontal scaling needs shared pub/sub.
export function createRelay(options={}) {
  const rooms=new Map(), sockets=new Set(), byIP=new Map(), peers=new Map();
  const epoch=randomUUID(); let revision=0;
  const token=options.token ?? process.env.RELAY_TOKEN ?? '';
  const limits={total:2000,room:64,perIP:32,...options.limits};
  const server=http.createServer((req,res)=> {
    if(req.url!=='/healthz') {res.writeHead(404);return res.end();}
    res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
    res.end(JSON.stringify({ok:true,protocol:1,catalog:catalog.id,epoch,connections:sockets.size,rooms:rooms.size}));
  });
  const wss=new WebSocketServer({noServer:true,maxPayload:4096,perMessageDeflate:false});
  function send(ws,data) {
    if(ws.readyState!==WebSocket.OPEN)return;
    if(ws.bufferedAmount>65536)return ws.close(1013,'slow receiver');
    ws.send(JSON.stringify(data));
  }
  function broadcast(room,data) {for(const peer of room.values())send(peer.ws,data);}
  function publish(peer) {
    peer.rev=++revision;
    broadcast(peer.room,{t:'state',epoch,rev:peer.rev,id:peer.id,...peer.state});
  }
  function detach(peer) {
    if(!peer.room || peer.room.get(peer.id)!==peer)return;
    const room=peer.room;room.delete(peer.id);
    broadcast(room,{t:'remove',epoch,rev:++revision,id:peer.id});
    if(!room.size)rooms.delete(peer.roomKey);
    peer.room=null;
  }
  server.on('upgrade',(req,socket,head)=> {
    const forwarded=req.headers['x-forwarded-for'];
    const ip=process.env.RENDER==='true' && typeof forwarded==='string'?forwarded.split(',').at(-1).trim():req.socket.remoteAddress;
    if(req.url!=='/v1' || sockets.size>=limits.total || (byIP.get(ip)||0)>=limits.perIP) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n');return;
    }
    wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,ip));
  });
  wss.on('connection',(ws,ip)=> {
    sockets.add(ws);byIP.set(ip,(byIP.get(ip)||0)+1);
    const peer={ws,id:'',room:null,state:null,rev:0,alive:true,joined:Date.now(),budget:40,refill:Date.now()};
    peers.set(ws,peer);
    ws.on('error',()=>{});ws.on('pong',()=>peer.alive=true);
    ws.on('close',()=> {detach(peer);peers.delete(ws);sockets.delete(ws);const n=(byIP.get(ip)||1)-1;n?byIP.set(ip,n):byIP.delete(ip);});
    ws.on('message',(bytes,binary)=> {
      try {
        const now=Date.now();peer.budget=Math.min(40,peer.budget+(now-peer.refill)/100);peer.refill=now;
        if(binary || --peer.budget<0)return ws.close(1008,'rate limit');
        const m=JSON.parse(bytes.toString());if(!m || typeof m!=='object')throw Error();
        if(m.t==='ping') {if(!Number.isSafeInteger(m.client))throw Error();return send(ws,{t:'pong',client:m.client,server:now});}
        if(m.t==='hello') {
          if(m.v!==1 || !idOK(m.id) || !keyOK(m.room) || !keyOK(m.catalog) || typeof m.token!=='string' ||
             (token && !same(token,m.token)))return ws.close(1008,'invalid hello or access token');
          detach(peer);
          const roomKey=m.catalog+':'+m.room;
          let room=rooms.get(roomKey);
          if(!room){room=new Map();rooms.set(roomKey,room);}
          if(room.has(m.id) || room.size>=limits.room)return ws.close(1008,'duplicate identity or full room');
          peer.id=m.id;peer.room=room;peer.roomKey=roomKey;peer.state=null;
          room.set(peer.id,peer);
          send(ws,{t:'welcome',epoch,server:now});
          // Ordered messages on one socket: reset + individual states + complete.
          send(ws,{t:'reset',epoch});
          for(const p of room.values())if(p!==peer && p.state)send(ws,{t:'state',epoch,rev:p.rev,id:p.id,...p.state});
          send(ws,{t:'snapshotEnd',epoch});return;
        }
        if(!peer.room)return ws.close(1008,'hello required');
        if(m.t==='stop') {
          peer.state=null;publish(peer);return;
        }
        if(m.t==='start') {
          // The relay carries identifiers, not assets. New pack entries must not
          // require a server redeploy; clients resolve identifiers in their pack.
          if(!emoteOK(m.emote) || !Number.isSafeInteger(m.start) || m.start>now+1000 || m.start<now-86400000)throw Error();
          // The connection can only change its own state. IDs are never taken from event bodies.
          // Carry the group's original audio epoch across late joins and leader
          // departures. Body animation retains each dancer's own start time.
          let musicStart=m.start;
          for(const p of peer.room.values())if(p!==peer && p.state?.emote===m.emote)
            musicStart=Math.min(musicStart,p.state.musicStart??p.state.start);
          peer.state={emote:m.emote,start:m.start,musicStart};publish(peer);return;
        }
        throw Error();
      } catch {ws.close(1008,'invalid packet');}
    });
  });
  const heartbeat=setInterval(()=> {
    const now=Date.now();
    for(const ws of sockets){
      if(!peers.get(ws).room && now-peers.get(ws).joined>10000){ws.close(1008,'hello timeout');continue;}
      // Keep the peer metadata private: ping/pong liveness is socket-local.
      if(ws.isAlive===false){ws.terminate();continue;}
      ws.isAlive=false;ws.once('pong',()=>ws.isAlive=true);ws.ping();
    }
  },20000);heartbeat.unref();
  server.on('close',()=>clearInterval(heartbeat));
  return {server,wss,rooms,close:async()=> {clearInterval(heartbeat);for(const ws of sockets)ws.terminate();await new Promise(r=>wss.close(r));if(server.listening)await new Promise(r=>server.close(r));}};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const {server}=createRelay();server.listen(Number(process.env.PORT)||10000,'0.0.0.0',()=>console.log('Emote relay listening; protocol 1'));
}
