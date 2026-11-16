import assert from "node:assert/strict";
import test from "node:test";
import {getEventListeners} from "node:events";
import {createElectronSessions} from "../../src/main/sessions";
import {fetchText} from "../../src/main/adapters/http";
import {AppError} from "../../src/application/errors";
import {reset,stats} from "./electron-boundary";

for(const scenario of ["matched","missing","mismatched","no-challenge","cancel"]){
  test(`request authentication boundary: ${scenario}`,async()=>{
    reset(scenario);const factory=createElectronSessions();
    const session=await factory.create(1,{mode:"fixed",server:scenario==="missing"?"http://proxy.invalid:8080":"http://audit:AUTH_SYNTHETIC_SECRET@proxy.invalid:8080"});
    const parent=new AbortController();
    const timer=scenario==="cancel"?setTimeout(()=>parent.abort(),10):undefined;
    let failure:AppError|undefined;
    try{await fetchText(session.transport,"https://index.commoncrawl.org/fixture",{transport:session.transport,signal:parent.signal,timeoutMs:1000});}
    catch(error){assert.ok(error instanceof AppError);failure=error;}
    finally{clearTimeout(timer);await factory.close(1);}
    assert.ok(failure);assert.equal(stats.requests,1);
    assert.ok(!JSON.stringify({message:failure.message,dto:failure.toDto(),proxy:session.proxy}).includes("AUTH_SYNTHETIC_SECRET"));
    assert.equal(getEventListeners(parent.signal,"abort").length,0);
    if(scenario==="matched"){
      assert.equal(stats.answers,2);assert.equal(stats.aborts,1);
      assert.equal(failure.code,"PROXY");assert.equal(failure.context?.httpStatus,407);
    }else if(scenario==="missing"){
      assert.equal(stats.answers,0);assert.equal(failure.code,"PROXY");
      assert.match(failure.message,/要求认证/);assert.equal(failure.context?.httpStatus,407);
    }else if(scenario==="cancel"){
      assert.equal(failure.code,"CLOSED");assert.equal(stats.aborts,1);
    }else{
      assert.equal(stats.answers,0);assert.equal(failure.code,"NETWORK");
      assert.equal(failure.context?.kind,"network");assert.ok(!failure.message.includes("密码错误"));
    }
  });
}
