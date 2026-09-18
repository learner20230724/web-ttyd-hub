const {test}=require('node:test');
const assert=require('node:assert/strict');
const mod=import('../frontend/src/utils/terminal-tables.mjs');
test('Chinese box tables and colored output render as cells without losing surrounding output',async()=>{
 const {terminalSegments,tableMarkdown}=await mod;
 const text='前文\n┌──────┬──────┐\n│ 项目 │ 状态 │\n├──────┼──────┤\n│ 字号 │ 完成 │\n└──────┴──────┘\n后文';
 const segments=terminalSegments(text);assert.equal(segments[0].text,'前文');assert.deepEqual(segments[1].rows,[['项目','状态'],['字号','完成']]);assert.equal(segments[2].text,'后文');
 assert.match(tableMarkdown('```text\n'+text.slice(3,-3)+'\n```'),/<table>/);
 assert.deepEqual(terminalSegments(text.replace('│ 字号','\x1b[32m│ 字号'))[1].rows,segments[1].rows);
});
test('Incomplete tables remain text and table cells escape HTML',async()=>{
 const {terminalSegments,tableMarkdown}=await mod;
 assert.equal(terminalSegments('┌───┬───┐\n│ a │ b │')[0].type,'text');
 assert.match(tableMarkdown('+---+---+\n| a | b |\n+---+---+\n| <img> | & |\n+---+---+'),/&lt;img&gt;/);
 assert.equal(tableMarkdown('```js\nconst a = 1\n```'),'```js\nconst a = 1\n```');
});
