import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { getOrCreateCert } from './tls.js';

test('getOrCreateCert generates a key+cert persisted under dataDir/tls', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-tls-'));
  const { key, cert } = await getOrCreateCert(dir);

  assert.match(key, /BEGIN PRIVATE KEY/);
  assert.match(cert, /BEGIN CERTIFICATE/);
  assert.equal(fs.readFileSync(path.join(dir, 'tls', 'key.pem'), 'utf8'), key);
  assert.equal(fs.readFileSync(path.join(dir, 'tls', 'cert.pem'), 'utf8'), cert);
  assert.equal(fs.existsSync(path.join(dir, 'tls', 'key.pem.tmp')), false); // temp renamed away
});

test('a second call reuses the persisted cert instead of minting a new one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-tls-'));
  const first = await getOrCreateCert(dir);
  const second = await getOrCreateCert(dir);
  assert.equal(second.cert, first.cert);
  assert.equal(second.key, first.key);
});

test('the cert covers localhost and loopback, so guests get only the self-signed warning', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-tls-'));
  const { cert } = await getOrCreateCert(dir);
  const x509 = new X509Certificate(cert);
  assert.match(x509.subjectAltName, /DNS:localhost/);
  assert.match(x509.subjectAltName, /IP Address:127\.0\.0\.1/);
});
