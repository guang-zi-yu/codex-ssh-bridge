'use strict';
const icon = paths => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
const icons = {
 plus: icon('<path d="M12 5v14M5 12h14"/>'),
 shield: icon('<path d="M12 3 4 6v6c0 4 4 7 8 9 4-2 8-5 8-9V6z"/><path d="m9 12 2 2 4-4"/>'),
 bolt: icon('<path d="m13 2-9 12h7l-1 8 10-13h-7z" fill="currentColor" stroke="none"/>'),
 reset: icon('<path d="M3 10a9 9 0 1 1 2 8M3 4v6h6"/>'),
 chevron: icon('<path d="m8 10 4 4 4-4"/>'),
 microphone: icon('<rect x="9" y="3" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M9 22h6"/>'),
 send: icon('<path d="M12 19V5m-6 6 6-6 6 6"/>'),
 stop: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
};
function composerMarkup() {
 return `<footer class="chat-footer">
  <div class="composer">
   <label class="sr-only" for="prompt">任务内容</label>
   <textarea id="prompt" placeholder="和 Codex 一起工作" rows="1" aria-label="任务内容"></textarea>
   <div class="compose-tools">
    <div class="compose-left">
     <button id="more" class="tool-icon" aria-label="添加上下文" aria-haspopup="menu" aria-expanded="false" aria-controls="more-menu" title="添加上下文">${icons.plus}</button>
     <button id="permission" class="permission-picker" aria-label="远程操作权限" aria-haspopup="menu" aria-expanded="false" aria-controls="permission-menu" title="远程操作权限">${icons.shield}<span id="permission-label">逐次批准</span></button>
    </div>
    <div class="compose-right">
     <button id="model" class="model-picker" aria-label="模型与推理强度" aria-haspopup="dialog" aria-expanded="false" aria-controls="model-menu" title="选择模型与推理强度">${icons.bolt}<span id="model-label">默认模型</span><span id="effort-label"></span>${icons.chevron}</button>
     <button id="microphone" class="tool-icon microphone" aria-label="语音输入（暂未开放）" title="语音输入暂未开放" disabled>${icons.microphone}</button>
     <button id="send" class="send-button" aria-label="发送" title="发送（Enter）" disabled>${icons.send}</button>
     <button id="stop" class="send-button" aria-label="停止" title="停止当前任务" hidden>${icons.stop}</button>
    </div>
   </div>
   <div id="more-menu" class="composer-popover more-menu" role="menu" aria-label="添加上下文" hidden>
    <button id="attach" role="menuitem">${icons.plus}<span>选中代码</span></button>
   </div>
   <div id="permission-menu" class="composer-popover permission-menu" role="menu" aria-label="远程操作权限" hidden>
    <div class="popover-heading">当前对话的权限</div>
    <button role="menuitemradio" data-permission="read-only" aria-checked="false"><span class="choice-mark"></span><span><strong>只读</strong><small>查看和搜索文件，不修改或执行命令</small></span></button>
    <button role="menuitemradio" data-permission="ask" aria-checked="true"><span class="choice-mark"></span><span><strong>逐次批准</strong><small>修改文件和执行命令时由你确认</small></span></button>
    <button role="menuitemradio" data-permission="full" aria-checked="false"><span class="choice-mark"></span><span><strong>完全访问</strong><small>本对话的远程修改和命令无需逐次确认</small></span></button>
   </div>
   <div id="model-menu" class="composer-popover model-menu" role="dialog" aria-label="模型与推理强度" hidden>
    <div class="reasoning-header">
     <span class="reasoning-bolt">${icons.bolt}</span>
     <button id="model-entry" class="reasoning-card" aria-expanded="false" aria-controls="model-list" title="选择模型">
      <span id="reasoning-value">中</span>
      <span class="reasoning-model"><span id="reasoning-model-name">默认模型</span>${icons.chevron}</span>
     </button>
     <button id="reset-effort" class="reasoning-reset" aria-label="恢复当前模型的默认推理强度" title="恢复默认推理强度">${icons.reset}</button>
    </div>
    <div class="reasoning-slider" id="reasoning-track">
     <div id="effort-ticks" class="effort-ticks" aria-hidden="true"></div>
     <input id="effort-slider" type="range" min="0" max="0" step="1" value="0" aria-label="推理强度" disabled>
    </div>
    <div id="effort-empty" class="empty-options" hidden>连接后显示当前模型支持的推理强度</div>
    <div id="model-list" class="reasoning-model-list" hidden>
     <div class="popover-heading">选择模型</div><div id="model-options" role="radiogroup" aria-label="可用模型"></div>
     <button id="load-models" class="load-models">连接并获取可用模型</button>
    </div>
   </div>
  </div>
  <div class="footnote"><span id="hint">Enter 发送 · Shift+Enter 换行</span><button id="logs">查看日志</button></div>
 </footer>`;
}
module.exports = {composerMarkup};
