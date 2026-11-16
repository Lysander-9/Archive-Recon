/** Test-only Electron request events; no sockets, credentials are synthetic. */
import { EventEmitter } from "node:events";
export const stats={answers:0,requests:0,aborts:0};
let scenario="matched";
export function reset(value:string){scenario=value;stats.answers=0;stats.requests=0;stats.aborts=0;}
export const session={fromPartition:()=>({setProxy:async()=>{},resolveProxy:async()=>"PROXY proxy.invalid:8080",clearCache:async()=>{},closeAllConnections:async()=>{}})};
export const net={request:()=>{
  stats.requests++;
  const req:any=new EventEmitter();req.abort=()=>{stats.aborts++;};
  req.end=()=>queueMicrotask(()=>{
    const ask=(host:string)=>req.emit("login",{isProxy:true,host,port:8080},(...args:unknown[])=>{if(args.length===2)stats.answers++;});
    if(scenario==="matched"){ask("proxy.invalid");ask("proxy.invalid");ask("proxy.invalid");}
    else if(scenario==="mismatched"){ask("other-proxy.invalid");req.emit("error",new Error("net::ERR_TOO_MANY_RETRIES"));}
    else if(scenario==="missing"){ask("proxy.invalid");req.emit("error",new Error("net::ERR_TOO_MANY_RETRIES"));}
    else if(scenario==="cancel"){ask("proxy.invalid");}
    else req.emit("error",new Error("net::ERR_TOO_MANY_RETRIES"));
  });return req;
}};
