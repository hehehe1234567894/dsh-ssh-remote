/**
 * Local self-test for deepseek-harness-ssh.
 *
 * Loads the plugin against a mock Cordis ctx, then exercises every tool over a
 * real SSH connection to this same host (localhost:22, key auth) — the exact
 * route shape a reverse-SSH tunnel will use later (just different port/user).
 *
 * Run:  node scripts/selftest.js
 */

import fs from 'node:fs';
import { apply } from '../lib/index.js';

// 隔离：让插件的 overlay（~/.dsh/ssh-remote.config.json）指向临时目录，
// 避免把真实环境的连接配置读进自测。
process.env.DSH_HOME = '/tmp/dsh-selftest-home';
fs.rmSync('/tmp/dsh-selftest-home', { recursive: true, force: true });

const tools = [];
const ctx = {
  tools: { register: (def) => tools.push(def) },
  logger: () => ({ info: () => {}, warn: () => {} }),
};

const config = {
  host: 'localhost',
  port: 22,
  user: 'ubuntu',
  identityFile: '/home/ubuntu/.ssh/dsh_cloud_to_home',
  connectTimeout: 8,
  serverAliveInterval: 15,
  serverAliveCountMax: 3,
  strictHostKeyChecking: 'accept-new',
  knownHostsFile: '/tmp/dsh_known_hosts',
  extraArgs: [],
  defaultShell: 'bash',
  maxOutputChars: 200000,
  // 多目标：命一条 "local" 连接（与顶层同一台机器），用于验证 target 解析
  connections: [
    {
      name: 'local',
      host: 'localhost',
      port: 22,
      user: 'ubuntu',
      identityFile: '/home/ubuntu/.ssh/dsh_cloud_to_home',
      defaultShell: 'bash',
      connectTimeout: 8,
      defaultCwd: '/tmp/dsh_selftest',
    },
  ],
};

apply(ctx, config);
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
console.log(`loaded ${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);

const out = {};
const exec = {}; // tools ignore exec, fine

out.ping = await byName.ssh_ping.execute({}, exec);

out.execBasic = await byName.ssh_exec.execute(
  { command: 'echo hello-from-remote && pwd', cwd: '/tmp' },
  exec
);

out.execEnv = await byName.ssh_exec.execute(
  { command: 'echo "MYVAR=$MYVAR"', env: { MYVAR: 'from-env-ok' } },
  exec
);

out.execFail = await byName.ssh_exec.execute({ command: 'exit 3' }, exec);

out.write = await byName.ssh_write.execute(
  { path: '/tmp/dsh_selftest/hello.txt', content: 'line1\nline2 中文内容\n' },
  exec
);

out.append = await byName.ssh_append.execute(
  { path: '/tmp/dsh_selftest/hello.txt', content: 'appended-line\n' },
  exec
);

out.read = await byName.ssh_read.execute({ path: '/tmp/dsh_selftest/hello.txt' }, exec);

out.readSlice = await byName.ssh_read.execute(
  { path: '/tmp/dsh_selftest/hello.txt', offset_bytes: 6, limit_bytes: 8 },
  exec
);
// 8 bytes from byte 6: "line2 中" (中 is 3 UTF-8 bytes) → 7 chars, 8 bytes.
out.readSliceChars = out.readSlice.content.length;
out.readSliceBytes = out.readSlice.bytes_read;

out.readMissing = await byName.ssh_read.execute({ path: '/tmp/dsh_selftest/missing.txt' }, exec);

out.stat = await byName.ssh_stat.execute({ path: '/tmp/dsh_selftest/hello.txt' }, exec);

out.statMissing = await byName.ssh_stat.execute({ path: '/tmp/dsh_selftest/never-existed' }, exec);

out.list = await byName.ssh_list.execute({ path: '/tmp/dsh_selftest' }, exec);

// upload + download round-trip
fs.writeFileSync('/tmp/dsh_selftest/src.bin', Buffer.from([0, 1, 2, 253, 254, 255, 65, 66, 67]));
out.upload = await byName.ssh_upload.execute(
  { local_path: '/tmp/dsh_selftest/src.bin', remote_path: '/tmp/dsh_selftest/dst.bin', mode: '644' },
  exec
);
out.download = await byName.ssh_download.execute(
  { remote_path: '/tmp/dsh_selftest/dst.bin', local_path: '/tmp/dsh_selftest/back.bin' },
  exec
);
const roundTripOk =
  out.download.ok &&
  fs.readFileSync('/tmp/dsh_selftest/back.bin').equals(fs.readFileSync('/tmp/dsh_selftest/src.bin'));
out.roundTripOk = roundTripOk;

// binary read with auto encoding
out.readBinary = await byName.ssh_read.execute({ path: '/tmp/dsh_selftest/dst.bin' }, exec);

// 多目标：target='local' 命名连接 + 未知名报错
out.execNamed = await byName.ssh_exec.execute(
  { command: 'echo named-target-ok', target: 'local' },
  exec
);
// 默认起始目录：不带 cwd 应落在 local.defaultCwd
out.execDefaultCwd = await byName.ssh_exec.execute(
  { command: 'basename "$PWD"', target: 'local' },
  exec
);
try {
  out.execUnknownTarget = await byName.ssh_exec.execute(
    { command: 'echo nope', target: 'no-such-machine' },
    exec
  );
} catch (e) {
  // 框架会把 execute 抛出的异常转成错误结果（toolErrorResult），这里模拟之
  out.execUnknownTarget = { ok: false, error: String((e && e.message) || e) };
}

const pass =
  out.ping.ok &&
  out.execBasic.ok && out.execBasic.stdout.includes('hello-from-remote') &&
  out.execEnv.ok && out.execEnv.stdout.includes('from-env-ok') &&
  !out.execFail.ok && out.execFail.exit_code === 3 &&
  out.write.ok && out.append.ok &&
  out.read.ok && out.read.content.includes('中文内容') && out.read.content.includes('appended-line') &&
  out.readSlice.ok && out.readSliceBytes === 8 && out.readSliceChars === 7 &&
  !out.readMissing.ok &&
  out.stat.ok && out.stat.type === 'file' && out.stat.size > 0 &&
  out.statMissing.exists === false &&
  out.list.ok && out.list.listing.includes('hello.txt') &&
  out.upload.ok && out.download.ok && roundTripOk &&
  out.readBinary.ok && out.readBinary.encoding === 'base64' &&
  out.execNamed.ok && out.execNamed.stdout.includes('named-target-ok') &&
  out.execDefaultCwd.ok && out.execDefaultCwd.stdout.includes('dsh_selftest') &&
  !out.execUnknownTarget.ok && String(out.execUnknownTarget.error).includes('no-such-machine');

console.log('\n===== 条件真值 =====');
console.log('ping', out.ping.ok);
console.log('execBasic', out.execBasic.ok, out.execBasic.stdout.includes('hello-from-remote'));
console.log('execEnv', out.execEnv.ok, out.execEnv.stdout.includes('from-env-ok'));
console.log('execFail', !out.execFail.ok, out.execFail.exit_code);
console.log('readSlice', out.readSlice.ok, out.readSliceBytes, out.readSliceChars);
console.log('execNamed', out.execNamed.ok);
console.log('execDefaultCwd', out.execDefaultCwd.ok, JSON.stringify(out.execDefaultCwd.stdout));
console.log('execUnknown', !out.execUnknownTarget.ok, JSON.stringify(out.execUnknownTarget.error));
console.log('\n===== RESULTS =====');
for (const [k, v] of Object.entries(out)) {
  console.log(`--- ${k} ---`);
  if (v && typeof v === 'object' && v.ok !== undefined) {
    console.log(JSON.stringify(v, null, 2).slice(0, 1200));
  } else {
    console.log(JSON.stringify(v));
  }
}
console.log(`\n===== ${pass ? 'ALL TESTS PASSED' : 'SOME TESTS FAILED'} =====`);
process.exit(pass ? 0 : 1);
