'use strict';
const svg = content => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${content}</svg>`;
const icons = {
 chevron: svg('<path d="m8 10 4 4 4-4"/>'),
 history: svg('<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6M12 7v5l3 2"/>'),
 settings: svg('<path d="m9 3-.5 2-2 1-2-.5-2 3 1.5 1.5v3L2.5 15l2 3 2-.5 2 1 .5 2h6l.5-2 2-1 2 .5 2-3-1.5-1.5v-3L21.5 9l-2-3-2 .5-2-1L15 3z"/><circle cx="12" cy="12" r="3"/>'),
 newChat: svg('<path d="M13 4H5a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2h13a2 2 0 0 0 2-2v-8M15 3l6 6M10 14l1-5 8-8 4 4-8 8z"/>'),
 external: svg('<path d="M14 3h7v7M21 3 10 14M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>'),
 trash: svg('<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7"/>'),
 back: svg('<path d="m14 6-6 6 6 6"/>'),
 folder: svg('<path d="M3 7V4h7l2 3h9v13H3z"/>'),
 plus: svg('<path d="M12 5v14M5 12h14"/>'),
};
function shellMarkup() {
 return `<header class="chat-header">
  <button id="root" class="project-picker" aria-label="选择项目" aria-haspopup="menu" aria-controls="project-menu" aria-expanded="false"><span id="project-name">不选择项目</span>${icons.chevron}</button>
  <nav class="header-actions" aria-label="对话操作">
   <button id="history" class="header-icon" title="历史对话" aria-label="历史对话" aria-pressed="false">${icons.history}</button>
   <button id="preferences" class="header-icon" title="设置" aria-label="设置" aria-haspopup="menu" aria-controls="preferences-menu" aria-expanded="false">${icons.settings}</button>
   <button id="reset" class="header-icon" title="新对话" aria-label="新对话">${icons.newChat}</button>
  </nav>
  <div id="project-menu" class="header-popover" role="menu" aria-label="选择项目" hidden>
   <div id="project-options"></div>
   <div class="popover-divider"></div>
   <button id="create-project" role="menuitem">${icons.plus}<span>创建项目…</span></button>
   <button id="open-project" role="menuitem">${icons.folder}<span>打开远程目录…</span></button>
  </div>
  <div id="preferences-menu" class="header-popover preferences-menu" role="menu" aria-label="设置" hidden>
   <div class="settings-status"><span>本地 Codex</span><span id="local-status">未连接</span></div>
   <div class="settings-status"><span>远程助手</span><span id="remote-status">未连接</span></div>
   <div class="popover-divider"></div>
   <button id="connect" role="menuitem">连接</button>
   <button id="install" role="menuitem">安装远程助手</button>
   <button id="login" role="menuitem">本地登录</button>
   <button id="update-extension" role="menuitem" disabled title="插件更新功能尚未接入">安装更新<span class="menu-suffix">即将支持</span></button>
   <div class="popover-divider"></div>
   <button id="project" role="menuitem">在 Codex 中打开当前项目</button>
  </div>
 </header>
 <section id="history-view" class="history-view" aria-label="当前远程的历史对话" hidden>
  <div class="history-toolbar"><button id="history-back" class="header-icon" aria-label="返回当前对话" title="返回当前对话">${icons.back}</button><span>历史对话</span><span id="history-status" role="status"></span></div>
  <label class="sr-only" for="history-search">搜索历史对话</label><input id="history-search" type="search" placeholder="搜索对话" autocomplete="off">
  <div id="history-list"></div><p id="history-empty" hidden>当前远程还没有历史对话</p>
 </section>
 <template id="history-actions"><button class="history-open-codex header-icon" title="在 Codex 中打开" aria-label="在 Codex 中打开">${icons.external}</button><button class="history-delete header-icon" title="删除对话（可恢复）" aria-label="删除对话（可恢复）">${icons.trash}</button></template>`;
}
module.exports = {shellMarkup};
