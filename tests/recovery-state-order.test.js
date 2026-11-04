const {test}=require('node:test');const assert=require('node:assert/strict');
test('restart retires old epochs and rejects old or malformed revisions',async()=>{
 const {createStateOrder}=await import('../frontend/src/utils/state-order.mjs');const order=createStateOrder();
 assert(order.confirm('a'));assert(!order.accepts({stateEpoch:'a',activityRevision:1},{stateEpoch:'a',activityRevision:2}));
 assert(order.confirm('b'));assert(!order.confirm('a'));assert(!order.accepts({stateEpoch:'a',activityRevision:999}));
 assert(!order.accepts({stateEpoch:'b',activityRevision:NaN}));assert(order.accepts({stateEpoch:'b',activityRevision:0}));
});
