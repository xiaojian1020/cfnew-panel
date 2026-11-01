import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { parseCandidates,chooseFast,numberOption,measureDownload } from '../scripts/auto-preferred-speed.mjs';
test('strict candidates reject malformed output and private/plain endpoints',()=>{
 assert.throws(()=>parseCandidates('bad'));
 assert.equal(parseCandidates('10.0.0.1:443#小健优选-DX,104.16.1.1:80#小健优选-LT').length,0);
 assert.equal(parseCandidates('log\n104.16.1.1:443#小健优选-DX')[0].host,'104.16.1.1');
});
test('every round must pass; rank by worst round and deduplicate',()=>{
 const row=(host,speeds)=>({host,port:443,tag:'DX',speeds});
 const picked=chooseFast([row('a',[20,4]),row('b',[10,8]),row('c',[9,9]),row('c',[10,10]),row('x',[NaN,20])],5,2);
 assert.deepEqual(picked.map(r=>r.host),['c','b']);
});
test('invalid settings fail closed',()=>{
 for(const n of ['NaN','Infinity','0','-1']) assert.throws(()=>numberOption(n,5,1,20));
 assert.equal(numberOption(undefined,5,1,20),5);
});
const opts={url:'https://speed.example/file',durationMs:5000,timeoutMs:10000,maxBytes:4000000};
const target={host:'104.16.1.1',port:443};
function mock(status,type,size,error=false){
 return (_url,options,callback)=>{
  assert.equal(options.servername,'speed.example'); assert.equal(options.headers['Accept-Encoding'],'identity');
  options.lookup('speed.example',{},(_err,ip)=>assert.equal(ip,target.host));
  const req=new EventEmitter(); req.destroy=()=>{};
  req.end=()=>queueMicrotask(()=>{
   const res=new EventEmitter(); res.destroy=()=>{}; res.statusCode=status; res.headers={'content-type':type};
   callback(res);
   if(error) res.emit('error',new Error('broken'));
   else if(status===200 && type==='application/octet-stream'){res.emit('data',Buffer.alloc(size));res.emit('end');}
  }); return req;
 };
}
test('binary download computes decimal MB/s and pins address',async()=>{
 let clock=0; const r=await measureDownload(target,opts,mock(200,'application/octet-stream',2000000),()=>clock++*1000);
 assert.equal(r.mbps,2); assert.equal(r.bytes,2000000);
});
test('HTML and redirects cannot become fast results',async()=>{
 for(const [s,t] of [[200,'text/html'],[302,'application/octet-stream']]) await assert.rejects(measureDownload(target,opts,mock(s,t,2000000)));
});
test('short responses and stream errors fail',async()=>{
 await assert.rejects(measureDownload(target,opts,mock(200,'application/octet-stream',100)));
 await assert.rejects(measureDownload(target,opts,mock(200,'application/octet-stream',0,true)));
});
