import test from 'node:test';
import assert from 'node:assert/strict';
import {SubscriptionResource} from '../src/host/subscription-resource';
import type {SubscriptionUsageSnapshot} from '../shared/contracts/subscription-usage';

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const snapshot=(fetchedAt:number):SubscriptionUsageSnapshot=>({sourceId:'provider.codex',account:{id:'fixture',label:'Fixture',plan:null},state:'ready',windows:[],fetchedAt});
function fixture(){
  const reads:{force:boolean;job:ReturnType<typeof deferred<SubscriptionUsageSnapshot>>}[]=[];
  const resource=new SubscriptionResource(input=>{const job=deferred<SubscriptionUsageSnapshot>();reads.push({force:!!input.force,job});return job.promise;});
  resource.configure(true);return {resource,reads};
}

test('inactive and revoked subscription reads never reach the bridge',async()=>{
  const {resource,reads}=fixture();
  const revoked=resource.refresh();resource.configure(false);await revoked;
  await resource.refresh(true);assert.equal(reads.length,0);assert.deepEqual(resource.getState(),{snapshot:null,loading:false,error:''});
  resource.configure(true);const current=resource.refresh();await Promise.resolve();assert.equal(reads.length,1);
  reads[0].job.resolve(snapshot(1));await current;assert.equal(resource.getState().snapshot?.fetchedAt,1);
});

test('subscription consumers coalesce reads without duplicate loading notifications',async()=>{
  const {resource,reads}=fixture(),states:ReturnType<typeof resource.getState>[]=[];
  const stop=resource.subscribe(()=>states.push(resource.getState()));
  const first=resource.refresh();assert.strictEqual(resource.refresh(),first);await Promise.resolve();
  const forced=resource.refresh(true);assert.notStrictEqual(forced,first);assert.strictEqual(resource.refresh(true),forced);assert.strictEqual(resource.refresh(),forced);await Promise.resolve();
  assert.deepEqual(reads.map(read=>read.force),[false,true]);assert.equal(states.length,1);
  reads[0].job.resolve(snapshot(1));await first;
  assert.strictEqual(resource.refresh(),forced,'obsolete completion must not clear current pending work');
  reads[1].job.resolve(snapshot(2));await forced;
  assert.deepEqual(states.map(state=>state.loading),[true,false]);assert.equal(resource.getState().snapshot?.fetchedAt,2);stop();
});

test('force requested before dispatch replaces queued ordinary subscription work',async()=>{
  const {resource,reads}=fixture(),ordinary=resource.refresh(),forced=resource.refresh(true);
  await Promise.resolve();assert.deepEqual(reads.map(read=>read.force),[true]);
  reads[0].job.resolve(snapshot(2));await Promise.all([ordinary,forced]);assert.equal(resource.getState().snapshot?.fetchedAt,2);
});

test('forced subscription refresh rejects stale ordinary success and failure',async()=>{
  for(const fail of [false,true]){
    const {resource,reads}=fixture(),ordinary=resource.refresh();await Promise.resolve();
    const forced=resource.refresh(true);await Promise.resolve();reads[1].job.resolve(snapshot(2));await forced;
    const state=resource.getState();
    if(fail)reads[0].job.reject(new Error('obsolete sensitive details'));else reads[0].job.resolve(snapshot(1));
    await ordinary;assert.strictEqual(resource.getState(),state);
  }
});

test('subscription disable and re-enable revoke old success and failure',async()=>{
  for(const fail of [false,true]){
    const {resource,reads}=fixture(),old=resource.refresh();await Promise.resolve();
    resource.configure(false);resource.configure(true);const current=resource.refresh();await Promise.resolve();
    if(fail)reads[0].job.reject(new Error('obsolete'));else reads[0].job.resolve(snapshot(1));await old;
    assert.equal(resource.getState().snapshot,null);assert.equal(resource.getState().loading,true);assert.equal(resource.getState().error,'');
    assert.strictEqual(resource.refresh(),current);reads[1].job.resolve(snapshot(2));await current;assert.equal(resource.getState().snapshot?.fetchedAt,2);
  }
});

test('failed subscription refresh removes old account data, hides raw errors and permits retry',async()=>{
  const {resource,reads}=fixture(),initial=resource.refresh();await Promise.resolve();reads[0].job.resolve(snapshot(1));await initial;
  const failed=resource.refresh(true);await Promise.resolve();reads[1].job.reject(new Error('sensitive raw failure'));await failed;
  assert.equal(resource.getState().snapshot,null);assert.equal(resource.getState().loading,false);assert.match(resource.getState().error,/无法读取 Codex 用量/);assert.doesNotMatch(resource.getState().error,/sensitive/);
  const retry=resource.refresh(true);await Promise.resolve();assert.equal(resource.getState().error,'');reads[2].job.resolve(snapshot(3));await retry;assert.equal(resource.getState().snapshot?.fetchedAt,3);
});
