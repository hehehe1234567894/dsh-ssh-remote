# deepseek-harness-ssh

DSH（DeepSeek Harness）的 SSH 远程操作插件：让运行在云服务器上的 DSH 通过 SSH 远程操作另一台电脑 —— 执行命令 / 编译、读写文件、上传下载。

**不修改 DSH 主体**：这是一个标准 Cordis bundle，通过 `~/.dsh/profiles/<profile>` 的插件机制加载（与 lark/qqbot/wecom 等通道插件同级）。

## 解决什么问题

- DSH 部署在**云服务器**（有公网 IP，如 `203.195.242.184`）。
- 被操控的电脑是**家用电脑**（无公网 IP）。
- 方案一（默认，已优先实现）：**反向 SSH** —— 家用电脑主动连到云服务器，把本机 sshd 反向映射到云服务器的 `localhost:2222`，DSH 再经 `localhost:2222` 免密回连家用电脑。
- 方案二（备选）：**Tailscale 虚拟局域网** —— 两端都装 Tailscale 后，把插件的 `host/port/user` 指向 Tailscale 分配的 IP 即可，插件无需任何改动。

## 提供的工具（9 个）

| 工具 | 功能 |
|---|---|
| `ssh_ping` | 测试隧道/连接是否可用，返回远程主机名、用户、系统、内核、负载 |
| `ssh_exec` | 在远程执行命令或多行脚本（编译/构建/安装/服务/git 等），支持 `cwd`、`env`、`timeout_seconds`、`shell`（bash/powershell），返回 stdout/stderr/退出码 |
| `ssh_read` | 读远程文件，支持 `offset_bytes`/`limit_bytes` 切片，二进制自动转 base64 |
| `ssh_write` | 写远程文件（自动建父目录，可选 `mode`） |
| `ssh_append` | 追加远程文件 |
| `ssh_list` | 列出远程目录（含隐藏项，long 格式） |
| `ssh_stat` | 远程路径元信息（exists/type/size/mtime/mode/owner） |
| `ssh_upload` | 云服务器本地文件 → 远程（上限 20 MB） |
| `ssh_download` | 远程文件 → 云服务器本地（上限 20 MB） |

传输全链路 base64，无 shell 转义问题；所有 ssh 调用使用密钥认证（`BatchMode=yes`，不会卡在密码交互）。

## 图形界面配置（Web UI，无需改文件）

重启 DSH 后，打开 Web 界面：

**设置 → 插件 → 可配置插件** → 找到 **SSH 远程连接** 卡片，即可在网页上填写/修改连接参数：

| 字段 | 说明 |
|---|---|
| 主机 host | 反向隧道用 `localhost`；直连或 Tailscale 填 IP/域名 |
| 端口 port | 反向隧道端口（默认 `2222`）；直连家用电脑通常 `22` |
| 远程用户名 user | 家用电脑登录用户名（Windows 是 `C:\Users\<名字>` 的名字） |
| 私钥 identityFile | 云端私钥路径，默认 `~/.ssh/dsh_cloud_to_home` |
| 远程 Shell | `bash`（Linux/macOS/WSL）或 `powershell`（Windows） |
| 连接超时 / 主机密钥校验 / known_hosts | 高级选项 |

点 **保存** 后**立即生效**（实时应用，无需重启），`ssh_*` 工具的目标随之更新。

实现说明（与 skillhub 插件同款、经过验证的架构）：
- host 端登记 settings 命名空间（`deepseek-harness-ssh`），"可配置"页据此分发本插件的卡片；
- 卡片读写走插件自己的同源 HTTP 端点 `POST /ssh-remote`（`{method:'config', save?}`）；
- 保存值持久化到 `~/.dsh/ssh-remote.config.json`，叠加在 `cordis.patch.yml` 组合值之上；
- 工具每次调用读取合并后的活配置，因此保存即生效。

## 部署步骤（云服务器侧，已完成）

1. 插件源码：`/home/ubuntu/DSHBuild/ssh-remote/`（`lib/index.js` + `lib/runner.js`）。
2. 已打包安装到 `~/.dsh/profiles/web/`：
   - 归档：`~/.local/share/dsh-plugin-archives/deepseek-harness-ssh-1.0.0.tgz`
   - `~/.dsh/profiles/web/package.json`：`dependencies` 与 `dsh.profile.bundles` 均加入 `deepseek-harness-ssh`
   - `pnpm install` 已完成（node_modules 已含该包）
3. 密钥（已生成在 `/home/ubuntu/.ssh/`）：
   - `dsh_home_to_cloud`（+`.pub`）：家用电脑登录云服务器用（私钥给家用电脑，公钥已在云端 `~/.ssh/authorized_keys`）
   - `dsh_cloud_to_home`（+`.pub`）：云服务器回连家用电脑用（私钥留在云端，公钥需放入家用电脑 `authorized_keys`）
4. 插件配置（`deepseek-harness-ssh` 自带 `cordis.patch.yml`，可用环境变量覆盖）：
   ```yaml
   - insert:
       - id: ssh
         name: deepseek-harness-ssh
         config:
           host: localhost
           port: 2222                     # 反向隧道端口
           user: !!js process.env.DSH_SSH_USER ?? 'home'            # ← 家用电脑用户名
           identityFile: !!js process.env.DSH_SSH_IDENTITY ?? '~/.ssh/dsh_cloud_to_home'
           defaultShell: bash             # Windows 家用机可改为 powershell
   ```

> ⚠️ **生效方式**：配置改动需在 DSH **下次重启**后生效（本次按要求未重启）。重启后本会话工具列表会出现 `ssh_*` 工具。其他用户可把 `DSH_SSH_USER`/`DSH_SSH_IDENTITY` 写入 DSH 的环境或 `.env` 覆盖默认值。

## 家用电脑端配置（拿取 `home-setup` 包执行）

打包好的材料：`/home/ubuntu/DSHBuild/ssh-remote/home-setup-reverse-ssh.tar.gz`
（内含 `dsh_home_to_cloud` 私钥、`dsh_cloud_to_home.pub` 公钥、两个一键脚本）。

**第一步：家用电脑开启 sshd**

- Ubuntu/Debian：`sudo apt install openssh-server && sudo systemctl enable --now ssh`
- Windows 10/11（管理员 PowerShell）：
  ```powershell
  Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
  Start-Service sshd ; Set-Service -Name sshd -StartupType Automatic
  ```
- macOS：系统设置 → 通用 → 共享 → 远程登录。

**第二步：解压并运行脚本**

```bash
tar -xzf home-setup-reverse-ssh.tar.gz && cd home-setup
./setup-reverse-tunnel.sh
# 可自定义：CLOUD_IP=1.2.3.4 CLOUD_USER=ubuntu ./setup-reverse-tunnel.sh
```

Windows（普通 PowerShell，在解压目录）：

```powershell
.\setup-reverse-tunnel.ps1
```

脚本会自动：安装私钥 → 把云端公钥追加到本机 `authorized_keys` → 验证免密 → 后台启动反向隧道（断线自动重连）。建议再按脚本末尾提示配置开机自启（systemd / 计划任务）。

**第三步：验证**

```bash
# 云服务器上（隧道建立后）：
ssh -p 2222 <家用电脑用户名>@localhost -i ~/.ssh/dsh_cloud_to_home 'echo OK && hostname'
```

**记住**：`user` 是家用电脑的用户名（Windows 上是 `C:\Users\<名字>` 的那个名字；Linux 是 `whoami`）。隧道一旦建立，DSH 即可用 `ssh_ping` / `ssh_exec` 等工具远程操作该电脑。

## 常见问题

- **`ssh_ping` 返回 `connection refused`**：隧道未建立。检查家用电脑脚本是否在跑、云服务器 `ss -tlnp | grep 2222` 是否有监听。
- **`permission denied`**：云端 `~/.ssh/dsh_cloud_to_home` 私钥与家用电脑 `authorized_keys` 中的公钥不匹配，或 `~/.ssh`/私钥权限不对（私钥 600、`~/.ssh` 700）。
- **Windows 上命令不生效**：把插件配置 `defaultShell` 改为 `powershell`，或在 `ssh_exec` 里传 `shell: "powershell"`。
- **隧道经常断**：确认家用端使用了 `ServerAliveInterval=30`（脚本已内置），并配置了开机自启。
- **云服务器防火墙**：家用电脑是**出站**连接云服务器 22 端口，因此只需云服务器 22 端口公网可达（腾讯云安全组放行 22）。

## 反向 SSH 失败时的备选方案（Tailscale）

1. 家用电脑和云服务器都安装 Tailscale 并登录同一账号（`tailscale up`）。
2. 云服务器上 `tailscale status` 查看家用电脑的 100.x.x.x IP。
3. 把插件配置改为 `host: <家用电脑的Tailscale IP> port: 22`（其余不变），重启 DSH 生效。

## 本地自测

```bash
cd /home/ubuntu/DSHBuild/ssh-remote && node scripts/selftest.js
```

自测通过 `localhost:22` 直连本机，验证全部 9 个工具（含中文内容、二进制往返、字节切片、缺失文件、退出码传播）。
