/**
 * SSH runner primitives for deepseek-harness-ssh.
 *
 * All remote work is executed through the system OpenSSH client
 * (no Node SSH library dependency). The plugin runs scripts over the tunnel
 * using `bash -s` / `powershell -Command -` with the script fed on stdin, so
 * there is no fragile shell-quoting layer for user commands or file contents.
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import path from 'node:path';

/** Expand a leading `~` (and `~/...`) to the current user's home directory. */
export function expandHome(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homedir(), p.slice(2));
  return p;
}

/** POSIX single-quote escaping: safe inside any `sh -c`/`bash -s` script. */
export function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

/** PowerShell single-quote escaping (doubling the quote). */
export function psq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

/** Build the base `ssh` argument vector from plugin config. */
export function buildSshArgs(config) {
  const args = [];
  args.push('-o', `ConnectTimeout=${config.connectTimeout ?? 10}`);
  args.push('-o', 'BatchMode=yes');
  args.push('-o', `StrictHostKeyChecking=${config.strictHostKeyChecking ?? 'accept-new'}`);
  if (config.knownHostsFile) {
    args.push('-o', `UserKnownHostsFile=${expandHome(config.knownHostsFile)}`);
  }
  if (config.serverAliveInterval) {
    args.push('-o', `ServerAliveInterval=${config.serverAliveInterval}`);
  }
  if (config.serverAliveCountMax) {
    args.push('-o', `ServerAliveCountMax=${config.serverAliveCountMax}`);
  }
  args.push('-p', String(config.port));
  if (config.identityFile) {
    args.push('-i', expandHome(config.identityFile));
  }
  for (const extra of config.extraArgs ?? []) args.push(extra);
  return args;
}

/** Cap accumulated stream size; extra data is dropped (truncated flag set). */
const STREAM_CAP = 8 * 1024 * 1024;

/**
 * Run a script on the remote host over SSH.
 *
 * @param config - plugin config (host/port/user/identity...).
 * @param options.script - remote script text (fed on stdin).
 * @param options.shell - 'bash' (default) or 'powershell'.
 * @param options.timeoutMs - kill the ssh process after this budget.
 * @returns { ok, exitCode, stdout, stderr, timedOut, durationMs, stdoutTruncated, stderrTruncated, error? }
 */
export function runRemote(config, options = {}) {
  const { script = '', shell = 'bash', timeoutMs = 120000 } = options;
  return new Promise((resolve) => {
    const host = `${config.user}@${config.host}`;
    const args = [...buildSshArgs(config), host];
    if (shell === 'powershell') {
      args.push('powershell', '-NoProfile', '-NonInteractive', '-Command', '-');
    } else {
      args.push('bash', '-s');
    }

    const started = Date.now();
    let child;
    try {
      child = spawn('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({
        ok: false,
        exitCode: -1,
        stdout: '',
        stderr: '',
        timedOut: false,
        durationMs: Date.now() - started,
        error: String(err),
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      if (stdout.length >= STREAM_CAP) { stdoutTruncated = true; return; }
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length >= STREAM_CAP) { stderrTruncated = true; return; }
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        exitCode: -1,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
        stdoutTruncated,
        stderrTruncated,
        error: String(err),
      });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0,
        exitCode: code ?? -1,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
        stdoutTruncated,
        stderrTruncated,
      });
    });
    child.stdin.on('error', () => { /* EPIPE after close is fine */ });
    child.stdin.end(script);
  });
}

/** Trim a trailing newline (for base64 / one-line outputs). */
export function trimLine(s) {
  return s.replace(/[\r\n]+$/, '');
}
