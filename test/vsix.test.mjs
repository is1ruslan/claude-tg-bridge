import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { buildVsix, EXT_ID } from '../src/vsix.mjs';

const REPO = path.resolve(import.meta.dirname, '..');

// Minimal zip reader (central directory) to check what buildVsix wrote.
function unzip(buf) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out = {};
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const csize = buf.readUInt32LE(p + 20);
    const crc = buf.readUInt32LE(p + 16);
    const nlen = buf.readUInt16LE(p + 28);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(off + 26);
    const data = zlib.inflateRawSync(buf.subarray(off + 30 + lnlen, off + 30 + lnlen + csize));
    assert.equal(zlib.crc32(data), crc, name);
    out[name] = data.toString('utf8');
    p += 46 + nlen;
  }
  return out;
}

test('buildVsix: manifest + package.json + extension.js; identity matches EXT_ID', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cct-vsix-')), 'x.vsix');
  buildVsix(path.join(REPO, 'vscode-ext'), out, { node: 'C:\\node\\node.exe', script: 'C:\\repo\\src\\newsession.mjs' });
  const files = unzip(fs.readFileSync(out));
  assert.deepEqual(Object.keys(files).sort(), [
    '[Content_Types].xml', 'extension.vsixmanifest', 'extension/config.json', 'extension/extension.js', 'extension/package.json',
  ]);
  assert.deepEqual(JSON.parse(files['extension/config.json']), { node: 'C:\\node\\node.exe', script: 'C:\\repo\\src\\newsession.mjs' });
  assert.match(files['extension/extension.js'], /require\('\.\/config\.json'\)/);
  assert.doesNotMatch(files['extension/extension.js'], /job\.node|job\.script/);
  const pkg = JSON.parse(files['extension/package.json']);
  assert.equal(`${pkg.publisher}.${pkg.name}`, EXT_ID);
  assert.match(files['extension.vsixmanifest'], new RegExp(`Id="${pkg.name}" Version="${pkg.version}" Publisher="${pkg.publisher}"`));
  assert.match(files['extension/extension.js'], /\/vscode\/poll/);
});

test('buildVsix: refuses without node/script config', () => {
  const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cct-vsix-')), 'x.vsix');
  assert.throws(() => buildVsix(path.join(REPO, 'vscode-ext'), out), /config\.node/);
});
