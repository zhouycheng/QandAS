import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaults,normalize,save,read,shouldFloat,moved,analysisHeight,settleAnalysis,reorder} from '../src/rules.js';
test('defaults and mode preservation',()=>{let p=defaults();assert.equal(p.layoutMode,'flow');assert.equal(p.analysisDock,'bottom');p.practiceStemPercent=65;p.moduleOrder=reorder(p.moduleOrder,'tools','info');let next=normalize({...p,layoutMode:'custom'});assert.equal(next.practiceStemPercent,65);assert.equal(next.moduleOrder[0],'tools');assert.equal(normalize({practiceStemPercent:NaN}).practiceStemPercent,50);});
test('overflow and directional gesture thresholds',()=>{assert.equal(shouldFloat(501,500),false);assert.equal(shouldFloat(502,500),true);assert.equal(moved(8),false);assert.equal(moved(9),true);for(const dock of ['top','bottom']){const opening=dock==='top'?1:-1;assert.equal(analysisHeight(0,100*opening,dock,350),100);assert.equal(settleAnalysis(72,-opening,dock),0);assert.equal(settleAnalysis(73,-opening,dock),73);assert.equal(settleAnalysis(40,opening,dock),40);}});
test('isolated storage and failed save',()=>{const data=new Map();const storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)};const draft={...defaults(),analysisDock:'top'};save(storage,'a',draft);assert.equal(read(storage,'a').analysisDock,'top');assert.equal(read(storage,'b').analysisDock,'bottom');assert.throws(()=>save({setItem(){throw Error('full')}},'a',draft));assert.equal(draft.analysisDock,'top');});

import {questions} from '../src/data.js';
test('all scenarios have four valid options and substantive content',()=>{for(const q of questions){assert.equal(q.options.length,4);assert(q.correct.every(i=>i>=0&&i<4));assert(q.stem.length>25);assert(q.explanation.length>80);}});

import {canViewAnalysis} from '../src/rules.js';
test('analysis requires immediate feedback and confirmed answer',()=>{
 assert.equal(canViewAnalysis('IMMEDIATE',false),false);
 assert.equal(canViewAnalysis('IMMEDIATE',true),true);
 assert.equal(canViewAnalysis('AFTER_FINISH',true),false);
 assert.equal(canViewAnalysis('AFTER_FINISH',false),false);
});
