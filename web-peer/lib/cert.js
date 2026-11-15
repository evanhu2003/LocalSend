// 自簽 TLS 憑證：第一次執行時產生並存到 data/，之後重複使用（fingerprint 必須固定）
// 規格：RSA-2048、X.509 v3、sha256WithRSAEncryption、CN=LocalSend User、無 SAN/extension、
// 有效期 2000-01-01 ~ 2099-12-31（手錶時鐘可能不準）。見 PROTOCOL.md 1.1。
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import forge from 'node-forge';

/** fingerprint = 大寫 hex( SHA-256( 憑證 DER ) ) */
export function fingerprintOfDer(der) {
  return crypto.createHash('sha256').update(der).digest('hex').toUpperCase();
}

function generate() {
  // 用 Node 內建產生金鑰（比 forge 的純 JS 快很多），再用 forge 組憑證
  const { privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
    privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const key = forge.pki.privateKeyFromPem(privateKey);
  const pub = forge.pki.setRsaPublicKey(key.n, key.e);

  const cert = forge.pki.createCertificate();
  cert.version = 2; // X.509 v3
  cert.publicKey = pub;
  // 序號：16 bytes 正整數，最高位元組介於 0x01..0x7F,DER 編碼最短且為正
  const serial = crypto.randomBytes(16);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  cert.serialNumber = serial.toString('hex');
  cert.validity.notBefore = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));
  cert.validity.notAfter = new Date(Date.UTC(2099, 11, 31, 23, 59, 59));
  const attrs = [{ name: 'commonName', value: 'LocalSend User' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(key, forge.md.sha256.create());

  const certPem = forge.pki.certificateToPem(cert);
  // 私鑰存成 PKCS#8 PEM（與 App 相同）
  const keyPem = crypto.createPrivateKey(privateKey).export({ type: 'pkcs8', format: 'pem' });
  return { certPem, keyPem };
}

export function loadOrCreateIdentity(dataDir) {
  const certFile = path.join(dataDir, 'cert.pem');
  const keyFile = path.join(dataDir, 'key.pem');
  let certPem;
  let keyPem;
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    certPem = fs.readFileSync(certFile, 'utf8');
    keyPem = fs.readFileSync(keyFile, 'utf8');
  } else {
    ({ certPem, keyPem } = generate());
    fs.writeFileSync(keyFile, keyPem, { mode: 0o600 });
    fs.writeFileSync(certFile, certPem);
  }
  const x509 = new crypto.X509Certificate(certPem);
  if (!x509.verify(x509.publicKey)) throw new Error('data/cert.pem 不是有效的自簽憑證');
  const fingerprint = fingerprintOfDer(x509.raw);
  fs.writeFileSync(path.join(dataDir, 'fingerprint.txt'), fingerprint + '\n');
  return { certPem, keyPem, fingerprint };
}
