'use strict';const test=require('node:test');const assert=require('node:assert/strict');const {normalizeModels,chooseModel,modelInfo,chooseEffort}=require('../client/src/models');
test('uses available server default instead of invalid local config',()=>{const models=normalizeModels([{id:'good',model:'supported',displayName:'Available',isDefault:true},{id:'other'}]);assert.equal(chooseModel('',models),'supported');assert.equal(chooseModel('other',models),'other');assert.throws(()=>chooseModel('unavailable',models),/可用列表/);});
test('falls back to first available model and never invents names',()=>{assert.equal(chooseModel('',normalizeModels([{id:'available'}])),'available');assert.equal(chooseModel('',[]),null);});

test('reasoning choices come only from the catalog and use each model default',()=>{
 const models=normalizeModels([{id:'available',isDefault:true,defaultReasoningEffort:'medium',supportedReasoningEfforts:[{reasoningEffort:'medium',description:'Balanced'},{reasoningEffort:'high'}]}]);
 const model=modelInfo('',models);assert.equal(chooseEffort('',model),'medium');assert.equal(chooseEffort('high',model),'high');assert.throws(()=>chooseEffort('max',model),/不支持/);assert.equal(chooseEffort('',undefined),null);
});
