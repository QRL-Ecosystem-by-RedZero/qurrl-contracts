/**
 * Wires the splitter's Cushion lane to Ark Staking's `ArkCatBond` on the same
 * QRL network: `QurrlRevenueSplitter.setCushion(address)`.
 *
 *   ARK_QRVM=1 node scripts/cushion.js --plan    --cushion Q<128 hex>   read only: what would be sent, and why not
 *   ARK_QRVM=1 node scripts/cushion.js --execute --cushion Q<128 hex>
 *   CUSHION_ADDRESS=Q... ARK_QRVM=1 npm run cushion -- --execute
 *   ... --record <name>                          act on deployments/<name>.json instead of the main record
 *
 * The address comes from the caller (`--cushion`, else `CUSHION_ADDRESS`),
 * never from Ark Staking's files: contract repositories do not read each
 * other's trees. The umbrella's `devnet-up` prints this command with the
 * ArkCatBond of the leg it has just copied back, and runs it with
 * `--qurrl-cushion`.
 *
 * WHAT CAN AND CANNOT HAPPEN
 * --------------------------
 * `setCushion` is one-shot governance wiring (`AlreadyWired`): a splitter
 * whose cushion is set is never re-pointed. On the private devnet that is
 * not a limit in practice: the chain is regenerated from genesis, so after a
 * reset both the leg and the collection are new, and the new splitter's
 * cushion is unset. A splitter already wired to another address is refused
 * here with that reason; wired to this one, nothing is sent.
 *
 * Only the splitter's `governance` may call it. While that is the deployer
 * (`GOVERNANCE_ADDRESS` unset at deploy, private networks) `--execute` sends
 * it; where governance is a multisig, the plan prints the calldata for its
 * owners to submit. Qurrl's roles stay with the deployer or the multisig
 * until `ArkTimelock` has Qurrl rows (../core/CLAUDE.md §3.5).
 *
 * The target must have code; the run checks nothing else about it (a lane
 * the target does not accept makes `claimCushion` revert, never this call).
 */
const assert = require('node:assert/strict');
const { connect, contractAt, sendRaw, loadDeployment } = require('./qrl');

const bare = (a) => String(a).replace(/^(0x|Q)/i, '').toLowerCase();
const same = (a, b) => bare(a) === bare(b);
const isZero = (a) => /^0*$/.test(bare(a));

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? null : process.argv[i + 1];
}

async function main() {
  const execute = process.argv.includes('--execute');
  const plan = process.argv.includes('--plan');
  if (execute === plan) throw new Error('usage: node scripts/cushion.js --plan | --execute [--cushion <address>] [--record <name>]');
  const { web3, account, env } = connect();
  const target = arg('cushion') || process.env.CUSHION_ADDRESS || env.CUSHION_ADDRESS;
  if (!target) throw new Error('no cushion address: pass --cushion <ArkCatBond> or set CUSHION_ADDRESS');
  if (isZero(target)) throw new Error('the cushion address is zero');
  const record = arg('record');
  const deployment = loadDeployment(record || 'private');
  const splitterAddress = deployment.contracts && deployment.contracts.QurrlRevenueSplitter;
  if (!splitterAddress) throw new Error('this deployment has no QurrlRevenueSplitter; redeploy with: npm run deploy');

  const splitter = contractAt(web3, 'QurrlRevenueSplitter', splitterAddress);
  const [current, governance, owed, code, splitterCode] = await Promise.all([
    splitter.methods.cushion().call(),
    splitter.methods.governance().call(),
    splitter.methods.cushionOwed().call(),
    web3.qrl.getCode(target),
    web3.qrl.getCode(splitterAddress),
  ]);
  console.log(`network     ${env.QRL_RPC_URL}`);
  console.log(`splitter    ${splitterAddress}`);
  console.log(`governance  ${governance}${same(governance, account.address) ? ' (this deployer)' : ''}`);
  console.log(`cushion     ${isZero(current) ? 'unset' : current}  (owed ${BigInt(owed)} planck)`);
  console.log(`target      ${target}${code && code !== '0x' ? '' : '  (NO CODE)'}`);

  if (!splitterCode || splitterCode === '0x') throw new Error(`the splitter ${splitterAddress} has no code on this chain: the devnet was regenerated; deploy the collection again (ARK_QRVM=1 npm run deploy)`);
  if (!code || code === '0x') throw new Error(`${target} has no code on this chain; pass the ArkCatBond of the leg deployed on this genesis`);
  if (same(current, target)) {
    console.log('\nthe cushion already names this address; nothing to send');
    return;
  }
  if (!isZero(current)) {
    throw new Error(`the cushion is wired to ${current} already; setCushion is one-shot (AlreadyWired), so a new ArkCatBond needs a new splitter (deploy the collection again on this genesis)`);
  }
  const data = splitter.methods.setCushion(target).encodeABI();
  if (!same(governance, account.address)) {
    console.log(`\nthe splitter's governance is ${governance}, not this deployer: its owners submit`);
    console.log(`   to   ${splitterAddress}\n   data ${data}`);
    if (execute) throw new Error('refusing to send: this key is not the splitter\'s governance');
    return;
  }
  if (plan) {
    console.log(`\nwould send setCushion(${target}) from ${account.address}`);
    console.log('plan only; re-run with --execute');
    return;
  }
  await sendRaw(web3, account, { to: splitterAddress, data, gas: 200_000 });
  const after = await splitter.methods.cushion().call();
  assert.ok(same(after, target), `the cushion reads ${after} after the call`);
  console.log(`\ncushion wired: ${after}; claimCushion now pays the CUSHION lane to it`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
