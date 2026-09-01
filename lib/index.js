/**
 * deepseek-harness-ssh — remote control for DeepSeek Harness over SSH.
 *
 * Registers `ssh_*` tools that execute commands (including compiles) and
 * read/write files on a remote machine. The remote host is reached through the
 * system OpenSSH client; the plugin is deliberately agnostic about how the
 * route to the remote machine is built — a public IP, a reverse-SSH tunnel
 * (`ssh -R 2222:localhost:22` from the home PC) or a Tailscale node all work
 * by just pointing host/port/user/identityFile at the right target.
 *
 * Configuration surface (mirrors the proven @cocofhu/skillhub pattern):
 * the Web UI "设置 → 插件 → 可配置" tab dispatches a plugin card keyed by a
 * Host settings namespace, and the card itself reads/writes through this
 * plugin's own same-origin HTTP endpoint (/ssh-remote, registered on the
 * webServer service). Saved values persist to ~/.dsh/ssh-remote.config.json
 * and layer over the composition values from cordis.patch.yml; tools read the
 * merged live config on every call, so saving applies immediately.
 *
 * This plugin does NOT touch DeepSeek Harness core code — it is a standard
 * Cordis bundle loaded through ~/.dsh/profiles/<profile>.
 */

import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import fs from 'node:fs/promises';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { runRemote, shq, psq, trimLine } from './runner.js';

export const name = 'deepseek-harness-ssh';

/** Settings namespace backing the Web UI configuration card dispatch. */
export const NS = 'deepseek-harness-ssh';

export const inject = ['tools'];

export const Config = z.object({
  host: z.string().default('localhost'),
  port: z.number().step(1).min(1).max(65535).default(2222),
  user: z.string().required(),
  identityFile: z.string().default('~/.ssh/dsh_cloud_to_home'),
  connectTimeout: z.number().step(1).min(1).max(120).default(10),
  serverAliveInterval: z.number().step(1).min(0).max(3600).default(15),
  serverAliveCountMax: z.number().step(1).min(0).max(100).default(3),
  strictHostKeyChecking: z.union(['accept-new', 'no', 'yes']).default('accept-new'),
  knownHostsFile: z.string().default('~/.ssh/known_hosts'),
  extraArgs: z.array(z.string()).default([]),
  defaultShell: z.union(['bash', 'powershell']).default('bash'),
  maxOutputChars: z.number().step(1).min(1000).max(10_000_000).default(200_000),
  // 工具未指定 cwd 时的远程起始目录（如 laptop 的 D:\projects）
  defaultCwd: z.string().default(''),
  // 多目标：命名连接列表（第 1 条为默认目标）。每条字段落叠加在顶层默认值上。
  connections: z.array(z.object({
    name: z.string().required(),
    host: z.string().required(),
    port: z.number().step(1).min(1).max(65535).default(22),
    user: z.string().required(),
    identityFile: z.string().default('~/.ssh/dsh_cloud_to_home'),
    defaultShell: z.union(['bash', 'powershell']).default('bash'),
    connectTimeout: z.number().step(1).min(1).max(120).default(15),
    defaultCwd: z.string().default(''),
  })).default([]),
});

const MAX_TRANSFER_BYTES = 20 * 1024 * 1024; // upload/download per-file cap

/* ------------------------------------------------------------------ helpers */

/** JSON renderer shared by every tool (canonical output is JSON). */
function textRender(_args, value) {
  return [{ type: 'text', text: JSON.stringify(value, null, 2) }];
}

/** Truncate a long text at a character budget, flagging the cut. */
function cut(text, max) {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n… [output truncated at ${max} chars]`, truncated: true };
}

/** Parse `KEY=value` tokens (separated by whitespace) into an object; other non-empty lines into `rest`. */
function parseKeyValues(text) {
  const obj = {};
  const rest = [];
  for (const line of text.split('\n')) {
    let matched = false;
    for (const m of line.matchAll(/(?:^|\s)([A-Za-z_][A-Za-z0-9_]*)=(\S+)/g)) {
      obj[m[1]] = m[2];
      matched = true;
    }
    if (!matched && line.trim()) rest.push(line.trim());
  }
  return { obj, rest };
}

/** Normalize `stat` type strings into a small stable set. */
function normalizeType(t) {
  const s = String(t).toLowerCase();
  if (s.includes('directory') || s === 'dir') return 'directory';
  if (s.includes('symbolic link') || s.includes('symlink')) return 'symlink';
  if (s.includes('regular') || s === 'file' || s.includes('file')) return 'file';
  if (s.includes('character')) return 'char-device';
  if (s.includes('block')) return 'block-device';
  if (s.includes('fifo')) return 'fifo';
  if (s.includes('socket')) return 'socket';
  return s || 'unknown';
}

/** Strip cloud-provider login banners (block-art QR codes) from stderr noise. */
function filterBanner(text) {
  return (text ?? '').split('\n').filter((l) => !l.includes('█')).join('\n');
}

/** Report an ssh-level failure (spawn error / refused / auth denied...) uniformly. */
function failure(res, extra = {}) {
  // Prefer a marker our own remote script emitted over unrelated stderr noise
  // (e.g. the cloud provider's login banner).
  const stderrClean = filterBanner(res.stderr);
  const marker = /__DSH_SSH_ERROR__(?:_(\w+))?/.exec(stderrClean);
  const reason = marker
    ? (marker[1] ?? 'REMOTE_ERROR').replace(/_/g, ' ').toLowerCase()
    : res.error
      ? `ssh spawn failed: ${res.error}`
      : stderrClean.split('\n').map((l) => l.trim()).filter(Boolean).slice(-6).join(' | ') || `ssh exited with code ${res.exitCode}`;
  return {
    ok: false,
    error: reason || 'unknown ssh failure',
    exit_code: res.exitCode,
    timed_out: res.timedOut,
    duration_ms: res.durationMs,
    ...extra,
  };
}

/** Human endpoint label for the currently configured target. */
function endpointOf(c) {
  return `${c.user}@${c.host}:${c.port}`;
}

/* ------------------------------------------------------------ script builders */

function execScript(shell, command, cwd, env) {
  const lines = [];
  if (shell === 'powershell') {
    if (cwd) lines.push(`Set-Location -LiteralPath ${psq(cwd)} -ErrorAction Stop`);
    for (const [k, v] of Object.entries(env ?? {})) lines.push(`$env:${k} = ${psq(String(v))}`);
    lines.push(command);
    return lines.join('\n');
  }
  if (cwd) lines.push(`cd -- ${shq(cwd)} || exit 127`);
  for (const [k, v] of Object.entries(env ?? {})) lines.push(`export ${k}=${shq(String(v))}`);
  lines.push(command);
  return lines.join('\n');
}

function readScript(shell, path, offset, limit) {
  if (shell === 'powershell') {
    return [
      `$f = ${psq(path)}`,
      `if (-not (Test-Path -LiteralPath $f)) { Write-Error '__DSH_SSH_ERROR__NO_SUCH_FILE'; exit 1 }`,
      `$bytes = [System.IO.File]::ReadAllBytes($f)`,
      `$size = $bytes.Length`,
      `$off = ${offset}`,
      `$lim = ${limit}`,
      `if ($off -ge $size) { $slice = @() } else { $end = [Math]::Min($off + $lim, $size); $slice = $bytes[$off..($end - 1)] }`,
      `[Console]::Out.Write([Convert]::ToBase64String($slice))`,
      `[Console]::Error.WriteLine("__DSH_SSH_META__ size=$size off=$off got=$($slice.Length)")`,
    ].join('\n');
  }
  return [
    `f=${shq(path)}`,
    `if [ ! -e "$f" ]; then printf '__DSH_SSH_ERROR__%s\\n' NO_SUCH_FILE >&2; exit 1; fi`,
    `size=$(wc -c < "$f" 2>/dev/null || echo 0)`,
    `off=${offset}`,
    `lim=${limit}`,
    `tail -c +$((off + 1)) "$f" 2>/dev/null | head -c "$lim" | base64`,
    `printf '__DSH_SSH_META__ size=%s off=%s got=%s\\n' "$size" "$off" "$(tail -c +$((off + 1)) "$f" 2>/dev/null | head -c "$lim" | wc -c)" >&2`,
  ].join('\n');
}

function writeScript(shell, path, b64, mode, append) {
  if (shell === 'powershell') {
    const mkdir = [
      `$f = ${psq(path)}`,
      `$d = Split-Path -Parent $f`,
      `if ($d -and -not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }`,
    ];
    const write = append
      ? [
          `$bytes = [Convert]::FromBase64String(${psq(b64)})`,
          `$s = [System.IO.File]::Open($f, [System.IO.FileMode]::Append)`,
          `try { $s.Write($bytes, 0, $bytes.Length) } finally { $s.Close() }`,
        ]
      : [`[System.IO.File]::WriteAllBytes($f, [Convert]::FromBase64String(${psq(b64)}))`];
    return [...mkdir, ...write, `'__DSH_SSH_OK__'`].join('\n');
  }
  const mkdir = [
    `f=${shq(path)}`,
    `d=$(dirname -- "$f")`,
    `mkdir -p -- "$d" || exit 1`,
  ];
  const write = append
    ? `printf '%s' '${b64}' | base64 -d >> "$f" || exit 1`
    : `printf '%s' '${b64}' | base64 -d > "$f" || exit 1`;
  const chmod = mode ? `chmod ${shq(mode)} "$f" || exit 1` : null;
  return [...mkdir, write, ...(chmod ? [chmod] : []), `printf '__DSH_SSH_OK__\\n'`].join('\n');
}

function listScript(shell, path) {
  if (shell === 'powershell') {
    return [
      `$p = ${psq(path)}`,
      `if (-not (Test-Path -LiteralPath $p)) { Write-Error '__DSH_SSH_ERROR__NO_SUCH_PATH'; exit 1 }`,
      `Get-ChildItem -Force -LiteralPath $p | Sort-Object Name | Format-Table -AutoSize Mode, LastWriteTime, Length, Name | Out-String -Width 400`,
    ].join('\n');
  }
  return [
    `p=${shq(path)}`,
    `if [ ! -e "$p" ]; then printf '__DSH_SSH_ERROR__%s\\n' NO_SUCH_PATH >&2; exit 1; fi`,
    `ls -la --time-style=long-iso "$p" 2>/dev/null || ls -la "$p"`,
  ].join('\n');
}

function statScript(shell, path) {
  if (shell === 'powershell') {
    return [
      `$f = ${psq(path)}`,
      `if (-not (Test-Path -LiteralPath $f)) { 'type=missing'; exit 0 }`,
      `$i = Get-Item -LiteralPath $f -Force`,
      `if ($i.PSIsContainer) { $t='directory' } elseif ($i.LinkType) { $t='symlink' } else { $t='file' }`,
      `$mtime = [DateTimeOffset]::new($i.LastWriteTime).ToUnixTimeSeconds()`,
      `$owner = $null`,
      `try { $owner = $i.GetAccessControl().GetOwner([System.Security.Principal.NTAccount]).Value } catch {}`,
      `"type=$t size=$($i.Length) mtime=$mtime mode=$($i.Mode) owner=$owner"`,
    ].join('\n');
  }
  return [
    `f=${shq(path)}`,
    `if [ ! -e "$f" ]; then echo 'type=missing'; exit 0; fi`,
    `if stat -c 'type=%F size=%s mtime=%Y mode=%a owner=%U group=%G' "$f" >/dev/null 2>&1; then`,
    `  stat -c 'type=%F size=%s mtime=%Y mode=%a owner=%U group=%G' "$f"`,
    `else`,
    `  stat -f 'type=%HT size=%z mtime=%m mode=%Lp owner=%Su group=%Sg' "$f"`,
    `fi`,
  ].join('\n');
}

function downloadScript(shell, path) {
  if (shell === 'powershell') {
    return [
      `$f = ${psq(path)}`,
      `if (-not (Test-Path -LiteralPath $f)) { Write-Error '__DSH_SSH_ERROR__NO_SUCH_FILE'; exit 1 }`,
      `[Convert]::ToBase64String([System.IO.File]::ReadAllBytes($f))`,
    ].join('\n');
  }
  return [
    `f=${shq(path)}`,
    `if [ ! -e "$f" ]; then printf '__DSH_SSH_ERROR__%s\\n' NO_SUCH_FILE >&2; exit 1; fi`,
    `base64 -w0 < "$f" 2>/dev/null || base64 < "$f"`,
  ].join('\n');
}

/* ------------------------------------------------------------------- tools */

function registerTools(ctx, getConfig) {
  const shellOf = (config, shell) => shell ?? config.defaultShell;

  // 多目标包装：注册的是 defineTool 编译后的工具。给它的参数 schema 注入可选
  // target 字段（选哪台机器），包装 execute 让未知连接名报错，presentCall
  // 标注本次调用实际使用的连接。
  const register = (tool) => {
    tool.parameters.properties = {
      ...tool.parameters.properties,
      target: { type: 'string', description: '连接名（配置卡片里添加的连接名称，如 mkk-98 / laptop）。不填用第 1 条连接。' },
    };
    const userExecute = tool.execute;
    tool.execute = async (args, exec) => {
      resolveTarget(getConfig(), args && args.target); // 未知连接名在此抛出清晰错误
      return userExecute(args, exec);
    };
    if (tool.presentCall) {
      const userPresentCall = tool.presentCall;
      tool.presentCall = (args) => {
        const card = userPresentCall(args);
        if (!card) return card;
        const config = resolveTargetSafe(getConfig(), args && args.target);
        const label = config.name ? `${config.name} (${endpointOf(config)})` : endpointOf(config);
        return { ...card, description: card.description ? `${card.description} · ${label}` : label };
      };
    }
    ctx.tools.register(tool);
  };

  /* --- ssh_ping ------------------------------------------------------- */
  register(defineTool({
    name: 'ssh_ping',
    description:
      'Test the SSH connection to the configured remote host and report basic host info ' +
      '(hostname, user, OS, kernel, uptime). Use this first to verify the tunnel/route is up ' +
      'before other ssh_* calls. The target comes from the plugin settings (Web UI: 设置 → 插件).',
    parameters: {
      timeout_seconds: { type: 'integer', description: 'Connection attempt budget in seconds (default 30).' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    execute: async (args) => {
      const config = resolveTarget(getConfig(), args.target);
      const script =
        shellOf(config, args.shell) === 'powershell'
          ? [
              `'HOST=' + $env:COMPUTERNAME`,
              `'USER=' + $env:USERNAME`,
              `'OS=' + (Get-CimInstance Win32_OperatingSystem -ErrorAction SilentlyContinue).Caption`,
              `'KERNEL=' + [System.Environment]::OSVersion.VersionString`,
            ].join('\n')
          : [
              'echo "HOST=$(hostname 2>/dev/null || echo unknown)"',
              'echo "USER=$(whoami 2>/dev/null || echo unknown)"',
              'echo "SHELL=$SHELL"',
              'uname -srm 2>/dev/null',
              `sed -n 's/^PRETTY_NAME="\\(.*\\)"/OS=\\1/p' /etc/os-release 2>/dev/null`,
              'uptime 2>/dev/null',
            ].join('\n');
      const res = await runRemote(config, { script, shell: shellOf(config, args.shell), timeoutMs: (args.timeout_seconds ?? 30) * 1000 });
      if (!res.ok) return failure(res);
      const { obj, rest } = parseKeyValues(res.stdout);
      return {
        ok: true,
        target: endpointOf(config),
        hostname: obj.HOST ?? null,
        user: obj.USER ?? null,
        shell: obj.SHELL ?? null,
        os: obj.OS ?? null,
        kernel: obj.KERNEL ?? rest[0] ?? null,
        uptime: rest[rest.length - 1] ?? null,
        duration_ms: res.durationMs,
      };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: 'Test SSH connection',
      kind: 'other',
      rawInput: endpointOf(getConfig()),
    }),
  }));

  /* --- ssh_exec ------------------------------------------------------- */
  // ── 纯远程模式（v1.4.0）：远程文件直接读写，云端不留副本 ──
  register(defineTool({
    name: 'ssh_list_dir',
    description:
      'List a directory on the remote host (subdirectories AND files with byte sizes). ' +
      'Use this to explore remote project folders. path defaults to the machine working directory. ' +
      'Prefer this over running ls/dir via ssh_exec.',
    parameters: {
      path: { type: 'string', description: 'Remote directory to list (absolute path preferred).' },
      shell: { type: 'string', enum: ['bash', 'powershell'], description: 'Remote shell dialect; defaults to the plugin default.' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    execute: async (args) => {
      const config = resolveTarget(getConfig(), args.target);
      const shell = shellOf(config, args.shell);
      const dir = String(args.path || config.defaultCwd || '.').trim();
      const script = shell === 'powershell'
        ? [
            '$d = ' + psq(dir),
            "if (-not (Test-Path -LiteralPath $d -PathType Container)) { Write-Output '__LIST_ERR__NO_DIR'; exit 0 }",
            "Write-Output ('__LIST_PATH__' + (Resolve-Path -LiteralPath $d).Path)",
            'Get-ChildItem -LiteralPath $d -Force | ForEach-Object { $t = "F"; if ($_.PSIsContainer) { $t = "D" }; Write-Output ($t + "`t" + $_.Name + "`t" + $_.Length) }',
          ].join('\n')
        : [
            'd=' + shq(dir),
            'if [ ! -d "$d" ]; then echo __LIST_ERR__NO_DIR; exit 0; fi',
            'echo "__LIST_PATH__$(cd "$d" 2>/dev/null && pwd)"',
            'find "$d" -mindepth 1 -maxdepth 1 -print0 2>/dev/null | while IFS= read -r -d "" f; do if [ -d "$f" ]; then t=D; else t=F; fi; s=$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null || echo 0); printf \'%s\\t%s\\t%s\\n\' "$t" "$(basename "$f")" "$s"; done | sort',
          ].join('\n');
      const res = await runRemote(config, { script, shell, timeoutMs: 20000 });
      const lines = String(res.stdout || '').split('\n').map((x) => x.replace(/\r$/, '')).filter(Boolean);
      if (lines[0] === '__LIST_ERR__NO_DIR') {
        return { ok: false, error: `目录不存在: ${dir}`, target: config.name || '' };
      }
      if (!lines[0] || !lines[0].startsWith('__LIST_PATH__')) {
        return { ok: false, error: `远程执行失败 (exit ${res.exitCode})`, stderr: cut(filterBanner(res.stderr), config.maxOutputChars) };
      }
      const entries = lines.slice(1).map((x) => {
        const parts = x.split('\t');
        return { type: parts[0] === 'D' ? 'dir' : 'file', name: parts.slice(1, -1).join('\t') || parts[1], size: Number(parts[parts.length - 1]) || 0 };
      });
      return { ok: true, target: config.name || '', path: lines[0].slice('__LIST_PATH__'.length), entries };
    },
  }));

  register(defineTool({
    name: 'ssh_read_file',
    description:
      'Read a text file from the remote host (UTF-8, up to ~512KB per read). ' +
      'Use this for viewing/editing remote project files. The file NEVER touches local disk.',
    parameters: {
      path: { type: 'string', required: true, description: 'Remote file path to read.' },
      shell: { type: 'string', enum: ['bash', 'powershell'], description: 'Remote shell dialect; defaults to the plugin default.' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    execute: async (args) => {
      const config = resolveTarget(getConfig(), args.target);
      const shell = shellOf(config, args.shell);
      const fp = String(args.path || '').trim();
      if (!fp) return { ok: false, error: '缺少 path' };
      const cap = 512 * 1024;
      const script = shell === 'powershell'
        ? [
            '$p = ' + psq(fp),
            "if (-not (Test-Path -LiteralPath $p -PathType Leaf)) { Write-Output '__RF_ERR__NO_FILE'; exit 0 }",
            '$b = [IO.File]::ReadAllBytes($p)',
            "Write-Output ('__RF_SIZE__' + $b.Length)",
            "Write-Output ('__RF_B64__' + [Convert]::ToBase64String($b))",
          ].join('\n')
        : [
            'p=' + shq(fp),
            'if [ ! -f "$p" ]; then echo __RF_ERR__NO_FILE; exit 0; fi',
            'echo "__RF_SIZE__$(stat -c %s "$p" 2>/dev/null || stat -f %z "$p" 2>/dev/null || echo 0)"',
            'echo "__RF_B64__$(base64 -w0 "$p" 2>/dev/null)"',
          ].join('\n');
      const res = await runRemote(config, { script, shell, timeoutMs: 30000 });
      const lines = String(res.stdout || '').split('\n').map((x) => x.replace(/\r$/, '')).filter(Boolean);
      if (lines[0] === '__RF_ERR__NO_FILE') {
        return { ok: false, error: `文件不存在: ${fp}`, target: config.name || '' };
      }
      const sizeLine = lines.find((x) => x.startsWith('__RF_SIZE__'));
      const b64Line = lines.find((x) => x.startsWith('__RF_B64__'));
      if (!b64Line) {
        return { ok: false, error: `读取失败 (exit ${res.exitCode})`, stderr: cut(filterBanner(res.stderr), config.maxOutputChars) };
      }
      const buf = Buffer.from(b64Line.slice('__RF_B64__'.length), 'base64');
      const truncated = buf.length > cap;
      return {
        ok: true,
        target: config.name || '',
        path: fp,
        size: sizeLine ? Number(sizeLine.slice('__RF_SIZE__'.length)) || buf.length : buf.length,
        truncated,
        content: buf.subarray(0, cap).toString('utf8'),
      };
    },
  }));

  register(defineTool({
    name: 'ssh_write_file',
    description:
      'Create or overwrite a text file DIRECTLY on the remote host (UTF-8). Parent directories are created automatically. ' +
      'Use this for all remote project file writes/edits — the change lands on the remote machine immediately, no local copy involved.',
    parameters: {
      path: { type: 'string', required: true, description: 'Remote file path to write.' },
      content: { type: 'string', required: true, description: 'Full UTF-8 text content to write (overwrites existing file).' },
      append: { type: 'boolean', description: 'Append to the file instead of overwriting (default false).' },
      shell: { type: 'string', enum: ['bash', 'powershell'], description: 'Remote shell dialect; defaults to the plugin default.' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    execute: async (args) => {
      const config = resolveTarget(getConfig(), args.target);
      const shell = shellOf(config, args.shell);
      const fp = String(args.path || '').trim();
      if (!fp) return { ok: false, error: '缺少 path' };
      const b64 = Buffer.from(String(args.content ?? ''), 'utf8').toString('base64');
      const append = args.append === true;
      const script = shell === 'powershell'
        ? [
            '$p = ' + psq(fp),
            '$dir = Split-Path -Parent $p; if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }',
            append
              ? `if (-not (Test-Path -LiteralPath $p)) { [IO.File]::WriteAllBytes($p, [byte[]]@()) }; [IO.File]::AppendAllText($p, [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${b64}')), [Text.Encoding]::UTF8)`
              : `[IO.File]::WriteAllBytes($p, [Convert]::FromBase64String('${b64}'))`,
            'Write-Output "__WF_OK__"',
          ].join('\n')
        : [
            'p=' + shq(fp),
            'mkdir -p -- "$(dirname "$p")"',
            append
              ? `printf %s ${shq(b64)} | base64 -d >> "$p"`
              : `printf %s ${shq(b64)} | base64 -d > "$p"`,
            'echo __WF_OK__',
          ].join('\n');
      const res = await runRemote(config, { script, shell, timeoutMs: 30000 });
      const okOut = String(res.stdout || '').includes('__WF_OK__');
      if (!okOut || !res.ok) {
        return { ok: false, error: `写入失败 (exit ${res.exitCode})`, stderr: cut(filterBanner(res.stderr), config.maxOutputChars) };
      }
      return { ok: true, target: config.name || '', path: fp, bytes: Buffer.byteLength(String(args.content ?? ''), 'utf8'), append };
    },
  }));

  register(defineTool({
    name: 'ssh_exec',
    description:
      'Execute a command (or multi-line script) on the remote host over SSH and return its ' +
      'stdout/stderr/exit code. Use this for running builds/compiles, installs, services, git ' +
      'and any shell work on the remote machine. ' +
      'cwd sets the remote working directory; env sets remote environment variables; ' +
      'shell is bash (Linux/macOS/WSL) or powershell (Windows); timeout_seconds bounds the call.',
    parameters: {
      command: { type: 'string', required: true, description: 'The shell command or multi-line script to run remotely.' },
      cwd: { type: 'string', description: 'Remote working directory the command runs in (absolute path preferred).' },
      env: {
        type: 'object',
        additionalProperties: true,
        description: 'Optional environment variables to set for the command (string values).',
      },
      shell: { type: 'string', enum: ['bash', 'powershell'], description: 'Remote shell dialect; defaults to the plugin default.' },
      timeout_seconds: { type: 'integer', description: 'Kill the command after this many seconds (default 60).' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    execute: async (args) => {
      const config = resolveTarget(getConfig(), args.target);
      const shell = shellOf(config, args.shell);
      const timeoutSec = Math.max(1, Math.min(3600, args.timeout_seconds ?? 60));
      const script = execScript(shell, args.command, args.cwd || config.defaultCwd || null, args.env);
      const res = await runRemote(config, { script, shell, timeoutMs: timeoutSec * 1000 });
      const out = cut(res.stdout, config.maxOutputChars);
      const err = cut(filterBanner(res.stderr), config.maxOutputChars);
      const base = {
        ok: res.ok,
        exit_code: res.exitCode,
        stdout: out.text,
        stderr: err.text,
        timed_out: res.timedOut,
        duration_ms: res.durationMs,
        command: args.command,
        cwd: args.cwd ?? null,
      };
      if (!res.ok && !res.timedOut) {
        // Treat refused/denied/unknown-host as connection failures, not command failures.
        const joined = (err.text + ' ' + (res.error ?? '')).toLowerCase();
        if (joined.includes('connection refused') || joined.includes('permission denied') ||
            joined.includes('no route to host') || joined.includes('timed out') ||
            joined.includes('could not resolve') || joined.includes('authenticity of host')) {
          return failure(res, { stdout: out.text, stderr: err.text, command: args.command });
        }
      }
      return { ...base, stdout_truncated: out.truncated, stderr_truncated: err.truncated };
    },
    presentCall: (args) => ({
      card: 'terminal',
      title: args.command.length > 160 ? `${args.command.slice(0, 160)}…` : args.command,
      description: `SSH exec on ${endpointOf(getConfig())}`,
      cwd: args.cwd,
    }),
  }));

  /* --- ssh_read ------------------------------------------------------- */
  register(defineTool({
    name: 'ssh_read',
    description:
      'Read a file (or a byte range of it) from the remote host. offset_bytes/limit_bytes slice ' +
      'large files (default limit 64 KiB, max 1 MiB). encoding auto returns text as-is and ' +
      'base64 for binary; base64 always returns base64.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute remote file path to read.' },
      offset_bytes: { type: 'integer', description: 'Byte offset to start reading from (default 0).' },
      limit_bytes: { type: 'integer', description: 'Max bytes to read (default 65536, max 1048576).' },
      encoding: { type: 'string', enum: ['auto', 'utf8', 'base64'], description: 'How to return the content (default auto).' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    execute: async (args) => {
      const config = resolveTarget(getConfig(), args.target);
      const shell = shellOf(config, args.shell);
      const offset = Math.max(0, args.offset_bytes ?? 0);
      const limit = Math.max(1, Math.min(1048576, args.limit_bytes ?? 65536));
      const script = readScript(shell, args.path, offset, limit);
      const res = await runRemote(config, { script, shell, timeoutMs: 60000 });
      if (!res.ok) return failure(res, { path: args.path });
      const meta = parseKeyValues(res.stderr).obj;
      let buffer;
      try {
        buffer = Buffer.from(trimLine(res.stdout), 'base64');
      } catch {
        return { ok: false, error: 'failed to decode remote content', path: args.path };
      }
      const binary = buffer.includes(0);
      const encoding = args.encoding ?? 'auto';
      const asBase64 = encoding === 'base64' || (encoding === 'auto' && binary);
      return {
        ok: true,
        path: args.path,
        exists: true,
        size: Number(meta.size ?? -1),
        offset,
        limit,
        bytes_read: Number(meta.got ?? buffer.length),
        encoding: asBase64 ? 'base64' : 'utf8',
        content: asBase64 ? buffer.toString('base64') : buffer.toString('utf8'),
        is_binary: binary,
      };
    },
    presentCall: (args) => ({ card: 'generic', title: `SSH read ${args.path}`, kind: 'other', rawInput: args.path }),
  }));

  /* --- ssh_write ------------------------------------------------------ */
  register(defineTool({
    name: 'ssh_write',
    description:
      'Create or overwrite a file on the remote host with the given text content. Creates parent ' +
      'directories as needed. mode (e.g. 755) is optional.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute remote file path to write.' },
      content: { type: 'string', required: true, description: 'Full text content to write (overwrites the file).' },
      mode: { type: 'string', description: 'Optional permission mode, e.g. 755 or 644.' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    execute: async (args) => {
      const config = resolveTarget(getConfig(), args.target);
      const shell = shellOf(config, args.shell);
      const buf = Buffer.from(args.content, 'utf8');
      if (buf.length > MAX_TRANSFER_BYTES) {
        return { ok: false, error: `content too large (${buf.length} bytes > ${MAX_TRANSFER_BYTES})`, path: args.path };
      }
      const script = writeScript(shell, args.path, buf.toString('base64'), args.mode, false);
      const res = await runRemote(config, { script, shell, timeoutMs: 60000 });
      if (!res.ok) return failure(res, { path: args.path });
      return { ok: true, path: args.path, bytes_written: buf.length, mode: args.mode ?? null, overwritten: true };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `SSH write ${args.path}`,
      kind: 'other',
      rawInput: { path: args.path, bytes: args.content.length },
    }),
  }));

  /* --- ssh_append ----------------------------------------------------- */
  register(defineTool({
    name: 'ssh_append',
    description: 'Append text content to a remote file (creating it if missing).',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute remote file path to append to.' },
      content: { type: 'string', required: true, description: 'Text to append at the end of the file.' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    execute: async (args) => {
      const config = resolveTarget(getConfig(), args.target);
      const shell = shellOf(config, args.shell);
      const buf = Buffer.from(args.content, 'utf8');
      if (buf.length > MAX_TRANSFER_BYTES) {
        return { ok: false, error: `content too large (${buf.length} bytes > ${MAX_TRANSFER_BYTES})`, path: args.path };
      }
      const script = writeScript(shell, args.path, buf.toString('base64'), null, true);
      const res = await runRemote(config, { script, shell, timeoutMs: 60000 });
      if (!res.ok) return failure(res, { path: args.path });
      return { ok: true, path: args.path, bytes_written: buf.length };
    },
    presentCall: (args) => ({ card: 'generic', title: `SSH append ${args.path}`, kind: 'other', rawInput: args.path }),
  }));

  /* --- ssh_list ------------------------------------------------------- */
  register(defineTool({
    name: 'ssh_list',
    description: 'List a remote directory (long format, including hidden entries).',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute remote directory path to list.' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    execute: async (args) => {
      const config = resolveTarget(getConfig(), args.target);
      const shell = shellOf(config, args.shell);
      const script = listScript(shell, args.path);
      const res = await runRemote(config, { script, shell, timeoutMs: 60000 });
      if (!res.ok) return failure(res, { path: args.path });
      const listing = cut(res.stdout, config.maxOutputChars);
      return { ok: true, path: args.path, listing: listing.text, truncated: listing.truncated };
    },
    presentCall: (args) => ({ card: 'generic', title: `SSH list ${args.path}`, kind: 'other', rawInput: args.path }),
  }));

  /* --- ssh_stat ------------------------------------------------------- */
  register(defineTool({
    name: 'ssh_stat',
    description: 'Get metadata (exists, type, size, mtime, mode, owner) for a remote path.',
    parameters: {
      path: { type: 'string', required: true, description: 'Absolute remote path to stat.' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    execute: async (args) => {
      const config = resolveTarget(getConfig(), args.target);
      const shell = shellOf(config, args.shell);
      const script = statScript(shell, args.path);
      const res = await runRemote(config, { script, shell, timeoutMs: 60000 });
      if (!res.ok) return failure(res, { path: args.path });
      const { obj } = parseKeyValues(res.stdout);
      if (!obj.type || obj.type === 'missing') {
        return { ok: true, path: args.path, exists: false, type: 'missing' };
      }
      return {
        ok: true,
        path: args.path,
        exists: true,
        type: normalizeType(obj.type),
        size: obj.size !== undefined ? Number(obj.size) : null,
        mtime_epoch: obj.mtime !== undefined ? Number(obj.mtime) : null,
        mode: obj.mode ?? null,
        owner: obj.owner ?? null,
        group: obj.group ?? null,
      };
    },
    presentCall: (args) => ({ card: 'generic', title: `SSH stat ${args.path}`, kind: 'other', rawInput: args.path }),
  }));

  /* --- ssh_upload ----------------------------------------------------- */
  register(defineTool({
    name: 'ssh_upload',
    description:
      'Upload a LOCAL file (on this DSH server) to the remote host over the SSH route. ' +
      'local_path is a path on this server; remote_path is the destination on the remote machine. ' +
      'mode (e.g. 755) is optional.',
    parameters: {
      local_path: { type: 'string', required: true, description: 'Source path on this DSH server.' },
      remote_path: { type: 'string', required: true, description: 'Destination path on the remote host.' },
      mode: { type: 'string', description: 'Optional permission mode on the remote file, e.g. 755.' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    execute: async (args) => {
      const config = resolveTarget(getConfig(), args.target);
      const shell = shellOf(config, args.shell);
      let buf;
      try {
        buf = await fs.readFile(args.local_path);
      } catch (err) {
        return { ok: false, error: `cannot read local file: ${err.message}`, local_path: args.local_path };
      }
      if (buf.length > MAX_TRANSFER_BYTES) {
        return { ok: false, error: `local file too large (${buf.length} bytes > ${MAX_TRANSFER_BYTES})`, local_path: args.local_path };
      }
      const script = writeScript(shell, args.remote_path, buf.toString('base64'), args.mode, false);
      const res = await runRemote(config, { script, shell, timeoutMs: 120000 });
      if (!res.ok) return failure(res, { local_path: args.local_path, remote_path: args.remote_path });
      return {
        ok: true,
        local_path: args.local_path,
        remote_path: args.remote_path,
        bytes: buf.length,
        mode: args.mode ?? null,
      };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `SSH upload → ${args.remote_path}`,
      kind: 'other',
      rawInput: { from: args.local_path, to: args.remote_path },
    }),
  }));

  /* --- ssh_download --------------------------------------------------- */
  register(defineTool({
    name: 'ssh_download',
    description:
      'Download a file from the remote host to a LOCAL path on this DSH server over the SSH route. ' +
      `Remote files up to ${MAX_TRANSFER_BYTES} bytes are supported.`,
    parameters: {
      remote_path: { type: 'string', required: true, description: 'Source path on the remote host.' },
      local_path: { type: 'string', required: true, description: 'Destination path on this DSH server.' },
    },
    output: { schema: { type: 'json' }, render: textRender },
    execute: async (args) => {
      const config = resolveTarget(getConfig(), args.target);
      const shell = shellOf(config, args.shell);
      const script = downloadScript(shell, args.remote_path);
      const res = await runRemote(config, { script, shell, timeoutMs: 120000 });
      if (!res.ok) return failure(res, { remote_path: args.remote_path });
      let buffer;
      try {
        buffer = Buffer.from(trimLine(res.stdout).replace(/\s+/g, ''), 'base64');
      } catch {
        return { ok: false, error: 'failed to decode remote content', remote_path: args.remote_path };
      }
      if (buffer.length > MAX_TRANSFER_BYTES) {
        return { ok: false, error: `remote file too large (${buffer.length} bytes > ${MAX_TRANSFER_BYTES})`, remote_path: args.remote_path };
      }
      try {
        await fs.mkdir(requireLocalDir(args.local_path), { recursive: true });
        await fs.writeFile(args.local_path, buffer);
      } catch (err) {
        return { ok: false, error: `cannot write local file: ${err.message}`, local_path: args.local_path };
      }
      return { ok: true, remote_path: args.remote_path, local_path: args.local_path, bytes: buffer.length };
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `SSH download ← ${args.remote_path}`,
      kind: 'other',
      rawInput: { from: args.remote_path, to: args.local_path },
    }),
  }));
}

/** Dirname helper without pulling in node:path in this module. */
function requireLocalDir(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i <= 0 ? '.' : p.slice(0, i);
}

/* --------------------------------------------- web UI config card backend */

const SHELLS = ['bash', 'powershell'];
const HOST_KEY_MODES = ['accept-new', 'no', 'yes'];
const PUBLIC_FIELDS = [
  'host', 'port', 'user', 'identityFile', 'defaultShell', 'connectTimeout',
  'serverAliveInterval', 'serverAliveCountMax', 'strictHostKeyChecking',
  'knownHostsFile', 'maxOutputChars',
];

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), '.dsh');
}

function overlayPath() {
  return join(dshHome(), 'ssh-remote.config.json');
}

/** 校验一条命名连接；name/host/user 缺一不可，其余给安全默认值。 */
function sanitizeConnection(item) {
  if (!item || typeof item !== 'object') return null;
  const name = typeof item.name === 'string' ? item.name.trim() : '';
  const host = typeof item.host === 'string' ? item.host.trim() : '';
  const user = typeof item.user === 'string' ? item.user.trim() : '';
  if (!name || !host || !user) return null;
  const port = Number(item.port);
  const connectTimeout = Number(item.connectTimeout);
  return {
    name,
    host,
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 22,
    user,
    identityFile: typeof item.identityFile === 'string' && item.identityFile.trim() ? item.identityFile.trim() : '~/.ssh/dsh_cloud_to_home',
    defaultShell: SHELLS.includes(item.defaultShell) ? item.defaultShell : 'bash',
    connectTimeout: Number.isInteger(connectTimeout) && connectTimeout >= 1 && connectTimeout <= 120 ? connectTimeout : 15,
    // 仅在非空时携带：空值不覆盖顶层默认起始目录
    ...(typeof item.defaultCwd === 'string' && item.defaultCwd.trim() ? { defaultCwd: item.defaultCwd.trim() } : {}),
  };
}

function sanitizeConnections(raw) {
  if (!Array.isArray(raw)) return [];
  const list = [];
  for (const item of raw) {
    const entry = sanitizeConnection(item);
    if (entry) list.push(entry);
  }
  return list;
}

/** Keep only well-formed, known fields from a UI patch. */
function sanitizePatch(raw) {
  const out = {};
  const r = raw && typeof raw === 'object' ? raw : {};
  if (typeof r.host === 'string' && r.host.trim()) out.host = r.host.trim();
  const port = Number(r.port);
  if (Number.isInteger(port) && port >= 1 && port <= 65535) out.port = port;
  if (typeof r.user === 'string' && r.user.trim()) out.user = r.user.trim();
  if (typeof r.identityFile === 'string' && r.identityFile.trim()) out.identityFile = r.identityFile.trim();
  if (SHELLS.includes(r.defaultShell)) out.defaultShell = r.defaultShell;
  const connectTimeout = Number(r.connectTimeout);
  if (Number.isInteger(connectTimeout) && connectTimeout >= 1 && connectTimeout <= 120) out.connectTimeout = connectTimeout;
  const aliveInterval = Number(r.serverAliveInterval);
  if (Number.isInteger(aliveInterval) && aliveInterval >= 0 && aliveInterval <= 3600) out.serverAliveInterval = aliveInterval;
  const aliveCountMax = Number(r.serverAliveCountMax);
  if (Number.isInteger(aliveCountMax) && aliveCountMax >= 0 && aliveCountMax <= 100) out.serverAliveCountMax = aliveCountMax;
  if (HOST_KEY_MODES.includes(r.strictHostKeyChecking)) out.strictHostKeyChecking = r.strictHostKeyChecking;
  if (typeof r.knownHostsFile === 'string' && r.knownHostsFile.trim()) out.knownHostsFile = r.knownHostsFile.trim();
  const maxOutputChars = Number(r.maxOutputChars);
  if (Number.isInteger(maxOutputChars) && maxOutputChars >= 1000 && maxOutputChars <= 10_000_000) out.maxOutputChars = maxOutputChars;
  // 起始目录：允许显式空串以清除
  if (typeof r.defaultCwd === 'string') out.defaultCwd = r.defaultCwd.trim();
  const connections = sanitizeConnections(r.connections);
  if (connections.length > 0) out.connections = connections;
  return out;
}

function readOverlay() {
  try {
    return sanitizePatch(JSON.parse(readFileSync(overlayPath(), 'utf8')));
  } catch {
    return {};
  }
}

function writeOverlay(values) {
  try {
    mkdirSync(dshHome(), { recursive: true });
    const slim = {};
    for (const key of PUBLIC_FIELDS) {
      if (values[key] !== undefined) slim[key] = values[key];
    }
    const connections = sanitizeConnections(values.connections);
    if (connections.length > 0) slim.connections = connections;
    writeFileSync(overlayPath(), `${JSON.stringify(slim, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析一次调用的目标连接：
 *   target 名字 → 对应命名连接（字段落叠加在顶层默认值上）；
 *   省略 target → 第 1 条命名连接；没有命名连接 → 顶层配置本身。
 * 未知名字抛错（工具框架会把异常转成错误结果返回给模型）。
 */
function resolveTarget(base, target) {
  const list = Array.isArray(base.connections) ? base.connections : [];
  if (target) {
    const entry = list.find((c) => String(c.name).toLowerCase() === String(target).toLowerCase());
    if (!entry) {
      throw new Error(`未知的 SSH 连接 "${target}"，可用: ${list.map((c) => c.name).join(', ') || '(无，请先在配置卡片添加连接)'}`);
    }
    return { ...base, ...entry };
  }
  return list.length > 0 ? { ...base, ...list[0] } : base;
}

/** presentCall 用的安全版本：不抛错，解析失败时退回顶层配置。 */
function resolveTargetSafe(base, target) {
  try {
    return resolveTarget(base, target);
  } catch {
    return base;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1e6) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function handleConfigApi(req, res, live) {
  (async () => {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'POST only' });
      return;
    }
    const body = await readBody(req);
    const method = String(body.method || 'config');
    // 远程目录浏览（供 Web UI 选择个人电脑文件夹；只列目录名，只读）
    if (method === 'browse') {
      try {
        const cfg = resolveTarget(live, body.target);
        const dir = String(body.path || '').trim() || '.';
        const shell = cfg.defaultShell === 'powershell' ? 'powershell' : 'bash';
        const script = shell === 'powershell'
          ? [
              `$d = ${psq(dir)}`,
              `if (-not (Test-Path -LiteralPath $d -PathType Container)) { Write-Output '__DSH_BROWSE_ERR__NO_DIR'; exit 0 }`,
              `Write-Output ('__DSH_BROWSE_PATH__' + (Resolve-Path -LiteralPath $d).Path)`,
              `Get-ChildItem -LiteralPath $d -Directory | ForEach-Object { Write-Output $_.Name }`,
            ].join('\n')
          : [
              `d=${shq(dir)}`,
              `if [ ! -d "$d" ]; then echo __DSH_BROWSE_ERR__NO_DIR; exit 0; fi`,
              `echo "__DSH_BROWSE_PATH__$(cd "$d" 2>/dev/null && pwd)"`,
              `find "$d" -mindepth 1 -maxdepth 1 -type d -printf '%f\\n' 2>/dev/null | sort`,
            ].join('\n');
        const rr = await runRemote(cfg, { script, shell, timeoutMs: 20000 });
        const lines = String(rr.stdout || '').split('\n').map((s) => s.replace(/\r$/, '')).filter((s) => s.length > 0);
        if (lines[0] === '__DSH_BROWSE_ERR__NO_DIR') {
          sendJson(res, 200, { ok: false, error: `目录不存在: ${dir}` });
          return;
        }
        if (lines[0] && lines[0].startsWith('__DSH_BROWSE_PATH__')) {
          sendJson(res, 200, { ok: true, target: cfg.name || '', path: lines[0].slice('__DSH_BROWSE_PATH__'.length), dirs: lines.slice(1) });
          return;
        }
        sendJson(res, 200, { ok: false, error: rr.ok ? '无法解析目录列表' : `远程执行失败 (exit ${rr.exitCode})` });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: String((error && error.message) || error) });
      }
      return;
    }
    // 纯远程模式（v1.4.0）：把远程目录设为某台电脑的默认工作目录。
    // 不创建任何本地镜像 —— 项目文件完全留在远程电脑上，读写一律走 SSH 工具。
    if (method === 'set-workdir') {
      try {
        const cfg = resolveTarget(live, body.target);
        const dir = String(body.path || '').trim();
        if (!dir) {
          sendJson(res, 200, { ok: false, error: '缺少远程目录' });
          return;
        }
        const conns = sanitizeConnections(live.connections).map((c) => (c.name === cfg.name ? { ...c, defaultCwd: dir } : c));
        if (conns.length > 0) {
          live.connections = conns;
          writeOverlay(live);
        }
        sendJson(res, 200, { ok: true, target: cfg.name || '', path: dir });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: String((error && error.message) || error) });
      }
      return;
    }
    // 远程新建文件夹（供工作区选择的目录浏览器使用；只允许在目录下建一级子目录）
    if (method === 'mkdir') {
      try {
        const cfg = resolveTarget(live, body.target);
        const dir = String(body.path || '').trim();
        const name = String(body.name || '').trim();
        if (!dir || !name) {
          sendJson(res, 200, { ok: false, error: '缺少目录或文件夹名称' });
          return;
        }
        if (name === '.' || name === '..' || /[\\/]|\.\.[\\/]/.test(name)) {
          sendJson(res, 200, { ok: false, error: '名称不能包含路径分隔符' });
          return;
        }
        const shell = cfg.defaultShell === 'powershell' ? 'powershell' : 'bash';
        const script = shell === 'powershell'
          ? [
              `$p = Join-Path ${psq(dir)} ${psq(name)}`,
              `New-Item -ItemType Directory -Path $p -Force | Out-Null`,
              `if (Test-Path -LiteralPath $p -PathType Container) { Write-Output ('__DSH_MKDIR_OK__' + $p) } else { Write-Output '__DSH_MKDIR_ERR__' }`,
            ].join('\n')
          : [
              `mkdir -p -- ${shq(dir.replace(/[\\/]+$/, '') + '/' + name)}`,
              `if [ -d ${shq(dir.replace(/[\\/]+$/, '') + '/' + name)} ]; then echo __DSH_MKDIR_OK__; else echo __DSH_MKDIR_ERR__; fi`,
            ].join('\n');
        const res2 = await runRemote(cfg, { script, shell, timeoutMs: 20000 });
        const outLine = String(res2.stdout || '').split('\n').map((s) => s.trim()).filter(Boolean)[0] || '';
        if (outLine.startsWith('__DSH_MKDIR_ERR__') || (!res2.ok && !outLine.startsWith('__DSH_MKDIR_OK__'))) {
          sendJson(res, 200, { ok: false, error: `创建失败 (exit ${res2.exitCode})` });
          return;
        }
        const created = outLine.startsWith('__DSH_MKDIR_OK__') ? outLine.slice('__DSH_MKDIR_OK__'.length) : '';
        sendJson(res, 200, { ok: true, path: created || name, target: cfg.name || '' });
      } catch (error) {
        sendJson(res, 200, { ok: false, error: String((error && error.message) || error) });
      }
      return;
    }
    if (method !== 'config') {
      sendJson(res, 404, { ok: false, error: `unknown method: ${method}` });
      return;
    }
    let persisted;
    if (body.save) {
      const patch = sanitizePatch(body);
      if (Object.keys(patch).length === 0) {
        sendJson(res, 200, { ok: false, error: '没有可保存的有效字段（host/user 必填）' });
        return;
      }
      Object.assign(live, patch);
      persisted = writeOverlay(live);
    }
    const view = {
      ok: true,
      persisted: persisted !== false,
      target: endpointOf(live),
      connections: sanitizeConnections(live.connections),
    };
    for (const key of PUBLIC_FIELDS) view[key] = live[key];
    sendJson(res, 200, view);
  })().catch((error) => {
    sendJson(res, 200, { ok: false, error: error instanceof Error ? error.message : String(error) });
  });
}

export function apply(ctx, config) {
  // 工具读取的“活配置”：cordis.patch.yml 的组合值为基底，叠加用户在 Web UI
  // 保存的覆盖层（~/.dsh/ssh-remote.config.json）。保存后同一对象被就地更新，
  // 工具在每次调用时读取，因此立即生效，无需重启。
  const live = { ...config, ...readOverlay() };
  const getConfig = () => live;
  registerTools(ctx, getConfig);

  // 可配置页按 Host settings 命名空间分发 settings.plugin.item 卡片：
  // 不登记命名空间的话，客户端卡片永远不会被 dispatch（与 skillhub 相同）。
  // 采用运行时注入而非静态 inject，避免插件加载对服务就绪顺序的强依赖。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['settings'], (c) => {
      try {
        c.settings.register(NS, Config, { base: config });
      } catch (error) {
        ctx.logger('deepseek-harness-ssh').warn('settings namespace registration failed: %s', String(error));
      }
    });
  }

  // 纯远程模式：把“远程工作目录”注入每次系统提示，让模型默认用 ssh_* 工具
  // 在远程电脑上读写，而不是本地文件工具（借鉴 dsh-remote 的 systemPrompt 注入）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['systemPrompt'], (c) => {
      try {
        c.systemPrompt.section({
          name: NS,
          order: 88,
          text: () => {
            const conns = sanitizeConnections(getConfig().connections).filter((x) => x.defaultCwd);
            if (conns.length === 0) return '';
            const lines = conns.map((x) => `- ${x.name} → ${x.defaultCwd} (${x.user}@${x.host}:${x.port}, ${x.defaultShell})`);
            return [
              '[SSH 远程工作目录] 以下项目目录完全存放在远程电脑上，云端没有副本。对这些目录的查看、读写、搜索一律使用 ssh_list_dir / ssh_read_file / ssh_write_file / ssh_exec（带 target=机器名），不要用本地 Read/Write/Edit/Glob/Grep 工具；用户提到这些项目时，默认就在对应远程目录里工作，改完的文件立即生效于远程电脑。',
              ...lines,
            ].join('\n');
          },
        });
      } catch (error) {
        ctx.logger(NS).warn('systemPrompt section registration failed: %s', String(error));
      }
    });
  }

  // 卡片的实际读写走本插件的同源 HTTP 端点（经边缘代理同样有效）。
  if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (c) => {
      try {
        c.webServer.register({
          kind: 'exact',
          path: '/ssh-remote',
          handler: (req, res) => handleConfigApi(req, res, live),
        });
      } catch (error) {
        ctx.logger('deepseek-harness-ssh').warn('webServer endpoint registration failed: %s', String(error));
      }
    });
  }

  const conns = sanitizeConnections(live.connections);
  const targets = conns.length > 0
    ? conns.map((c) => `${c.name}=${c.user}@${c.host}:${c.port}`).join(', ')
    : endpointOf(live);
  ctx.logger('deepseek-harness-ssh').info(
    `ssh tools registered → targets: ${targets}; ` +
    'configure via Web UI 设置 → 插件 → 可配置（SSH 远程连接卡片）'
  );
}

export default { name, inject, Config, apply };
