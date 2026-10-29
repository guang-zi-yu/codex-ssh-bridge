'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {Projects, identity, messagesFromItems} = require('../client/src/projects');
const root = (host = 'orin', folder = '/home/nvidia/project') => ({path: folder, uri: `vscode-remote://ssh-remote+${host}${folder}`});
async function store(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-projects-'));
  t.after(() => fs.rm(base, {recursive: true, force: true}));
  return new Projects(base);
}
test('SSH project identity distinguishes hosts and paths and normalizes trailing slashes', () => {
  assert.equal(identity(root()).key, identity(root('orin', '/home/nvidia/project/')).key);
  assert.equal(identity(root()).key, identity({...root(), uri: 'vscode-remote://ssh-remote%2Borin/home/nvidia/project'}).key);
  assert.notEqual(identity(root()).key, identity(root('other')).key);
  assert.notEqual(identity(root()).key, identity(root('orin', '/other/project')).key);
  assert.match(identity(root()).name, /^\[SSH\] orin \/home\/nvidia\/project$/);
  assert.throws(() => identity({path: '/tmp', uri: 'file:///tmp'}), /SSH/);
});
test('project registration is idempotent and passes the native project identity', async t => {
  const projects = await store(t);const project = await projects.open(root());const requests = [];
  const server = {request: async (method, params) => {requests.push({method, params});return method==='project/list'?{data: []}:{project: {id: 'project-1'}};}};
  await projects.register(server, project);await projects.register(server, project);
  const creates=requests.filter(r=>r.method==='project/create');
  assert.equal(creates.length,2);assert.deepEqual(creates[0],creates[1]);
  assert.deepEqual(creates[0].params.roots, [{path: project.cwd}]);assert.equal(project.projectId, 'project-1');
  const metadata = JSON.parse(await fs.readFile(path.join(project.cwd, 'project.json'), 'utf8'));
  assert.equal(metadata.authority, 'ssh-remote+orin');
});
test('history survives a new store, preserves old conversations and remains isolated by project', async t => {
  const projects = await store(t);const a = await projects.open(root());const b = await projects.open(root('second'));
  const first = {threadId: 'thread-1', model: 'available-model', messages: [{role: 'user', text: 'first', id: 'u1'}]};
  const saving = projects.save(a, first);first.messages[0].text = 'mutated after save';await saving;
  await projects.save(a, {threadId: 'thread-2', messages: [{role: 'assistant', text: 'second'}]});
  const reopened = new Projects(projects.base);
  assert.equal((await reopened.load(a)).threadId, 'thread-2');
  assert.equal((await reopened.load(a, 'thread-1')).messages[0].text, 'first');
  assert.equal(await reopened.load(b), null);
  await projects.save(a, {threadId: null, messages: []});
  assert.equal((await reopened.load(a)).threadId, null);
  assert.equal((await reopened.load(a, 'thread-1')).model, 'available-model');
  await assert.rejects(projects.load(a, '../../escape'), /Invalid saved/);
  await fs.writeFile(path.join(b.cwd, 'current.json'), JSON.stringify({key: a.key, threadId: 'thread-1'}));
  await assert.rejects(projects.load(b), /不匹配/);
});
test('operation records retain arguments, results and failures with their project and thread', async t => {
  const projects = await store(t);const project = await projects.open(root());project.projectId = 'p';
  await Promise.all([
    projects.record(project, {operationId: 'op', threadId: 'thread-1', phase: 'started', tool: 'remote_exec', args: {command: 'git status'}}),
    projects.record(project, {operationId: 'op', threadId: 'thread-1', phase: 'completed', result: {stdout: 'clean', exit_code: 0}}),
    projects.record(project, {operationId: 'op2', threadId: 'thread-1', phase: 'failed', error: 'User declined'})
  ]);
  const events = (await fs.readFile(path.join(project.cwd, 'operations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(x => x.phase), ['started', 'completed', 'failed']);
  assert.ok(events.every(x => x.projectId === 'p' && x.threadId === 'thread-1'));
  assert.equal(events[0].args.command, 'git status');assert.equal(events[1].result.exit_code, 0);
});
test('native history loads user messages, replies and tool results without replaying operations', () => {
  const messages = messagesFromItems([
    {item: {id: 'u', type: 'userMessage', content: [{type: 'text', text: 'question'}]}},
    {item: {id: 't', type: 'dynamicToolCall', tool: 'remote_read', arguments: {path: 'README.md'}, contentItems: [{text: 'file data'}]}},
    {item: {id: 'a', type: 'agentMessage', text: 'answer'}}
  ]);
  assert.deepEqual(messages.map(x => x.role), ['user', 'tool', 'assistant']);assert.match(messages[1].text, /file data/);
});

test('desktop project registration reuses its project and moves only this SSH project history', async t => {
  const projects=await store(t);const p=await projects.open(root());const calls=[];
  const server={request:async(method,params)=>{
    calls.push({method,params});
    if(method==='project/list')return {data:[
      {id:'bridge-project',roots:[{path:p.cwd}],metadata:{'codexSSH.key':p.key}},
      {id:'desktop-project',roots:[{path:p.cwd}],metadata:{'codex.localProjectId':'desktop',custom:'preserve'}},
      {id:'unrelated',roots:[{path:'/another'}],metadata:{'codex.localProjectId':'other'}}
    ]};
    if(method==='project/update')return {project:{id:params.projectId}};
    if(method==='thread/list')return {data:params.archived?[]:[{id:'saved-thread'}]};
    return {};
  }};
  await projects.register(server,p);
  assert.equal(p.projectId,'desktop-project');
  assert.equal(calls.find(c=>c.method==='project/update').params.metadata.custom,'preserve');
  assert.deepEqual(calls.filter(c=>c.method==='thread/metadata/update').map(c=>c.params),[{threadId:'saved-thread',projectId:'desktop-project'}]);
  assert.ok(calls.filter(c=>c.method==='thread/list').every(c=>c.params.projectId==='bridge-project'));
});

test('desktop projects with empty metadata are reused and remain preferred after metadata changes', async t => {
 const projects=await store(t);const p=await projects.open(root());let rows=[
  {id:'bridge-only',roots:[{path:p.cwd}],metadata:{'codexSSH.key':p.key}},
  {id:'desktop-empty',roots:[{path:p.cwd}],metadata:{}}
 ];const moved=[];const server={request:async(method,params)=>{
  if(method==='project/list')return {data:rows};
  if(method==='project/update'){const row=rows.find(r=>r.id===params.projectId);row.metadata=params.metadata;return {project:row};}
  if(method==='thread/list')return {data:params.archived?[]:[{id:'existing-chat'}]};
  if(method==='thread/metadata/update'){moved.push(params);return {};}
  throw Error('Unexpected request '+method);
 }};
 await projects.register(server,p);assert.equal(p.projectId,'desktop-empty');
 assert.equal(rows.find(r=>r.id==='desktop-empty').metadata['codexSSH.desktopProject'],'true');
 assert.deepEqual(moved,[{threadId:'existing-chat',projectId:'desktop-empty'}]);
 // Keep the bridge-only project first, as can happen after sidebar reordering.
 await projects.register(server,p);assert.equal(p.projectId,'desktop-empty');
});

test('unassigned chats share a host bucket without mixing different SSH hosts', async t => {
 const projects = await store(t);
 const first = await projects.open(root('orin', '/a'), {unassigned: true});
 const second = await projects.open(root('orin', '/b'), {unassigned: true});
 const other = await projects.open(root('other', '/a'), {unassigned: true});
 assert.equal(first.key, second.key); assert.notEqual(first.key, other.key);
 assert.equal(second.displayName, '不选择项目');
 const named = await projects.open(root('orin', '/a'), {name: 'My Project'});
 assert.notEqual(named.key, first.key);
 assert.equal((await projects.open(root('orin', '/a'))).displayName, 'My Project');
 assert.equal((await projects.catalog('ssh-remote+orin')).length, 2);
});
test('remote history includes all projects on one host and follows all pages', async t => {
 const projects = await store(t);
 const a = await projects.open(root('orin', '/a')); a.projectId = 'a';
 const b = await projects.open(root('orin', '/b'), {unassigned: true}); b.projectId = 'b';
 const other = await projects.open(root('another', '/a')); other.projectId = 'other';
 for (const p of [a,b,other]) await fs.writeFile(path.join(p.cwd, 'project.json'), JSON.stringify(p));
 const requests = [];
 const server = {request: async (method, params) => {
  requests.push(params);
  if (params.projectId === 'a') return params.cursor ? {data:[{id:'older',updatedAt:1,preview:'older'}]} : {data:[{id:'first',updatedAt:2,preview:'first'}], nextCursor:'next'};
  return {data:[{id:'unassigned',updatedAt:3,name:'no project'}]};
 }};
 const rows = await projects.remoteHistory(server, 'ssh-remote+orin');
 assert.deepEqual(rows.map(r => r.id), ['unassigned','first','older']);
 assert.ok(requests.every(r => r.projectId !== 'other' && r.archived === false));
 assert.equal(rows[0].projectName, '未归类');
});
test('deleting a history entry archives only its owned native thread and preserves a recoverable snapshot', async t => {
 const projects = await store(t); const p = await projects.open(root()); p.projectId = 'owned';
 await projects.save(p, {threadId:'keep', messages:[{text:'keep'}]});
 await projects.save(p, {threadId:'remove', messages:[{text:'recover me'}]});
 const calls = []; const server = {request: async (method, params) => {calls.push({method,params}); return method === 'thread/read' ? {thread:{projectId:'owned'}} : {};}};
 await projects.remove(server,p,'remove');
 assert.equal(await projects.load(p,'remove'), null); assert.equal((await projects.load(p)).threadId,null);
 assert.equal((await projects.load(p,'keep')).messages[0].text,'keep');
 assert.equal(JSON.parse(await fs.readFile(path.join(p.cwd,'trash','remove.json'))).messages[0].text,'recover me');
 assert.deepEqual(calls.map(c => c.method), ['thread/read','thread/archive']);
 server.request = async () => ({thread:{projectId:'unrelated'}});
 await assert.rejects(projects.remove(server,p,'keep'), /不属于/);
 assert.ok(await projects.load(p,'keep'));
});
test('window handoff is scoped to the remote host and directory and consumed only once', async t => {
 const projects = await store(t); const p = await projects.open(root());
 await projects.handoff(p, root(), 'chosen-thread');
 assert.equal(await projects.takeHandoff('ssh-remote+other', root().path), null);
 const intent = await projects.takeHandoff(p.authority, root().path);
 assert.equal(intent.key,p.key); assert.equal(intent.threadId,'chosen-thread');
 assert.equal(await projects.takeHandoff(p.authority, root().path),null);
});
