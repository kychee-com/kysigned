/**
 * cli/bin smoke — #125 (diagnostics) and #126 (the bin always starts stdio,
 * even through a symlink). These drive the BUILT bin (dist/index.js) because
 * #126 is specific to how Node resolves import.meta.url vs argv[1] for the
 * real ESM entrypoint. The suite builds dist once in a before hook.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, symlinkSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const dist = join(root, 'dist', 'index.js');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };

before(() => {
  execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'ignore', shell: true });
  assert.ok(existsSync(dist), 'dist/index.js built');
});

/** Send one MCP initialize over a child's stdio and resolve its first JSON response line. */
function handshake(command: string, args: string[]): Promise<{ id?: number; result?: { serverInfo?: { version?: string } } }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env } });
    let buf = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('no handshake response within 15s — the stdio server never started'));
    }, 15000);
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const nl = buf.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        child.kill();
        try {
          resolve(JSON.parse(buf.slice(0, nl)));
        } catch (e) {
          reject(e);
        }
      }
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.stdin.write(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      }) + '\n',
    );
  });
}

describe('#125 — CLI diagnostics', () => {
  it('--version prints the package version', () => {
    const out = execFileSync('node', [dist, '--version'], { encoding: 'utf8' });
    assert.equal(out.trim(), pkg.version);
  });
  it('--help prints usage, the env vars, and a host config example', () => {
    const out = execFileSync('node', [dist, '--help'], { encoding: 'utf8' });
    assert.match(out, /Usage:/);
    assert.match(out, /KYSIGNED_ENDPOINT/);
    assert.match(out, /KYSIGNED_AUTHORIZATION/);
    assert.match(out, /"command":\s*"npx"/);
  });
});

describe('#126 — the bin ALWAYS starts stdio (no is-main guard)', () => {
  it('index.ts carries no import.meta.url is-main guard (regression fence)', () => {
    const src = readFileSync(join(here, 'index.ts'), 'utf8');
    assert.equal(/import\.meta\.url\s*===/.test(src), false, 'the is-main guard must not return');
  });

  it('invoked DIRECTLY, the bin completes an MCP initialize handshake (server version = npm version, #125)', async () => {
    const res = await handshake('node', [dist]);
    assert.equal(res.id, 1);
    assert.equal(res.result?.serverInfo?.version, pkg.version);
  });

  it('invoked through a SYMLINK (the #126 repro), the bin still starts stdio', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'kysigned-mcp-bin-'));
    const link = join(dir, 'kysigned-mcp');
    try {
      symlinkSync(dist, link);
    } catch (e) {
      // Windows without the symlink privilege / Developer Mode → cannot create a
      // symlink. The guard removal makes this path invocation-independent by
      // construction; skip rather than fail where the OS blocks symlink creation.
      rmSync(dir, { recursive: true, force: true });
      t.skip(`symlink not permitted here (${(e as Error).message}); guard-removal covers this by construction`);
      return;
    }
    try {
      const res = await handshake('node', [link]);
      assert.equal(res.id, 1);
      assert.ok(res.result?.serverInfo, 'stdio started via the symlink path');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
