import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import selfsigned from 'selfsigned';

/** Every non-internal IPv4/IPv6 address this box currently has, plus loopback
 *  and 'localhost'. Baked into the cert's subjectAltName so a phone hitting
 *  the NAS by its LAN IP gets "self-signed" as the only warning — not also a
 *  hostname mismatch. The IP can still change (DHCP) without breaking
 *  anything: a mismatch just falls back to the plain self-signed warning. */
function subjectAltNames() {
  const altNames = [
    { type: 2, value: 'localhost' }, // type 2 = DNS
    { type: 7, ip: '127.0.0.1' }, // type 7 = IP
    { type: 7, ip: '::1' },
  ];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (!addr.internal) altNames.push({ type: 7, ip: addr.address });
    }
  }
  return altNames;
}

/**
 * A self-signed cert, persisted under `dataDir/tls/` so it survives restarts —
 * without that, every reboot would mint a new one and every phone's
 * one-time "accept the warning" would stop being one-time.
 *
 * Failure (e.g. a read-only volume) is the caller's to handle: this never
 * throws past itself into a process crash over what is a nice-to-have.
 */
export async function getOrCreateCert(dataDir) {
  const dir = path.join(dataDir, 'tls');
  const keyFile = path.join(dir, 'key.pem');
  const certFile = path.join(dir, 'cert.pem');

  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    return { key: fs.readFileSync(keyFile, 'utf8'), cert: fs.readFileSync(certFile, 'utf8') };
  }

  const notAfterDate = new Date();
  notAfterDate.setFullYear(notAfterDate.getFullYear() + 10);
  const pems = await selfsigned.generate([{ name: 'commonName', value: 'poopsmoothie' }], {
    keySize: 2048,
    algorithm: 'sha256',
    notAfterDate,
    extensions: [
      { name: 'basicConstraints', cA: false },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
      { name: 'subjectAltName', altNames: subjectAltNames() },
    ],
  });

  fs.mkdirSync(dir, { recursive: true });
  // temp + rename, same reasoning as persist.js: a crash mid-write must never
  // leave a half-written key on disk for the next boot to trip over
  fs.writeFileSync(`${keyFile}.tmp`, pems.private);
  fs.renameSync(`${keyFile}.tmp`, keyFile);
  fs.writeFileSync(`${certFile}.tmp`, pems.cert);
  fs.renameSync(`${certFile}.tmp`, certFile);
  return { key: pems.private, cert: pems.cert };
}
