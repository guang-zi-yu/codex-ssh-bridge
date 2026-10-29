# Codex SSH Bridge Remote

Codex SSH Bridge 的远程助手，安装到 VS Code Remote-SSH 主机。在远程工作区执行文件操作和经确认的 shell 命令，通过 VS Code 命令通道返回结果。

配合本地 `Codex SSH Bridge` 使用。远程主机不需要安装 Codex、保存 Codex 凭据或访问模型服务。助手需要已信任的远程工作区，本地工作区调用会被拒绝。

修改文件前展示差异并请求确认，执行命令前单独确认。文件工具限制在选定工作区，shell 命令以远程用户身份执行。诊断功能只操作自动创建的远程临时目录。
