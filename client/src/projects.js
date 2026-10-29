'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const safeName = value => value.replace(/[^\p{L}\p{N}._ -]/gu, '_').slice(0, 70) || 'workspace';
function identity(root) {
  const uri = new URL(root.uri);
  const authority = decodeURIComponent(uri.host);
  if (uri.protocol !== 'vscode-remote:' || !authority.startsWith('ssh-remote+') || !path.posix.isAbsolute(root.path)) {
    throw new Error('无法确定 SSH 主机和远程工作区，请在 Remote-SSH 窗口重新打开项目。');
  }
  const remotePath = path.posix.normalize(root.path).replace(/\/$/, '') || '/';
  const host = decodeURIComponent(authority.slice('ssh-remote+'.length));
  const key = crypto.createHash('sha256').update(JSON.stringify([authority, remotePath])).digest('hex');
  return {key, authority, remotePath, name: `[SSH] ${host} ${remotePath}`,
    directory: `[SSH] ${safeName(host)} ${safeName(path.posix.basename(remotePath))}-${key.slice(0, 12)}`};
}
function scopeIdentity(root, unassigned = false) {
  const descriptor = identity(root);
  if (!unassigned) return descriptor;
  const host = decodeURIComponent(descriptor.authority.slice('ssh-remote+'.length));
  const key = crypto.createHash('sha256').update(JSON.stringify([descriptor.authority, null])).digest('hex');
  return {...descriptor, key, unassigned: true, name: `[SSH] ${host} · 未归类`, directory: `[SSH] ${safeName(host)} Unassigned-${key.slice(0, 12)}`};
}
async function readJson(filename) {
  try { return JSON.parse(await fs.readFile(filename, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}
async function writeJson(filename, value) {
  const temporary = filename + '.' + crypto.randomUUID() + '.tmp';
  try {
    await fs.writeFile(temporary, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
    await fs.rename(temporary, filename);
  } finally { await fs.rm(temporary, {force: true}); }
}
function sessionPath(project, threadId) {
  if (!/^[a-zA-Z0-9_-]+$/.test(threadId)) throw new Error('Invalid saved thread ID');
  return path.join(project.cwd, 'sessions', threadId + '.json');
}
function messagesFromItems(entries) {
  return entries.flatMap(({item}) => {
    if (item.type === 'userMessage') return [{id: item.id, role: 'user', text: item.content.filter(x => x.type === 'text').map(x => x.text).join('\n')}];
    if (item.type === 'agentMessage') return [{id: item.id, role: 'assistant', text: item.text}];
    if (item.type === 'dynamicToolCall') return [{id: item.id, role: 'tool', text: item.tool + ' · ' + JSON.stringify(item.arguments) + '\n' + (item.contentItems || []).map(x => x.text || '').join('\n')}];
    return [];
  });
}
class Projects {
  constructor(base = path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'ssh-projects')) {
    this.base = base;
    this.pending = Promise.resolve();
  }
  enqueue(operation) {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => {});
    return next;
  }
  async open(root, options = {}) {
    const descriptor = scopeIdentity(root, options.unassigned);
    const cwd = path.join(this.base, descriptor.directory);
    await fs.mkdir(path.join(cwd, 'sessions'), {recursive: true, mode: 0o700});
    const previous = await readJson(path.join(cwd, 'project.json'));
    const displayName = options.name?.trim() || previous?.displayName || path.posix.basename(descriptor.remotePath) || '/';
    const project = {...descriptor, cwd, displayName: descriptor.unassigned ? '不选择项目' : displayName};
    if (!descriptor.unassigned) project.name = `[SSH] ${decodeURIComponent(descriptor.authority.slice('ssh-remote+'.length))} ${displayName}`;
    if (previous?.projectId) project.projectId = previous.projectId;
    await writeJson(path.join(cwd, 'project.json'), project);
    const instructions = `# SSH project\n\nThis local folder stores conversation snapshots and operation records for ${descriptor.name}. The source code remains on the SSH host at ${descriptor.remotePath}.\n\nUse the remote_* tools supplied by Codex SSH Bridge in the matching VS Code Remote-SSH window for every project operation. Local shell commands and local file tools do not operate on the remote source code. If the bridge tools are unavailable, reconnect the matching VS Code window before continuing remote work.\n`;
    await fs.writeFile(path.join(cwd, 'AGENTS.md'), instructions, {mode: 0o600});
    return project;
  }
  async catalog(authority) {
    let folders;
    try { folders = await fs.readdir(this.base, {withFileTypes: true}); }
    catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    const records = [];
    for (const folder of folders.filter(f => f.isDirectory())) {
      const cwd = path.join(this.base, folder.name);
      const record = await readJson(path.join(cwd, 'project.json'));
      if (!record || record.authority !== authority || record.cwd !== cwd) continue;
      const descriptor = scopeIdentity({path: record.remotePath, uri: `vscode-remote://${authority}${record.remotePath}`}, record.unassigned);
      if (descriptor.key !== record.key || descriptor.directory !== folder.name) continue;
      records.push({...record, displayName: record.unassigned ? '不选择项目' : record.displayName || path.posix.basename(record.remotePath) || '/'});
    }
    return records.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
  handoffPath(authority, remotePath) {
    const key = crypto.createHash('sha256').update(JSON.stringify([authority, remotePath])).digest('hex');
    return path.join(this.base, '.open-' + key + '.json');
  }
  async handoff(project, root, threadId) {
    await writeJson(this.handoffPath(project.authority, root.path), {key: project.key, unassigned: !!project.unassigned, threadId, root, createdAt: Date.now()});
  }
  async takeHandoff(authority, remotePath) {
    const filename = this.handoffPath(authority, remotePath);
    const intent = await readJson(filename);
    if (!intent) return null;
    await fs.rm(filename, {force: true});
    return Date.now() - intent.createdAt < 300000 ? intent : null;
  }
  async remoteHistory(server, authority) {
    const rows = [];
    for (const project of await this.catalog(authority)) {
      if (!project.projectId) continue;
      for (const thread of await this.list(server, project)) rows.push({
        id: thread.id, title: thread.name || thread.preview || '未命名对话', updatedAt: thread.updatedAt,
        projectKey: project.key, projectName: project.unassigned ? '未归类' : project.displayName,
      });
    }
    return rows.sort((a, b) => b.updatedAt - a.updatedAt);
  }
  async remove(server, project, threadId) {
    sessionPath(project, threadId);
    const result = await server.request('thread/read', {threadId});
    if (result.thread.projectId !== project.projectId) throw new Error('对话不属于当前远程项目。');
    await server.request('thread/archive', {threadId});
    await this.enqueue(async () => {
      await fs.mkdir(path.join(project.cwd, 'trash'), {recursive: true, mode: 0o700});
      try { await fs.rename(sessionPath(project, threadId), path.join(project.cwd, 'trash', threadId + '.json')); }
      catch (e) { if (e.code !== 'ENOENT') throw e; }
      const current = await this.load(project);
      if (current?.threadId === threadId) await writeJson(path.join(project.cwd, 'current.json'), {...current, threadId: null, messages: [], model: '', effort: '', permission: 'ask'});
    });
  }
  async register(server, project) {
    const candidates = [];
    let cursor = null;
    do {
      const page = await server.request('project/list', {limit: 100, cursor});
      candidates.push(...(page.data || []).filter(p => p.roots?.some(r => r.path === project.cwd)));
      cursor = page.nextCursor;
    } while (cursor);
    // Reuse a project added in the desktop app for this exact local record folder.
    // Desktop-created projects can have empty metadata. Keep the chosen desktop
    // identity stable after adding bridge metadata and when project order changes.
    const desktop = candidates.find(p => p.metadata?.['codex.localProjectId'])
      || candidates.find(p => p.metadata?.['codexSSH.desktopProject'] === 'true')
      || candidates.find(p => !p.metadata?.['codexSSH.key']);
    const existing = desktop || candidates.find(p => p.metadata?.['codexSSH.key'] === project.key) || candidates[0];
    const metadata = {...existing?.metadata, 'codexSSH.key': project.key, 'codexSSH.authority': project.authority, 'codexSSH.remotePath': project.remotePath,
      ...(desktop ? {'codexSSH.desktopProject': 'true'} : {})};
    const result = existing
      ? await server.request('project/update', {projectId: existing.id, name: project.name, metadata})
      : await server.request('project/create', {idempotencyKey: 'codex-ssh-bridge:' + project.key, name: project.name, roots: [{path: project.cwd}], metadata});
    if (!result.project?.id) throw new Error('Codex 未返回项目标识。');
    project.projectId = result.project.id;
    for (const previous of candidates.filter(p => p.id !== project.projectId && p.metadata?.['codexSSH.key'] === project.key)) {
      for (const archived of [false, true]) {
        let cursor = null;
        const threads = [];
        do {
          const page = await server.request('thread/list', {projectId: previous.id, archived, cursor, limit: 100, modelProviders: []});
          threads.push(...(page.data || []));
          cursor = page.nextCursor;
        } while (cursor);
        for (const thread of threads) await server.request('thread/metadata/update', {threadId: thread.id, projectId: project.projectId});
      }
    }
    await writeJson(path.join(project.cwd, 'project.json'), project);
    return project;
  }
  async load(project, threadId) {
    const snapshot = await readJson(threadId ? sessionPath(project, threadId) : path.join(project.cwd, 'current.json'));
    if (!snapshot) return null;
    if (snapshot.key !== project.key || (snapshot.threadId && !/^[a-zA-Z0-9_-]+$/.test(snapshot.threadId))) {
      throw new Error('保存的对话与当前 SSH 项目不匹配。');
    }
    return snapshot;
  }
  save(project, snapshot) {
    const saved = JSON.parse(JSON.stringify({...snapshot, key: project.key, updatedAt: new Date().toISOString()}));
    return this.enqueue(async () => {
      if (saved.threadId) await writeJson(sessionPath(project, saved.threadId), saved);
      await writeJson(path.join(project.cwd, 'current.json'), saved);
    });
  }
  record(project, event) {
    const line = JSON.stringify({time: new Date().toISOString(), projectId: project.projectId, ...event}) + '\n';
    return this.enqueue(() => fs.appendFile(path.join(project.cwd, 'operations.jsonl'), line, {mode: 0o600}));
  }
  async list(server, project) {
    const threads = [];
    let cursor = null;
    do {
      const result = await server.request('thread/list', {projectId: project.projectId, limit: 100, cursor, archived: false, sortKey: 'updated_at', modelProviders: []});
      threads.push(...(result.data || [])); cursor = result.nextCursor;
    } while (cursor);
    return threads;
  }
  async readMessages(server, threadId) {
    // The panel shows recent items; Codex retains the complete rollout on disk.
    const result = await server.request('thread/items/list', {threadId, limit: 100, sortDirection: 'desc'});
    return messagesFromItems([...result.data].reverse());
  }
}
module.exports = {Projects, identity, scopeIdentity, messagesFromItems};
