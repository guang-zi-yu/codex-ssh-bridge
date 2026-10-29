'use strict';
const test = require('node:test');const assert = require('node:assert/strict');const Module = require('node:module');
const fs = require('node:fs/promises');const path = require('node:path');const os = require('node:os');
const {Projects} = require('../client/src/projects');
const vscodeMock = {window: {createOutputChannel: () => ({appendLine() {}, dispose() {}}), showWarningMessage: async () => undefined}, FileType:{Directory:2}, Uri:{from:({scheme,authority,path})=>({scheme,authority,path,toString:()=>`${scheme}://${authority}${path}`})},workspace:{fs:{stat:async()=>({type:2})}},commands:{executeCommand:async()=>{}}};
const original = Module._load;
Module._load = function(id, ...args) {if (id === 'vscode') return vscodeMock;return original.call(this, id, ...args);};
let Bridge;try {({Bridge} = require('../client/src/extension'));} finally {Module._load = original;}
async function setup(t) {
 const base = await fs.mkdtemp(path.join(os.tmpdir(), 'bridge-history-'));t.after(() => fs.rm(base, {recursive: true, force: true}));
 const bridge = new Bridge({subscriptions: []});bridge.projects = new Projects(base);
 bridge.root = {path: '/remote/project', uri: 'vscode-remote://ssh-remote+orin/remote/project'};
 const calls = [];let next = 0;
 bridge.server = {ready: true, request: async (method, params) => {calls.push({method, params});
  if (method === 'project/create') return {project: {id: 'p-' + params.metadata['codexSSH.key']}};
  if (method === 'thread/start') return {thread: {id: 'thread-' + (++next)}};
  if (method === 'thread/read') return {thread: {projectId: bridge.project.projectId, cwd: bridge.project.cwd}};
  return {};
 }};
 t.after(async () => {clearTimeout(bridge.saveTimer);await bridge.saving;});
 await bridge.prepareProject(bridge.server);return {bridge, calls};
}
test('reconnection resumes the saved native thread with remote-only options', async t => {
 const {bridge, calls} = await setup(t);await bridge.ensureThread();bridge.add('user', 'remember me');await bridge.save();
 const started = calls.find(c => c.method === 'thread/start').params;
 assert.equal(started.projectId, bridge.project.projectId);assert.equal(started.cwd, bridge.project.cwd);assert.equal(started.ephemeral, false);
 bridge.threadLoaded = false;await bridge.ensureThread();
 const resumed = calls.find(c => c.method === 'thread/resume').params;
 assert.equal(resumed.threadId, bridge.thread);assert.equal(resumed.sandbox, 'read-only');assert.equal(resumed.config['features.shell_tool'], false);
 assert.equal((await bridge.projects.load(bridge.project)).messages[0].text, 'remember me');
});
test('switching projects saves the old thread and restores only the matching project', async t => {
 const {bridge} = await setup(t);await bridge.ensureThread();bridge.add('user', 'first project');await bridge.save();const first = bridge.project;
 bridge.root = {path: '/remote/project', uri: 'vscode-remote://ssh-remote+another/remote/project'};
 await bridge.prepareProject(bridge.server);assert.equal(bridge.thread, null);assert.deepEqual(bridge.messages, []);
 await bridge.ensureThread();bridge.add('user', 'another project');await bridge.save();
 bridge.root.uri = 'vscode-remote://ssh-remote+orin/remote/project';await bridge.prepareProject(bridge.server);
 assert.equal(bridge.project.key, first.key);assert.equal(bridge.thread, 'thread-1');assert.equal(bridge.messages[0].text, 'first project');
});
test('mismatched saved threads cannot be resumed into another SSH project', async t => {
 const {bridge} = await setup(t);bridge.thread = 'unrelated';bridge.server.request = async () => ({thread: {projectId: 'other', cwd: '/other'}});
 await assert.rejects(bridge.ensureThread(), /不属于当前 SSH 项目/);assert.equal(bridge.threadLoaded, false);
});
test('project switching blocks sending until the selection finishes', async t => {
 const {bridge} = await setup(t);let release;const gate = new Promise(resolve => {release = resolve;});let connected = false;
 bridge.connect = async () => {connected = true;};const selecting = bridge.idle(() => gate);
 await bridge.send('must wait');assert.equal(connected, false);release();await selecting;assert.equal(bridge.changing, false);
});

test('chat settings preserve the thread and messages, persist together and reset for a new chat', async t => {
 const {bridge,calls}=await setup(t);await bridge.ensureThread();bridge.add('user','keep this conversation');
 bridge.state.models=[{id:'first',isDefault:true,defaultEffort:'medium',efforts:[{id:'medium'},{id:'high'}]},{id:'second',defaultEffort:'low',efforts:[{id:'low'}]}];
 bridge.connect=async()=>{};
 const thread=bridge.thread;
 await bridge.changeSettings({model:'first',effort:'high',permission:'read-only'});
 assert.equal(bridge.thread,thread);assert.equal(bridge.messages[0].text,'keep this conversation');
 const snapshot=await bridge.projects.load(bridge.project);
 assert.equal(snapshot.model,'first');assert.equal(snapshot.effort,'high');assert.equal(snapshot.permission,'read-only');
 await assert.rejects(bridge.changeSettings({effort:'ultra'}),/不支持/);
 await bridge.changeSettings({model:'second'});assert.equal(bridge.state.effort,'');
 bridge.worker=async()=>{};await bridge.reset();
 assert.equal(bridge.state.permission,'ask');assert.equal(bridge.state.model,'');assert.equal(bridge.state.effort,'');
 bridge.restore(snapshot);assert.equal(bridge.thread,thread);assert.equal(bridge.state.effort,'high');assert.equal(bridge.state.permission,'read-only');
 assert.equal(calls.filter(c=>c.method==='thread/start').length,1);
});
test('each turn sends the selected model and reasoning effort on the existing thread', async t => {
 const {bridge,calls}=await setup(t);await bridge.ensureThread();const thread=bridge.thread;
 bridge.state.models=[{id:'available',defaultEffort:'medium',efforts:[{id:'medium'},{id:'high'}]}];
 bridge.state.model='available';bridge.state.effort='high';bridge.connect=async()=>{};
 const request=bridge.server.request;bridge.server.request=async(method,params)=>method==='turn/start'?(calls.push({method,params}),{turn:{id:'turn-one'}}):request(method,params);
 await bridge.send('test settings');
 const turn=calls.find(c=>c.method==='turn/start');assert.equal(turn.params.threadId,thread);assert.equal(turn.params.model,'available');assert.equal(turn.params.effort,'high');
 bridge.state.busy=false;
});
test('read-only requests are blocked before reaching the remote helper and full access requires consent', async t => {
 const {bridge}=await setup(t);bridge.state.permission='read-only';
 await assert.rejects(bridge.worker('exec',{command:'echo denied'}),/只读/);
 bridge.connect=async()=>{};bridge.remoteInfo={permissionModes:['read-only','ask','full']};
 await bridge.changeSettings({permission:'full'});assert.equal(bridge.state.permission,'read-only');
 await assert.rejects(bridge.changeSettings({permission:'invented'}),/Invalid permission/);
});

test('matching registered folders are selected automatically, with an explicit no-project override', async t => {
 const {bridge}=await setup(t);
 const mode=new Map();bridge.context.workspaceState={get:key=>mode.get(key),update:async(key,value)=>mode.set(key,value)};
 await bridge.projects.open(bridge.root,{name:'My Remote Project'});
 await bridge.prepareProject(bridge.server);
 assert.equal(bridge.project.unassigned,undefined);assert.equal(bridge.project.displayName,'My Remote Project');
 bridge.connect=async()=>{};
 await bridge.selectProject(null);assert.equal(bridge.project.unassigned,true);
 const records=await bridge.projects.catalog(bridge.project.authority);
 const named=records.find(p=>!p.unassigned);
 await bridge.selectProject(named.key);assert.equal(bridge.project.key,named.key);
});
test('opening history from another folder opens its SSH URI and keeps the current chat intact', async t => {
 const {bridge}=await setup(t);await bridge.ensureThread();bridge.add('user','current chat');await bridge.save();
 const currentThread=bridge.thread;
 const root={path:'/remote/other',uri:'vscode-remote://ssh-remote+orin/remote/other'};
 const target=await bridge.projects.open(root,{name:'Other Project'});await bridge.projects.register(bridge.server,target);
 await bridge.projects.save(target,{threadId:'other-thread',root,messages:[{id:'old',role:'user',text:'other chat'}]});
 const request=bridge.server.request;
 bridge.server.request=async(method,params)=>method==='thread/read'&&params.threadId==='other-thread'?{thread:{projectId:target.projectId}}:method==='thread/items/list'?{data:[]}:request(method,params);
 bridge.connect=async()=>{};
 const opened=[];vscodeMock.commands.executeCommand=async(...args)=>opened.push(args);
 await bridge.openHistory(target.key,'other-thread');
 assert.equal(bridge.thread,currentThread);assert.equal(bridge.messages[0].text,'current chat');
 assert.equal(opened.length,1);assert.equal(opened[0][0],'vscode.openFolder');assert.equal(opened[0][1].authority,'ssh-remote+orin');assert.equal(opened[0][1].path,root.path);assert.equal(opened[0][2].forceNewWindow,true);
 const intent=await bridge.projects.takeHandoff('ssh-remote+orin',root.path);assert.equal(intent.threadId,'other-thread');
});
test('missing remote project folders are rejected before a new window is opened', async t => {
 const {bridge}=await setup(t);let opened=false;
 vscodeMock.commands.executeCommand=async()=>{opened=true;};vscodeMock.workspace.fs.stat=async()=>{throw Error('FileNotFound');};
 try {await assert.rejects(bridge.navigateProject(bridge.project),/FileNotFound/);assert.equal(opened,false);}
 finally {vscodeMock.workspace.fs.stat=async()=>({type:2});}
});

test('a new SSH window consumes the chosen thread handoff and restores native history', async t => {
 const {bridge}=await setup(t);
 const root={path:'/remote/new-window',uri:'vscode-remote://ssh-remote+orin/remote/new-window'};
 const target=await bridge.projects.open(root,{name:'Opened Project'});await bridge.projects.register(bridge.server,target);
 await bridge.projects.save(target,{threadId:'selected-chat',root,permission:'read-only',messages:[]});
 await bridge.projects.handoff(target,root,'selected-chat');
 const next=new Bridge({subscriptions:[],workspaceState:{get:()=>undefined,update:async()=>{}}});next.projects=bridge.projects;next.root=root;
 const calls=[];next.server={ready:true,request:async(method,params)=>{
  calls.push({method,params});
  if(method==='thread/read')return {thread:{projectId:target.projectId}};
  if(method==='thread/items/list')return {data:[{item:{id:'reply',type:'agentMessage',text:'restored reply'}}]};
  if(method==='project/create')return {project:{id:target.projectId}};
  return {};
 }};
 await next.prepareProject(next.server);
 assert.equal(next.thread,'selected-chat');assert.equal(next.project.key,target.key);assert.equal(next.state.permission,'read-only');assert.equal(next.messages[0].text,'restored reply');
 await next.ensureThread();assert.equal(calls.find(c=>c.method==='thread/resume').params.threadId,'selected-chat');
 assert.equal(await bridge.projects.takeHandoff(target.authority,root.path),null);
 clearTimeout(next.saveTimer);await next.saving;
});
