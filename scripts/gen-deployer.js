/**
 * Generates a fresh ML-DSA-87 deployer wallet and a season-seed secret, and
 * records both in .env.
 *
 * Why generate rather than reuse the network's prefunded accounts: the QRL
 * Kurtosis package inherits its genesis account table from the upstream
 * ethereum-package, so `prefunded_accounts` there carries 32-byte secp256k1
 * seeds. A QRL Zond account is ML-DSA-87 and derives from a 51-byte extended
 * seed, so those seeds cannot be signed with.
 *
 * SEASON_SEED_SECRET is the other irreplaceable value here. Every season seed
 * is derived from it, and a season whose seed cannot be reproduced can never be
 * revealed - its tokens stay sealed permanently, with no admin override.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MLDSA87 } = require('@theqrl/wallet.js');
const { Web3 } = require('@theqrl/web3');

const ROOT = path.join(__dirname, '..');
const ENV = path.join(ROOT, '.env');

/** Rewrites one KEY="value" line in place, appending it when absent. */
function upsert(text, key, value) {
  const line = `${key}="${value}"`;
  const re = new RegExp(`^\\s*${key}\\s*=.*$`, 'm');
  if (re.test(text)) return text.replace(re, line);
  return (text.endsWith('\n') || text === '' ? text : text + '\n') + line + '\n';
}

function addressOf(mnemonic) {
  const wallet = MLDSA87.newWalletFromMnemonic(mnemonic);
  return new Web3().qrl.accounts.seedToAccount(wallet.getHexExtendedSeed()).address;
}

function main() {
  const force = process.argv.includes('--force');

  let env = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  if (!env) {
    const example = path.join(ROOT, '.env.example');
    env = fs.existsSync(example) ? fs.readFileSync(example, 'utf8') : '';
  }

  const existing = env.match(/^\s*DEPLOYER_MNEMONIC\s*=\s*"?(.+?)"?\s*$/m);
  const reuse = existing && !existing[1].startsWith('<') && !force;

  const mnemonic = reuse ? existing[1] : MLDSA87.newWallet().getMnemonic().trim();
  const address = addressOf(mnemonic);

  env = upsert(env, 'DEPLOYER_MNEMONIC', mnemonic);
  env = upsert(env, 'DEPLOYER_ADDRESS', address);

  const hasSecret = /^\s*SEASON_SEED_SECRET\s*=\s*"?(?!<)(.+?)"?\s*$/m.test(env);
  if (!hasSecret || force) {
    env = upsert(env, 'SEASON_SEED_SECRET', crypto.randomBytes(32).toString('hex'));
  }

  fs.writeFileSync(ENV, env);

  console.log(reuse ? '.env already holds a deployer; reusing it.' : 'generated a new ML-DSA-87 deployer');
  console.log(`  address ${address}`);
  if (!hasSecret || force) console.log('  SEASON_SEED_SECRET written - back it up, reveals depend on it');
  if (reuse) console.log('  pass --force to replace it (the old key becomes unrecoverable)');
  console.log('\nnext: fund this address at genesis, then npm run build && npm run deploy');
}

main();
