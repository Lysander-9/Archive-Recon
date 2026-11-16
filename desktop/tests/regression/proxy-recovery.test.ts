import assert from "node:assert/strict";
import test from "node:test";
import { getEventListeners } from "node:events";
import { AppError, errorFromUnknown } from "../../src/application/errors";
import { JobManager } from "../../src/application/job";
import type { JobDeps } from "../../src/application/ports";
import { EMPTY_FILTER } from "../../src/contracts/types";
import { sanitizePublicText } from "../../src/application/sanitize";
import { fetchText } from "../../src/main/adapters/http";

const secret = "RECOVERY_SYNTHETIC_SECRET";
test("JSON credential values and nested raw causes never leave a public error DTO", () => {
  const dto = new AppError("NETWORK", `fixture {"password":"${secret}"}`, {
    context: { stage: "http", httpStatus: 400, attempts: 2,
      cause: { token: secret }, arbitrary: secret, password: secret,
      bodySnippet: secret, netError: `net::ERR_CONNECTION_RESET password=${secret}` },
  }).toDto();
  assert.ok(!JSON.stringify(dto).includes(secret));
  assert.equal(dto.context?.httpStatus, 400);
  assert.equal(dto.context?.attempts, 2);
  assert.equal(dto.context?.netError, "net::ERR_CONNECTION_RESET");
});

test("unknown errors publish a generic failure instead of arbitrary source text", () => {
  assert.ok(!JSON.stringify(errorFromUnknown(new Error(secret)).toDto()).includes(secret));
  assert.ok(!sanitizePublicText(`{"token":"${secret}"}`).includes(secret));
});

test("the error message itself is safe before it reaches a DTO", () => {
  assert.ok(!new AppError("NETWORK", `password=${secret}`).message.includes(secret));
});

function managerWithDiagnostics(resolveProxy: () => Promise<string>, advice: JobDeps["proxyAdvice"]) {
  const events: unknown[] = [];
  const session = { transport: async () => ({status:200,text:async()=>"[]",json:async()=>[]}),
    proxy: {mode:"direct" as const,display:"直连"}, resolveProxy };
  const deps: JobDeps = {
    clock: () => new Date("2024-01-01T00:00:00Z"),
    sessions: {create:async()=>session,close:async()=>{}},
    wayback: { queryPage: async()=>{throw new AppError("NETWORK","网络读取失败",{context:{kind:"network"}});} },
    commoncrawl: {fetchIndexes:async()=>({metas:[],invalidCount:0}),pageCount:async()=>0,
      queryPage:async()=>({records:[],hasMore:false,parseSkipped:0,reasons:[]})},
    proxyAdvice: advice, emit: event=>events.push(event),
  };
  return {manager:new JobManager(deps),session,events};
}
const request = {target:"example.com",source:"wayback" as const,range:{kind:"all" as const},proxy:{mode:"direct" as const}};
function view(manager:JobManager,id:number) {
  const result=manager.getView({jobId:id,source:"wayback",filter:{...EMPTY_FILTER},sort:{key:null,reverse:false},pageIndex:0,pageSize:50});
  assert.ok(result.ok);return result.value;
}
async function until(check:()=>boolean,timeout=1000) {
  const end=Date.now()+timeout;while(!check()){assert.ok(Date.now()<end,"task did not reach the expected state");await new Promise(r=>setTimeout(r,5));}
}
test("cancelled diagnostic never calls advice after a late proxy resolution",async()=>{
  let resolve!: (value:string)=>void;
  let entered=false, adviceCalls=0;
  const {manager}=managerWithDiagnostics(()=>{entered=true;return new Promise(r=>{resolve=r;});},async()=>{adviceCalls++;return null;});
  const started=await manager.start(request);assert.ok(started.ok);
  await until(()=>entered);manager.cancel({jobId:started.value.jobId,source:"wayback"});
  await until(()=>view(manager,started.value.jobId).terminal);
  resolve("DIRECT");await new Promise(r=>setTimeout(r,5));
  assert.equal(view(manager,started.value.jobId).status,"stopped");
  assert.equal(adviceCalls,0);
});
test("an unresolved advice promise times out without blocking the task terminal",async()=>{
  const {manager}=managerWithDiagnostics(async()=>"DIRECT",()=>new Promise(()=>{}));
  const started=await manager.start(request);assert.ok(started.ok);
  const begun=Date.now();await until(()=>view(manager,started.value.jobId).terminal,1500);
  assert.ok(Date.now()-begun<1200);
  assert.equal(view(manager,started.value.jobId).status,"failed");
});
test("deadline during retry backoff keeps attempts=1 and releases parent listeners",async()=>{
  let calls=0;const parent=new AbortController();const started=Date.now();
  const transport=async()=>{calls++;return {status:503,text:async()=>"gateway",json:async()=>({})};};
  await assert.rejects(fetchText(transport,"https://index.commoncrawl.org/fixture",{
    transport,signal:parent.signal,timeoutMs:20,retryDelaysMs:[750,2000],
  }), (e:AppError)=>e.code==="TIMEOUT"&&e.context?.attempts===1);
  assert.equal(calls,1);assert.ok(Date.now()-started<400);
  assert.equal(getEventListeners(parent.signal,"abort").length,0);
});
