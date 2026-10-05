import test from 'node:test';
import assert from 'node:assert/strict';
import {DashboardResource,type DashboardScope} from '../src/host/dashboard-resource';
import type {Dashboard,StatisticsQuery} from '../shared/types';

function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:Error)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
const snapshot=(id:number):Dashboard=>({status:{system_name:'Fixture',quota_per_unit:100},user:null,logs:{items:[],total:0,page:1,pageSize:15},series:[],stat:null,catalog:{models:[],groupRatio:{},usableGroups:{},autoGroups:[],vendors:[]},tokens:[],warnings:[],days:7,fetchedAt:id});
const scope=(accountKey='account-a',range:StatisticsQuery['range']=7):DashboardScope=>({accountKey,query:{range}});
function fixture(){
  const reads:{query:StatisticsQuery;force:boolean;job:ReturnType<typeof deferred<Dashboard>>}[]=[];
  const resource=new DashboardResource((query,force)=>{const job=deferred<Dashboard>();reads.push({query,force,job});return job.promise;});
  resource.configure(scope());return {resource,reads};
}

test('dashboard consumers share concurrent reads and publish one completed snapshot',async()=>{
  const {resource,reads}=fixture(),states:ReturnType<typeof resource.getState>[]=[];
  const stop=resource.subscribe(()=>states.push(resource.getState()));
  const first=resource.refresh(true);
  assert.strictEqual(resource.refresh(true),first);assert.strictEqual(resource.refresh(),first);
  await Promise.resolve();assert.equal(reads.length,1);assert.equal(reads[0].force,true);
  const value=snapshot(1);reads[0].job.resolve(value);await first;
  assert.deepEqual(states.map(state=>state.loading),[true,false]);assert.strictEqual(resource.getState().dashboard,value);
  stop();
});

test('forced dashboard reads supersede ordinary work and reject its late success or failure',async()=>{
  for(const fail of [false,true]){
    const {resource,reads}=fixture(),ordinary=resource.refresh();await Promise.resolve();
    const forced=resource.refresh(true);assert.strictEqual(resource.refresh(true),forced);await Promise.resolve();
    assert.deepEqual(reads.map(read=>read.force),[false,true]);
    reads[1].job.resolve(snapshot(2));await forced;
    if(fail)reads[0].job.reject(new Error('obsolete'));else reads[0].job.resolve(snapshot(1));
    await ordinary;assert.equal(resource.getState().dashboard?.fetchedAt,2);assert.equal(resource.getState().error,'');
  }
});

test('range and filter changes retain visible data but revoke previous results and pending coalescing',async()=>{
  const {resource,reads}=fixture(),initial=resource.refresh();await Promise.resolve();reads[0].job.resolve(snapshot(1));await initial;
  const old=resource.refresh();await Promise.resolve();
  resource.configure({accountKey:'account-a',query:{range:'24h',models:['fixture-model'],tokenIds:[12]}});
  assert.equal(resource.getState().dashboard?.fetchedAt,1);
  const current=resource.refresh();await Promise.resolve();assert.equal(reads.length,3);assert.deepEqual(reads[2].query,{range:'24h',models:['fixture-model'],tokenIds:[12]});
  reads[1].job.resolve(snapshot(2));await old;assert.equal(resource.getState().dashboard?.fetchedAt,1);assert.equal(resource.getState().loading,true);
  reads[2].job.resolve(snapshot(3));await current;assert.equal(resource.getState().dashboard?.fetchedAt,3);
});

test('account/plugin scope changes and unmount revoke visible data and both success/error completions',async()=>{
  for(const next of [scope('account-b'),scope('account-a:plugin-generation-2'),null])for(const fail of [false,true]){
    const {resource,reads}=fixture(),initial=resource.refresh();await Promise.resolve();reads[0].job.resolve(snapshot(1));await initial;
    const old=resource.refresh();await Promise.resolve();resource.configure(next);
    assert.equal(resource.getState().dashboard,null);assert.equal(resource.getState().loading,false);
    const state=resource.getState();
    if(fail)reads[1].job.reject(new Error('obsolete'));else reads[1].job.resolve(snapshot(2));
    await old;assert.strictEqual(resource.getState(),state);
  }
});

test('revoked reads never start and a failed current refresh retains data and allows retry',async()=>{
  const {resource,reads}=fixture(),revoked=resource.refresh();resource.configure(null);await revoked;assert.equal(reads.length,0);
  resource.configure(scope());const initial=resource.refresh();await Promise.resolve();reads[0].job.resolve(snapshot(1));await initial;
  const failed=resource.refresh();await Promise.resolve();reads[1].job.reject(new Error('fixture failure'));await failed;
  assert.equal(resource.getState().dashboard?.fetchedAt,1);assert.equal(resource.getState().error,'fixture failure');assert.equal(resource.getState().loading,false);
  const retry=resource.refresh();await Promise.resolve();assert.equal(resource.getState().error,'');reads[2].job.resolve(snapshot(3));await retry;assert.equal(resource.getState().dashboard?.fetchedAt,3);
});

test('unchanged dashboard scope and repeated loading notifications keep the store stable',async()=>{
  const {resource,reads}=fixture(),states:ReturnType<typeof resource.getState>[]=[];
  const stop=resource.subscribe(()=>states.push(resource.getState())),state=resource.getState();
  resource.configure(scope());assert.strictEqual(resource.getState(),state);
  const ordinary=resource.refresh();await Promise.resolve();const forced=resource.refresh(true);await Promise.resolve();
  assert.equal(states.length,1,'upgrading an active read does not rebroadcast unchanged loading state');
  reads[0].job.resolve(snapshot(1));reads[1].job.resolve(snapshot(2));await Promise.all([ordinary,forced]);assert.equal(states.length,2);
  stop();
});
