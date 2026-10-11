/**
 * Gas profile of the main flows on the local ZVM.
 *
 * Execution gas only: no 21,000 intrinsic cost, no calldata, and nothing for
 * the ML-DSA-87 envelope. Use `npm run interact` for total transaction gas
 * against a real node.
 *
 * Primary issuance goes through QurrlPhaseMinter (the shipped rows, wallet limits
 * lifted so one account can mint repeatedly), with an ArkPhaseDouble standing in
 * for contracts/core's ArkPhase.
 */
const {
  deployQurrl,
  seedFor,
  commitmentFor,
  genesisLeaf,
  acornLeaf,
  merkleTree,
  ACCOUNTS,
  role,
  DAY,
} = require('../test/fixtures');
const { PHASE_ROWS, phaseRowTuple } = require('./collection');

const ROW_TYPE = 'tuple(uint32,uint32,uint32,uint32,uint32,uint32,uint128,uint128,uint128,uint128,uint16,uint32,uint32,uint128)[5]';
const ROWS = PHASE_ROWS.map((r) => ({ ...r, walletLimit: 0 }));
const rows = [];

function record(label, res) {
  rows.push([label, Number(res.gasUsed)]);
  return res;
}

async function deployWithMinter() {
  const fx = await deployQurrl();
  const arkPhase = await fx.chain.deploy('ArkPhaseDouble');
  const minter = await fx.chain.deploy(
    'QurrlPhaseMinter',
    ['address', 'address', 'address', 'address', 'address', 'address', ROW_TYPE],
    [fx.nft.address, fx.registry.address, arkPhase.address, ACCOUNTS.admin, ACCOUNTS.admin, ACCOUNTS.admin, ROWS.map(phaseRowTuple)],
  );
  for (const r of ['MINTER_ROLE', 'SEASON_ADMIN_ROLE']) {
    await fx.nft.send('grantRole', [role(r), minter.address], { from: ACCOUNTS.admin });
  }
  return { ...fx, arkPhase, minter };
}

async function commit(fx, seasonId) {
  const revealAt = Number(fx.chain.timestamp) + 30 * DAY;
  return fx.registry.send('commitSeed', [seasonId, commitmentFor(seasonId, seedFor(seasonId)), revealAt], { from: ACCOUNTS.curator });
}

async function toReveal(fx, seasonId) {
  const notBefore = Number(await fx.registry.call('revealNotBeforeOf', [seasonId]));
  const now = Number(fx.chain.timestamp);
  if (now < notBefore) fx.chain.advanceTime(notBefore - now);
  return fx.registry.send('revealSeed', [seasonId, seedFor(seasonId)], { from: ACCOUNTS.curator });
}

async function main() {
  const fx = await deployWithMinter();
  const fee = BigInt(PHASE_ROWS[1].mintFee);

  /* Phase 0: genesis list, depth-2 proofs. */
  const genesis = merkleTree([ACCOUNTS.alice, ACCOUNTS.bob, ACCOUNTS.mallory, ACCOUNTS.treasurer].map(genesisLeaf));
  record('setGenesis', await fx.minter.send('setGenesis', [genesis.root, 3], { from: ACCOUNTS.admin }));
  record('commitSeed', await commit(fx, 1));
  record('openPhase (phase 0)', await fx.minter.send('openPhase', [], { from: ACCOUNTS.bob }));
  const aliceProof = genesis.proof(genesisLeaf(ACCOUNTS.alice));
  record('mintGenesis x1 (d2, cold)', await fx.minter.send('mintGenesis', [1, aliceProof], { from: ACCOUNTS.alice }));
  record('mintGenesis x2 (d2, warm)', await fx.minter.send('mintGenesis', [2, aliceProof], { from: ACCOUNTS.alice }));
  record('revealSeed', await toReveal(fx, 1));

  /* Phase 1: Acorn and QRL pools, then fusion from the season's reveal. */
  await fx.arkPhase.send('set', [1]);
  await commit(fx, 2);
  record('openPhase (phase 1)', await fx.minter.send('openPhase', [], { from: ACCOUNTS.bob }));

  const earned = 10 * PHASE_ROWS[1].reqPts;
  const acorns = merkleTree([acornLeaf(ACCOUNTS.alice, earned), acornLeaf(ACCOUNTS.bob, earned)]);
  record('postAcornRoot', await fx.minter.send('postAcornRoot', [1, acorns.root], { from: ACCOUNTS.admin }));
  const acornProof = acorns.proof(acornLeaf(ACCOUNTS.alice, earned));
  record('mintAcorn x1 (d1, cold)', await fx.minter.send('mintAcorn', [1, earned, acornProof], { from: ACCOUNTS.alice }));
  record('mintAcorn x1 (d1, warm)', await fx.minter.send('mintAcorn', [1, earned, acornProof], { from: ACCOUNTS.alice }));

  record('mintQrl x1 (cold)', await fx.minter.send('mintQrl', [1], { from: ACCOUNTS.alice, value: fee }));
  record('mintQrl x1 (warm)', await fx.minter.send('mintQrl', [1], { from: ACCOUNTS.alice, value: fee }));
  record('mintQrl x5', await fx.minter.send('mintQrl', [5], { from: ACCOUNTS.alice, value: fee * 5n }));
  record('setMintFee (owner)', await fx.minter.send('setMintFee', [fee * 2n], { from: ACCOUNTS.admin }));

  await toReveal(fx, 2);
  const fusionFee = BigInt(PHASE_ROWS[1].fusionFee);
  record('fuse (drawn, derived parents)', await fx.nft.send('fuse', [1, 2, [2, 2, 2, 2, 2, 2], 0, []], { from: ACCOUNTS.alice, value: fusionFee }));
  const heir = Number(await fx.nft.call('totalMinted'));
  record('fuse (drawn, refinement)', await fx.nft.send('fuse', [heir, 3, [2, 2, 2, 2, 2, 2], 0, []], { from: ACCOUNTS.alice, value: fusionFee }));
  record('withdraw', await fx.nft.send('withdraw', [ACCOUNTS.bob], { from: ACCOUNTS.treasurer }));

  console.log('\n%s %s', 'flow'.padEnd(28), 'gas'.padStart(9));
  for (const [label, used] of rows) console.log('%s %s', label.padEnd(28), String(used).padStart(9));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
