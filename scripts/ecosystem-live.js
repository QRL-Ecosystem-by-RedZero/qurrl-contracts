/**
 * Qurrl's side of the ecosystem links, on a live private network (2026-10-13:
 * QuantumArk-Treasury-Flows.md §7, QuantumArk-Phases.md §5, core ArkGovTables).
 * Run after `npm run deploy` (with ARK_PHASE_ADDRESS and TREASURY_ROUTER_ADDRESS
 * from the network's governance record), `npm run seasons -- --genesis` with
 * the Phase 0 root, `--commit 0` and `--open`, and, for the governance rows,
 * `npm run handover -- --execute` with GOVERNANCE_ADDRESS = the ArkTimelock.
 *
 *   1  Phase 0: the deployer mints its genesis token with the proof from
 *      scripts/phase0/select-phase0.js (--selection <file>), once.
 *   2  Revenue to the Treasury: a secondary-sale fee paid to the splitter
 *      (its QURRL_FEES lane), `claimTreasury` pushes the treasury share to the
 *      router on TREASURY_QURRL_SECONDARY; the router's lane total grows.
 *   3  Governance rows: the timelock knows the minter's keys (14 days) and the
 *      splitter's `setCushionBps` (30 days, objectable); after the handover the
 *      minter, splitter and budget answer to the timelock.
 *
 *   node scripts/ecosystem-live.js --governance <governance record json> [--selection phase0_selection.json] [--record private]
 *
 * Each step prints PASS or SKIP with its reason; any FAIL exits 1.
 */
const fs = require('fs');
const { keccak256, toUtf8Bytes, AbiCoder } = require('ethers');
const { connect, contractAt, sendRaw, loadDeployment, toHex } = require('./qrl');

const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i === -1 ? null : process.argv[i + 1];
};
const same = (a, b) => toHex(a) === toHex(b);
const SECONDARY = keccak256(toUtf8Bytes('quantumark.lane.treasury.qurrl-secondary.v1'));
const TIMELOCK = [
  { type: 'function', name: 'delayFor', inputs: [{ name: 'payload', type: 'bytes' }], outputs: [{ type: 'uint64' }], stateMutability: 'pure' },
  { type: 'function', name: 'ruleFor', inputs: [{ name: 'payload', type: 'bytes' }], outputs: [{ type: 'uint64' }, { type: 'bool' }], stateMutability: 'pure' },
];
const LANES = [{ type: 'function', name: 'laneTotal', inputs: [{ name: 'lane', type: 'bytes32' }], outputs: [{ type: 'uint256' }], stateMutability: 'view' }];

let failed = 0;
const pass = (what, detail = '') => console.log(`PASS  ${what}${detail ? `  (${detail})` : ''}`);
const skip = (what, why) => console.log(`SKIP  ${what}: ${why}`);
const fail = (what, detail = '') => {
  failed += 1;
  console.log(`FAIL  ${what}${detail ? `  (${detail})` : ''}`);
};
const check = (cond, what, detail) => (cond ? pass(what, detail) : fail(what, detail));

async function main() {
  const { web3, account } = connect();
  const dep = loadDeployment(arg('--record') || 'private');
  const c = dep.contracts;
  const govFile = arg('--governance');
  const gov = govFile ? JSON.parse(fs.readFileSync(govFile, 'utf8')).addresses : null;
  const me = account.address;

  /* 1. Phase 0 */
  const minter = contractAt(web3, 'QurrlPhaseMinter', c.QurrlPhaseMinter);
  const selFile = arg('--selection');
  if (!selFile) skip('Phase 0 genesis mint', 'no --selection file');
  else {
    const sel = JSON.parse(fs.readFileSync(selFile, 'utf8'));
    const mine = sel.wallets.find((w) => same(w.address, me));
    const root = await minter.methods.genesisRoot().call();
    if (!mine) skip('Phase 0 genesis mint', 'the deployer is not in the selection');
    else if (String(root).toLowerCase() !== String(sel.root).toLowerCase()) fail('Phase 0 root on chain is the selection\'s root', `${root} vs ${sel.root}`);
    else if (Number(await minter.methods.genesisMintedBy(me).call()) >= 1) pass('Phase 0 genesis token already minted by the deployer');
    else {
      const nft = contractAt(web3, 'QurrlNFT', c.QurrlNFT);
      const before = BigInt(await nft.methods.balanceOf(me).call());
      await sendRaw(web3, account, { to: c.QurrlPhaseMinter, data: minter.methods.mintGenesis(1, mine.proof).encodeABI(), gas: 900_000 });
      check(BigInt(await nft.methods.balanceOf(me).call()) === before + 1n, 'Phase 0: a selected wallet mints exactly one genesis token', `basket ${mine.basket}`);
    }
  }

  /* 2. Revenue to the Treasury */
  const splitter = contractAt(web3, 'QurrlRevenueSplitter', c.QurrlRevenueSplitter);
  const treasury = await splitter.methods.treasury().call();
  if (/^(0x|Q)0+$/i.test(String(treasury))) skip('splitter -> ArkTreasuryRouter', 'the splitter has no treasury wired (deploy with TREASURY_ROUTER_ADDRESS)');
  else {
    if (gov && gov.ArkTreasuryRouter) check(same(treasury, gov.ArkTreasuryRouter), 'the splitter\'s treasury is the network\'s ArkTreasuryRouter', String(treasury));
    const router = new web3.qrl.Contract(LANES, treasury);
    const before = BigInt(await router.methods.laneTotal(SECONDARY).call());
    const fee = 10n ** 18n;
    await sendRaw(web3, account, { to: c.QurrlRevenueSplitter, data: '0x', value: fee, gas: 300_000 });
    await sendRaw(web3, account, { to: c.QurrlRevenueSplitter, data: splitter.methods.claimTreasury().encodeABI(), gas: 600_000 });
    const after = BigInt(await router.methods.laneTotal(SECONDARY).call());
    check(after - before === (fee * 9n) / 10n, 'a secondary fee reaches the router on TREASURY_QURRL_SECONDARY, 90% after the creator', `${after - before} wei`);
  }

  /* 3. Governance rows */
  if (!gov || !gov.ArkTimelock) skip('timelock rows', 'no --governance record');
  else {
    const tl = new web3.qrl.Contract(TIMELOCK, gov.ArkTimelock);
    const coder = AbiCoder.defaultAbiCoder();
    const diff = '0x24baa4c7' + coder.encode(['tuple(bytes32,uint256,uint256)[]'], [[[keccak256(toUtf8Bytes('reqPts@1')), 2000, 2100]]]).slice(2);
    check(BigInt(await tl.methods.delayFor(diff).call()) === 14n * BigInt(await dayOf(web3, gov)), 'the timelock schedules a minter key (reqPts@1) at 14 profile-days');
    const cushionBps = splitter.methods.setCushionBps(3500).encodeABI();
    const rule = await tl.methods.ruleFor(cushionBps).call();
    check(rule[1] === true, 'setCushionBps is objectable at S1 (value transfer)');
    for (const [name, addr] of [['QurrlPhaseMinter', c.QurrlPhaseMinter], ['QurrlRevenueSplitter', c.QurrlRevenueSplitter], ['QurrlBudget', c.QurrlBudget]]) {
      if (!addr) {
        skip(`${name} governance`, 'not in this deployment');
        continue;
      }
      const g = await contractAt(web3, name, addr).methods.governance().call();
      if (same(g, gov.ArkTimelock)) pass(`${name} answers to the ArkTimelock`);
      else skip(`${name} governance`, `still ${g}; run npm run handover -- --execute with GOVERNANCE_ADDRESS=${gov.ArkTimelock}`);
    }
  }

  if (failed) {
    console.log(`\n${failed} check(s) failed`);
    process.exit(1);
  }
  console.log('\necosystem-live: done');
}

/** The timelock's profile day: GRACE_PERIOD is fourteen of them. */
async function dayOf(web3, gov) {
  const abi = [{ type: 'function', name: 'GRACE_PERIOD', inputs: [], outputs: [{ type: 'uint64' }], stateMutability: 'view' }];
  return BigInt(await new web3.qrl.Contract(abi, gov.ArkTimelock).methods.GRACE_PERIOD().call()) / 14n;
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
