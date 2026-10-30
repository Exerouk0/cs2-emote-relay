import http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
const catalog=JSON.parse(readFileSync(new URL('./catalog.json',import.meta.url),'utf8'));

const idOK = x => typeof x === 'string' && /^[0-9]{15,20}$/.test(x);
const keyOK = x => typeof x === 'string' && /^[A-Za-z0-9_.:-]{1,96}$/.test(x);
const emoteOK = x => typeof x === 'string' && /^[A-Za-z0-9_]{1,100}$/.test(x);
const poseOK=x=>x && Array.isArray(x.p) && x.p.length===3 && x.p.every(v=>Number.isFinite(v)&&Math.abs(v)<1000000) && Number.isFinite(x.yaw) && Math.abs(x.yaw)<1000000;
const groupOK=g=>g && keyOK(g.id) && poseOK(g.frame) && Array.isArray(g.slots) && g.slots.length<=8 && g.slots.every(s=>poseOK(s)&&keyOK(s.asset));
const worldSlot=(frame,slot)=>{const a=frame.yaw*Math.PI/180,c=Math.cos(a),s=Math.sin(a);return {p:[frame.p[0]+c*slot.p[0]-s*slot.p[1],frame.p[1]+s*slot.p[0]+c*slot.p[1],frame.p[2]+slot.p[2]],yaw:frame.yaw+slot.yaw};};
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
    res.end(JSON.stringify({ok:true,protocol:1,groupProtocol:2,catalog:catalog.id,epoch,connections:sockets.size,rooms:rooms.size}));
  });
  const wss=new WebSocketServer({noServer:true,maxPayload:4096,perMessageDeflate:false});
  function send(ws,data) {
    if(ws.readyState!==WebSocket.OPEN)return;
    if(ws.bufferedAmount>65536)return ws.close(1013,'slow receiver');
    ws.send(JSON.stringify(data));
  }
  function broadcast(room,data) {for(const peer of room.values())send(peer.ws,data);}
  function publish(peer,cancelledEmote='') {
    peer.rev=++revision;
    broadcast(peer.room,{t:'state',epoch,rev:peer.rev,id:peer.id,...peer.state,...(cancelledEmote?{cancelledEmote}:{})});
  }
  function stopGroup(peer) {
    const leader=peer.state?.leader||peer.id;
    for(const p of peer.room?.values()||[])if(p.id===leader || p.state?.leader===leader) {
      const emote=p.state?.emote;p.state=null;publish(p,emote);
    }
  }
  function clearFollowers(peer) {
    for(const p of peer.room?.values()||[])if(p.state?.leader===peer.id) {const emote=p.state.emote;p.state=null;publish(p,emote);}
  }
  function detach(peer) {
    if(!peer.room || peer.room.get(peer.id)!==peer)return;
    const room=peer.room;room.delete(peer.id);
    clearFollowers({...peer,room});
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
          peer.strictGroups=m.catalog==='fnemotes-group-v2';
          room.set(peer.id,peer);
          send(ws,{t:'welcome',epoch,server:now,groupProtocol:2});
          // Ordered messages on one socket: reset + individual states + complete.
          send(ws,{t:'reset',epoch});
          for(const p of room.values())if(p!==peer && p.state)send(ws,{t:'state',epoch,rev:p.rev,id:p.id,...p.state});
          send(ws,{t:'snapshotEnd',epoch});return;
        }
        if(!peer.room)return ws.close(1008,'hello required');
        if(m.t==='stop') {
          if(peer.state?.leader && !peer.room.get(peer.state.leader)?.state?.traversal)stopGroup(peer);
          else {clearFollowers(peer);peer.state=null;publish(peer);}return;
        }
        if(m.t==='join') {
          if(!idOK(m.leader) || m.leader===peer.id)throw Error();
          const leader=peer.room.get(m.leader);
          if(!leader?.state || leader.state.leader)return send(ws,{t:'joinRejected',reason:'host unavailable'});
          if(peer.strictGroups && (!groupOK(leader.state.group) || m.groupId!==leader.state.group.id))return send(ws,{t:'joinRejected',reason:'pack mismatch or host not ready'});
          const def={...(catalog.emotes.find(d=>d.emote===leader.state.emote)||{}),
            roles:leader.state.roles||0,variants:leader.state.variants||0,traversal:leader.state.traversal===true};
          if(!def || (!def.roles && !def.variants))return send(ws,{t:'joinRejected',reason:'not joinable'});
          const occupied=[...peer.room.values()].filter(p=>p!==peer && p.state?.leader===leader.id);
          const max=def.roles||63;
          const used=new Set(occupied.map(p=>p.state.role));
          let role=1;while(used.has(role))role++;
          if(role>max)return send(ws,{t:'joinRejected',reason:'full'});
          clearFollowers(peer);
          const variants=def.variants||0;
          const available=Array.from({length:variants},(_,i)=>i+1).filter(n=>!occupied.some(p=>p.state.variant===n));
          const colors=available.length?available:Array.from({length:variants},(_,i)=>i+1);
          const variant=colors.length?colors[Math.floor(Math.random()*colors.length)]:0;
          const group=leader.state.group,localSlot=group?.slots?.[role-1];
          if(peer.strictGroups && def.roles && !localSlot)return send(ws,{t:'joinRejected',reason:'missing role asset'});
          const canonical=localSlot?worldSlot(group.frame,localSlot):null;
          peer.state={emote:leader.state.emote,start:leader.state.start,musicStart:leader.state.musicStart,
            leader:leader.id,role,variant,approaching:!def.traversal,duplicates:false,
            ...(group?{groupId:group.id,slot:canonical,slotAsset:localSlot?.asset||'',reservation:randomUUID()}:{} )};publish(peer);return;
        }
        if(m.t==='ready') {
          if(!peer.state?.leader || !peer.state.approaching)return;
          if(peer.strictGroups) {
            if(m.reservation!==peer.state.reservation)return;
            if(!poseOK(m.arrival) || !peer.state.slot || Math.hypot(m.arrival.p[0]-peer.state.slot.p[0],m.arrival.p[1]-peer.state.slot.p[1])>4 || Math.abs(m.arrival.p[2]-peer.state.slot.p[2])>64)
              return send(ws,{t:'joinRejected',reason:'not at reserved slot'});
            peer.state.slot.p=[...m.arrival.p]; // final visible actor origin equals the actual arrival, on every client
          }
          peer.state.approaching=false;publish(peer);return;
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
          const sameSession=peer.state?.emote===m.emote && !peer.state?.leader && Math.abs(peer.state.start-m.start)<50;
          if(!sameSession)clearFollowers(peer);
          const roles=Number.isInteger(m.roles)?Math.max(0,Math.min(8,m.roles)):0;
          const variants=Number.isInteger(m.variants)?Math.max(0,Math.min(8,m.variants)):0;
          let group=groupOK(m.group)?m.group:null;
          const followers=[...peer.room.values()].some(p=>p.state?.leader===peer.id);
          if(followers && sameSession && peer.state?.group)group=peer.state.group; // freeze the reserved frame until the group ends
          peer.state={emote:m.emote,start:m.start,musicStart,duplicates:m.duplicates!==false,
            roles,variants,traversal:m.traversal===true,...(group?{group}:{})};publish(peer);return;
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
