/**
 * The QIP-55 (v3) line behind the same API as scripts/qrl.js.
 *
 * `qrl.js` hands over to this module when ARK_QRVM=1, so every script in this
 * directory (deploy, seasons, smoke, interact, handover) runs unchanged on the
 * 64-byte-address chain. The difference is below the API:
 *
 *  - artifacts come from build-qrvm/, compiled by the hyperion main compiler
 *    (HYPC_DOCKER_IMAGE=hypc:local ARK_QRVM=1 node scripts/compile.js);
 *  - transactions and constructors use @theqrl/web3 1.0.x, wallet.js 6.x and
 *    @theqrl/abi 1.x (qrl-v3.js, shared with contracts/core);
 *  - the deployment record is deployments/<name>-qrvm.json, so a v2 record and
 *    a v3 record can sit side by side.
 */
const fs = require('fs');
const path = require('path');
const v3 = require('./qrl-v3');

const ROOT = v3.ROOT;
// QURRL_BUILD_PROFILE=devnet reads build-qrvm-devnet/ (14-minute reveal window; see compile.js).
const BUILD = path.join(ROOT, process.env.QURRL_BUILD_PROFILE === 'devnet' ? 'build-qrvm-devnet' : 'build-qrvm');

function connect() {
  const env = v3.loadEnv();
  const { web3, account } = v3.connect(env);
  return { web3, account, env };
}

function artifact(name) {
  return v3.artifact(name, BUILD);
}

/**
 * Direct deploy. QurrlNFT's v3 creation code is a little over 18,000 bytes, the
 * ceiling the PUBLIC proxy accepts in one request; the private devnet is reached
 * directly and takes it. Anything that does not fit goes through ChunkedDeployer.
 */
async function deploy(web3, account, name, args = [], gas = 12_000_000) {
  const art = artifact(name);
  const address = await retrying(() => v3.deploy(web3, account, art, args, gas), `deploy ${name}`);
  return { options: { address } };
}

/**
 * The deployer key is shared with the devnet's relayer and faucet, which send
 * from the same account between our transactions. A nonce we read can be taken
 * before our transaction lands, and the node answers "replacement transaction
 * underpriced" or "nonce too low". Neither means anything was mined from here,
 * so the transaction is rebuilt with a fresh nonce and sent again.
 */
const COLLISION = /underpriced|nonce too low|already known|nonce has already been used/i;
async function retrying(send, label, attempts = 10) {
  for (let i = 1; ; i += 1) {
    try {
      return await send();
    } catch (e) {
      if (i >= attempts || !COLLISION.test(String(e.message))) throw e;
      console.log(`   ${label}: nonce collision with another sender, retry ${i}/${attempts - 1}`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
}

const sendRaw = (web3, account, tx) => retrying(() => v3.sendRaw(web3, account, tx), `tx to ${String(tx.to).slice(0, 10)}`);

function contractAt(web3, name, address) {
  return new web3.qrl.Contract(artifact(name).abi, address);
}

const toHex = (address) => ('0x' + String(address).replace(/^(Q|0x)/i, '')).toLowerCase();

const recordName = (name) => (name.endsWith('-qrvm') ? name : `${name}-qrvm`);

function saveDeployment(name, data) {
  const dir = path.join(ROOT, 'deployments');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${recordName(name)}.json`);
  fs.writeFileSync(file, JSON.stringify({ ...data, line: 'qip-55' }, null, 2));
  return file;
}

function loadDeployment(name = 'private') {
  const file = path.join(ROOT, 'deployments', `${recordName(name)}.json`);
  if (!fs.existsSync(file)) throw new Error(`no deployments/${recordName(name)}.json - run: ARK_QRVM=1 npm run deploy`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

module.exports = {
  ROOT,
  connect,
  artifact,
  deploy,
  contractAt,
  sendRaw,
  toHex,
  saveDeployment,
  loadDeployment,
  loadEnv: v3.loadEnv,
  deployChunked: v3.deployChunked,
  line: 'qip-55',
};
