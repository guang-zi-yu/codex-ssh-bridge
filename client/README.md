# Codex SSH Bridge

在 VS Code Remote-SSH 中使用本地 Codex 登录和网络处理远程代码。插件分为本地对话面板和远程助手，复用 VS Code 已建立的连接。远程主机无需安装 Codex 或为模型请求配置代理。

## 安装与使用

1. 在本机安装 Codex CLI，并在本地终端执行 `codex login`。已经登录的本地 CLI 会复用原登录状态。
2. 在 VS Code 中使用“扩展：从 VSIX 安装”安装 `dist/codex-ssh-bridge-1.0.0.vsix`。该插件在本地运行。更新已有安装后，执行“开发人员：重新加载窗口”以载入新代码。
3. 用 Remote-SSH 打开远程项目文件夹。在活动栏打开 Codex SSH，点击“安装远程助手”，将随包提供的助手安装到当前 SSH 主机。若 VS Code 要求重新加载窗口，重新加载后继续。
4. 点击“连接”，检查本地登录和远程主机状态。输入任务并发送。可以附加远程编辑器中选中的代码。

远程助手也单独提供为 `dist/codex-ssh-bridge-remote-1.0.0.vsix`，应安装到 SSH 主机而非只安装在本地。两个包版本应一致。已有官方 Codex 扩展可以继续保留，本插件使用独立的面板和对话。

## 操作方式

读取、列目录和文本搜索直接返回远程结果。修改文件前展示差异，并要求确认；文件读取后的 SHA-256 必须匹配，拒绝覆盖新修改或未保存的编辑。单个文件限制为 1 MiB UTF-8 文本，新建文件不会覆盖已有文件。

每条远程 shell 命令单独确认。命令从选定工作区目录启动，以远程登录用户身份执行，不受文件工具的目录边界约束。默认超时 120 秒，上限 300 秒，输出上限约 64 KiB；停止任务会取消远程助手跟踪的命令进程组。停止不会撤销已经应用的文件修改或已经发生的命令副作用。

默认模型取自当前账户实际可用模型列表的默认项，忽略可能已经失效的本地默认模型配置；也可在面板中明确选择。多目录工作区可通过路径按钮选择目录，切换目录或模型会新建对话。对话暂存在当前窗口内存中，重载窗口后不会自动恢复；用户的本地 Codex 登录仍由 Codex 自行保存和刷新。

## 配置与诊断

唯一配置项为 `codexSSH.codexPath`，默认 `codex`，表示本地 Codex 可执行文件。macOS 还会搜索常用 Homebrew 路径。需要设置时，在本地用户设置中指定路径，不填远程路径。

命令面板提供“Codex SSH: 诊断连接（远程临时目录）”。该命令在远程临时目录检查新建、读取、修改、搜索和命令执行，然后清理该临时目录；同时检查本地 Codex 握手与登录状态，不运行模型任务。结果写入本地插件存储目录的 `diagnostics.json`，并在编辑器打开。普通输出见“Codex SSH Bridge”输出通道。

## 开发与验证

运行 `npm test` 执行文件边界、编辑冲突、命令取消、审批和 JSON-RPC 测试。运行 `npm run package` 生成两个 VSIX，主包内包含远程助手。运行 `node scripts/smoke-model.js` 可执行一次最小模型与工具往返测试，只提供固定测试文件名，会使用账户的模型额度。运行 `node scripts/smoke-codex.js` 检查真实本地 Codex 握手、登录状态及动态工具注册；该检查不消耗模型生成请求。

运行时没有 npm 依赖，远程助手只使用 VS Code Server 自带的 Node.js。打包仅使用 Python 3 标准库。已适配的本地协议版本为 Codex CLI 0.154.0，较旧版本可能不支持本插件使用的动态工具接口。

本地 Codex 使用 stdio JSON-RPC，不监听公网端口。内置 shell 工具关闭，本地线程使用只读沙箱；项目操作通过六个远程工具完成。没有把本地线程的系统权限视为远程命令的沙箱，远程写入和命令确认由远程助手执行。

接口依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[本地登录缓存](https://learn.chatgpt.com/docs/auth#login-caching)、[VS Code 本地与远程扩展通信](https://code.visualstudio.com/api/advanced-topics/remote-extensions#communicating-between-extensions-using-commands)。动态工具是实验性接口，需要随 Codex 版本继续验证。已在 macOS 本地 Codex CLI 0.154.0 与 Ubuntu 22.04 ARM64 Remote-SSH 会话验证本地认证、模型与工具往返，以及远程临时目录的读写、搜索和命令执行。Windows 和 Linux 本地客户端尚未实机验证。此项目提供源码与本地安装包，没有发布到扩展市场。
