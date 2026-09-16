const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');

(async () => {
  const metadata = fs.readFileSync('dist/latest.yml', 'utf8');
  const name = metadata.match(/^path: (.+)$/m)?.[1].trim();
  const hash = metadata.match(/^sha512: (.+)$/m)?.[1].trim();
  assert.ok(
    name && /^[\w.-]+\.exe$/.test(name),
    'Updater must reference a portable installer filename.',
  );
  assert.ok(hash, 'Updater checksum missing.');
  const installer = path.join('dist', name);
  assert.ok(
    fs.existsSync(installer),
    'Updater references a missing installer.',
  );
  assert.ok(
    fs.existsSync(`${installer}.blockmap`),
    'Installer blockmap missing.',
  );
  const digest = crypto.createHash('sha512');
  for await (const chunk of fs.createReadStream(installer))
    digest.update(chunk);
  assert.equal(
    digest.digest('base64'),
    hash,
    'Installer checksum does not match updater metadata.',
  );
  console.log(`Verified installer, blockmap, and update checksum: ${name}`);
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
