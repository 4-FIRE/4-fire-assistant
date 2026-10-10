import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Harness,createRegistry} from '@earendil-works/pi-durable';
import {createModels} from '@earendil-works/pi-ai/models';
import {BACKGROUND_CONTEXT as context} from '@earendil-works/chord/context';
import {openApplicationStorage} from '../dist/infrastructure/storage.js';
import {DurableIntentStore} from '../dist/infrastructure/intents.js';
test('actual Durable intent index/aggregate/audit commit is atomic, detached from proxies and survives reopen',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'4fire-intent-store-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 let storage=await openApplicationStorage(directory),harness=await Harness.open(storage.storage,{models:createModels(),registry:createRegistry()},context);await harness.root(context);
 let store=new DurableIntentStore(harness);const value={intentId:'test-intent',ownerId:1,ownerRequestId:'request',preparedBy:1,objectiveRef:'goal',revision:1,operation:{name:'fixture-write',parameters:{exact:1}},operationDigest:'digest',binding:{connectionId:'fixture',epoch:'epoch',accessDigest:'fixture',schemaDigest:'schema'},state:'Proposed',preparationEvidence:[],review:null,attempt:null,observation:null,reconciliation:null};
 const circular={};circular.self=circular;
 await assert.rejects(store.commit(intents=>{intents.push(value);return{result:null,audit:[{ownerId:1,intentId:value.intentId,kind:'prepared',data:circular}]};}));assert.deepEqual(await store.list(),[]);
 await store.commit(intents=>{intents.push(value);return{result:null,audit:[{ownerId:1,intentId:value.intentId,kind:'prepared',data:{fixture:true}}]};});
 const detached=await store.read(value.intentId);structuredClone(detached);detached.operation.parameters.exact=999;assert.equal((await store.read(value.intentId)).operation.parameters.exact,1);
 await store.commit(intents=>{intents[0].attempt={attemptId:'one',startedAt:'now',sourceRef:'tool:fixture'};intents[0].state='DispatchStarted';return{result:null,audit:[{ownerId:1,intentId:value.intentId,kind:'dispatch_started',data:{attempt:'one'}}]};});
 await harness.close(context);await storage.close();storage=await openApplicationStorage(directory);harness=await Harness.open(storage.storage,{models:createModels(),registry:createRegistry()},context);store=new DurableIntentStore(harness);
 try{assert.equal((await store.list())[0].attempt.attemptId,'one');assert.equal((await store.read(value.intentId)).state,'DispatchStarted');}finally{await harness.close(context);await storage.close();}
});
