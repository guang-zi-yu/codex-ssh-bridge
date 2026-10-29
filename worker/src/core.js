'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const MAX_FILE = 1024 * 1024;
const hash = text => crypto.createHash('sha256').update(text).digest('hex');
function inside(root, file) { return file === root || (!path.relative(root, file).startsWith('..' + path.sep) && path.relative(root, file) !== '..' && !path.isAbsolute(path.relative(root, file))); }
async function safePath(root, input = '.', allowMissing = false) {
  if (typeof input !== 'string' || input.includes('\0')) throw new Error('Invalid path');
  const base = await fs.realpath(root);
  const full = path.resolve(base, input);
  if (!inside(base, full)) throw new Error('Path is outside the selected workspace');
  let ancestor = full;
  for (;;) {
    try {
      const real = await fs.realpath(ancestor);
      if (!inside(base, real)) throw new Error('Symbolic link escapes the workspace');
      return path.join(real, path.relative(ancestor, full));
    } catch (e) {
      if (e.code !== 'ENOENT' || !allowMissing || ancestor === base) throw e;
      // A dangling symlink must not be treated as an absent file.
      try { if ((await fs.lstat(ancestor)).isSymbolicLink()) throw new Error('Dangling symbolic link'); } catch (err) { if (err.code !== 'ENOENT') throw err; }
      ancestor = path.dirname(ancestor);
    }
  }
}
async function fullText(root, input) {
  const file = await safePath(root, input);
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > MAX_FILE) throw new Error('Expected a text file of at most 1 MiB');
  const bytes = await fs.readFile(file);
  if (bytes.includes(0)) throw new Error('Binary file is not supported');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { file, text, sha256: hash(bytes) };
}
async function read(root, args) {
  const value = await fullText(root, args.path);
  const lines = value.text.split('\n');
  const start = Number.isInteger(args.start_line) ? Math.max(1, args.start_line) : 1;
  const limit = Number.isInteger(args.line_count) ? Math.max(1, Math.min(500, args.line_count)) : 200;
  let content = lines.slice(start - 1, start - 1 + limit).map((line, i) => `${start + i}: ${line}`).join('\n');
  const truncated = content.length > 64000;
  content = content.slice(0, 64000);
  return { path: args.path, sha256: value.sha256, total_lines: lines.length, start_line: start, content, truncated };
}
async function list(root, args) {
  const dir = await safePath(root, args.path || '.');
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return { entries: entries.sort((a,b) => a.name.localeCompare(b.name)).slice(0,500).map(e => ({ name:e.name, type:e.isDirectory()?'directory':e.isSymbolicLink()?'symlink':'file' })), truncated:entries.length>500 };
}
async function search(root, args) {
  if (typeof args.query !== 'string' || !args.query || args.query.length > 2000) throw new Error('A non-empty literal query is required');
  const start = await safePath(root, args.path || '.');
  const results = []; let files = 0; let truncated = false;
  const ignored = new Set(['.git','node_modules','.venv','venv','build','install','log','dist','.cache']);
  const query = args.case_sensitive ? args.query : args.query.toLowerCase();
  async function walk(dir) {
    for (const entry of await fs.readdir(dir, { withFileTypes:true })) {
      if (files >= 5000 || results.length >= 100) { truncated=true; return; }
      if (entry.isSymbolicLink() || ignored.has(entry.name)) continue;
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) { await walk(file); continue; }
      if (!entry.isFile()) continue;
      files++;
      try {
        const v = await fullText(root, file);
        const lines=v.text.split('\n');
        for (let i=0;i<lines.length;i++) {
          if ((args.case_sensitive?lines[i]:lines[i].toLowerCase()).includes(query)) {
            results.push({path:path.relative(await fs.realpath(root),file),line:i+1,text:lines[i].slice(0,600)});
            if(results.length>=100){truncated=true;return;}
          }
        }
      } catch(e) { if (!['EACCES','EPERM','ENOENT'].includes(e.code) && !/text file|Binary|encoded data/.test(e.message)) throw e; }
    }
  }
  if((await fs.stat(start)).isDirectory()) await walk(start); else throw new Error('Search path must be a directory');
  return {results,scanned_files:files,truncated};
}
async function prepareEdit(root, args) {
  if(typeof args.old_text!=='string'||!args.old_text||typeof args.new_text!=='string') throw new Error('old_text must be non-empty and new_text must be a string');
  const current=await fullText(root,args.path);
  if(typeof args.expected_sha256!=='string'||current.sha256!==args.expected_sha256) throw new Error('File changed or SHA-256 missing; read it again before editing');
  const at=current.text.indexOf(args.old_text);
  if(at<0||current.text.indexOf(args.old_text,at+1)>=0) throw new Error('old_text must match exactly once');
  const next=current.text.slice(0,at)+args.new_text+current.text.slice(at+args.old_text.length);
  if(Buffer.byteLength(next)>MAX_FILE) throw new Error('Result exceeds 1 MiB');
  return {path:args.path, file:current.file, before:current.text, after:next, sha256:current.sha256};
}
async function applyEdit(root, args) {
  const p=await prepareEdit(root,args);
  if(p.before===p.after) return {changed:false,sha256:p.sha256};
  const stat=await fs.stat(p.file);
  const temporary=p.file+'.codex-bridge-'+crypto.randomUUID()+'.tmp';
  try {
    await fs.writeFile(temporary,p.after,{flag:'wx',mode:stat.mode});
    if((await fullText(root,args.path)).sha256!==p.sha256) throw new Error('File changed during approval; read it again');
    await fs.rename(temporary,p.file);
  } finally { await fs.unlink(temporary).catch(()=>{}); }
  return {changed:true,path:args.path,sha256:hash(p.after)};
}
async function create(root,args) {
  if(typeof args.content!=='string'||Buffer.byteLength(args.content)>MAX_FILE) throw new Error('Expected text content of at most 1 MiB');
  const file=await safePath(root,args.path,true);
  await fs.mkdir(path.dirname(file),{recursive:true});
  const checked=await safePath(root,args.path,true);
  await fs.writeFile(checked,args.content,{flag:'wx',mode:0o644});
  return {created:true,path:args.path,sha256:hash(args.content)};
}
async function execute(root,args,signal) {
  if(typeof args.command!=='string'||!args.command.trim()||args.command.length>32000) throw new Error('Invalid command');
  const cwd=await safePath(root,args.cwd||'.');
  const timeout=Math.max(1000,Math.min(300000,Number(args.timeout_ms)||120000));
  return new Promise((resolve,reject)=>{
    const proc=spawn(process.env.SHELL||'/bin/bash',['-lc',args.command],{cwd,env:process.env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='',bytes=0,truncated=false,timedOut=false,cancelled=false,killTimer;
    const append=(which,chunk)=>{ const text=chunk.toString('utf8');const room=65536-bytes;if(room>0){const part=text.slice(0,room);bytes+=part.length;if(which==='out')stdout+=part;else stderr+=part;}if(text.length>room)truncated=true; };
    proc.stdout.on('data',c=>append('out',c));proc.stderr.on('data',c=>append('err',c));
    function kill(sig){try{if(process.platform!=='win32'&&proc.pid)process.kill(-proc.pid,sig);else proc.kill(sig);}catch{}}
    function stop(){kill('SIGTERM');killTimer=setTimeout(()=>kill('SIGKILL'),1500);killTimer.unref();}
    const timer=setTimeout(()=>{timedOut=true;stop();},timeout);
    const abort=()=>{cancelled=true;stop();};signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    const cleanup=()=>{clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);};
    proc.on('error',e=>{cleanup();reject(e);});
    proc.on('close',(exitCode,exitSignal)=>{cleanup();resolve({exit_code:exitCode,signal:exitSignal,stdout,stderr,truncated,timed_out:timedOut,cancelled});});
  });
}
module.exports={safePath,fullText,read,list,search,prepareEdit,applyEdit,create,execute,hash};
