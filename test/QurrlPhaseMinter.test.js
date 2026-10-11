/**
 * QurrlPhaseMinter: one season per ecosystem phase, the phase 0 whitelist set once,
 * the Acorn pool (points spent) and the QRL pool side by side, the owner's bounded
 * tuning of the phase in force, and governance's keyed compare-and-swap.
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  deployQurrl,
  revealSeason,
  seedFor,
  commitmentFor,
  genesisLeaf,
  acornLeaf,
  paramKey,
  merkleTree,
  expectRevert,
  ACCOUNTS,
  role,
  DAY,
} = require('./fixtures');

const ONE = 10n ** 18n;
const ZERO = '0x' + '00'.repeat(20);
const ZERO32 = '0x' + '00'.repeat(32);

const GOVERNANCE = ACCOUNTS.treasurer;
const OWNER = ACCOUNTS.seasonAdmin;
const ORACLE = ACCOUNTS.curator;
const DEPLOYER = ACCOUNTS.admin;

const ROW =
  'tuple(uint32 acornCap,uint32 qrlCap,uint32 fusionCap,uint32 reqPts,uint32 reqPtsMin,uint32 reqPtsMax,' +
  'uint128 mintFee,uint128 mintFeeMin,uint128 mintFeeMax,uint128 fusionFee,uint16 walletLimit,' +
  'uint32 mintDuration,uint32 fusionDuration,uint128 lockBaseFee)';

/** QuantumArk-Phases.md §5, written out again here rather than imported from scripts/. */
const ROWS = [
  [105, 0, 0, 0, 0, 0, 0n, 0n, 0n, 0n, 0, 30 * DAY, 0, 0n],
  [525, 210, 210, 2000, 1000, 4000, ONE, ONE / 2n, 2n * ONE, 0n, 2, 30 * DAY, 30 * DAY, ONE],
  [735, 840, 630, 1500, 750, 3000, 2n * ONE, ONE, 4n * ONE, ONE / 2n, 3, 30 * DAY, 30 * DAY, ONE],
  [630, 1575, 1050, 1000, 500, 2000, 3n * ONE, (3n * ONE) / 2n, 6n * ONE, ONE / 2n, 5, 30 * DAY, 30 * DAY, ONE],
  [315, 2415, 1260, 1000, 500, 2000, 4n * ONE, 2n * ONE, 8n * ONE, ONE / 2n, 10, 30 * DAY, 30 * DAY, ONE],
];

async function deployMinter(fx, rows = ROWS) {
  return fx.chain.deploy(
    'QurrlPhaseMinter',
    ['address', 'address', 'address', 'address', 'address', 'address', `${ROW}[5]`],
    [fx.nft.address, fx.registry.address, fx.phase.address, GOVERNANCE, OWNER, ORACLE, rows],
    DEPLOYER,
  );
}

async function fixture() {
  const fx = await deployQurrl();
  fx.phase = await fx.chain.deploy('ArkPhaseDouble');
  fx.minter = await deployMinter(fx);
  await fx.nft.send('grantRole', [role('MINTER_ROLE'), fx.minter.address], { from: ACCOUNTS.admin });
  await fx.nft.send('grantRole', [role('SEASON_ADMIN_ROLE'), fx.minter.address], { from: ACCOUNTS.admin });
  return fx;
}

const now = (fx) => Number(fx.chain.timestamp);

/** The curator commits season `seasonId`, revealable `revealIn` seconds from now. */
async function commit(fx, seasonId, revealIn = 30 * DAY) {
  const at = now(fx) + revealIn;
  await fx.registry.send('commitSeed', [seasonId, commitmentFor(seasonId, seedFor(seasonId)), at], {
    from: ACCOUNTS.curator,
  });
  return at;
}

/** Whitelist alice and bob, two each, and open phase 0. */
async function openGenesis(fx) {
  const tree = merkleTree([genesisLeaf(ACCOUNTS.alice), genesisLeaf(ACCOUNTS.bob)]);
  await fx.minter.send('setGenesis', [tree.root, 2], { from: DEPLOYER });
  await commit(fx, 1);
  await fx.minter.send('openPhase', [], { from: ACCOUNTS.mallory });
  return tree;
}

/** Close phase 0, move the ecosystem to phase 1, open the collection's phase 1. */
async function openPhaseOne(fx) {
  await openGenesis(fx);
  fx.chain.advanceTime(30 * DAY + 1);
  await fx.phase.send('set', [1]);
  const revealAt = await commit(fx, 2);
  await fx.minter.send('openPhase', []);
  return revealAt;
}

async function postAcorns(fx, epoch, balances) {
  const leaves = balances.map(([who, earned]) => acornLeaf(who, earned));
  const tree = merkleTree(leaves);
  await fx.minter.send('postAcornRoot', [epoch, tree.root], { from: ORACLE });
  return { tree, proof: (who, earned) => tree.proof(acornLeaf(who, earned)) };
}

const field = (row, name) => row[name];

/* ------------------------------------------------------------------ */

test('the rows given at deployment read back, and a row outside its own bounds is refused', async () => {
  const fx = await fixture();
  const row2 = await fx.minter.call('rowOf', [2]);
  assert.equal(field(row2, 'acornCap'), 735n);
  assert.equal(field(row2, 'qrlCap'), 840n);
  assert.equal(field(row2, 'reqPts'), 1500n);
  assert.equal(field(row2, 'mintFee'), 2n * ONE);
  await expectRevert(fx.minter.call('rowOf', [5]), 'InvalidRow');

  const bad = ROWS.map((r) => r.slice());
  bad[1][3] = 5000; // reqPts above reqPtsMax
  await assert.rejects(deployMinter(fx, bad), /deploy QurrlPhaseMinter failed/);

  const over = ROWS.map((r) => r.slice());
  over[4][1] = 2520; // 105 more than the ceiling allows
  await assert.rejects(deployMinter(fx, over), /deploy QurrlPhaseMinter failed/);
});

test('phase 0 needs the whitelist, set once, by the deployer, before the phase opens', async () => {
  const fx = await fixture();
  await commit(fx, 1);
  await expectRevert(fx.minter.send('openPhase', []), 'GenesisNotSet');

  const tree = merkleTree([genesisLeaf(ACCOUNTS.alice)]);
  await expectRevert(fx.minter.send('setGenesis', [tree.root, 1], { from: ACCOUNTS.mallory }), 'NotDeployer');
  await expectRevert(fx.minter.send('setGenesis', [ZERO32, 1], { from: DEPLOYER }), 'InvalidGenesis');
  await expectRevert(fx.minter.send('setGenesis', [tree.root, 0], { from: DEPLOYER }), 'InvalidGenesis');
  await expectRevert(fx.minter.send('setGenesis', [tree.root, 106], { from: DEPLOYER }), 'InvalidGenesis');

  await fx.minter.send('setGenesis', [tree.root, 1], { from: DEPLOYER });
  await expectRevert(fx.minter.send('setGenesis', [tree.root, 2], { from: DEPLOYER }), 'GenesisAlreadySet');
});

test('opening phase 0 configures season 1 from row 0 and cuts the window at the reveal', async () => {
  const fx = await fixture();
  const tree = merkleTree([genesisLeaf(ACCOUNTS.alice)]);
  await fx.minter.send('setGenesis', [tree.root, 1], { from: DEPLOYER });
  await expectRevert(fx.minter.send('openPhase', []), 'SeedNotCommitted');

  const revealAt = await commit(fx, 1, 10 * DAY); // earlier than now + mintDuration
  const opened = now(fx);
  await fx.minter.send('openPhase', [], { from: ACCOUNTS.bob });

  const season = await fx.nft.call('seasonView', [1]);
  assert.equal(season.config.primaryCap, 105n);
  assert.equal(season.config.fusionCap, 0n);
  assert.equal(season.config.opensAt, BigInt(opened));
  assert.equal(season.config.closesAt, BigInt(revealAt));
  assert.equal(await fx.nft.call('activeSeason'), 1n);
  const [isOpen, phase] = await fx.minter.call('currentPhase');
  assert.equal(isOpen, true);
  assert.equal(phase, 0n);
});

test('phase 0: whitelisted addresses mint free up to their allowance; the pools are closed', async () => {
  const fx = await fixture();
  const tree = await openGenesis(fx);

  await fx.minter.send('mintGenesis', [2, tree.proof(genesisLeaf(ACCOUNTS.alice))], { from: ACCOUNTS.alice });
  assert.equal(await fx.nft.call('balanceOf', [ACCOUNTS.alice]), 2n);
  await expectRevert(
    fx.minter.send('mintGenesis', [1, tree.proof(genesisLeaf(ACCOUNTS.alice))], { from: ACCOUNTS.alice }),
    'WalletLimitReached',
  );
  await expectRevert(
    fx.minter.send('mintGenesis', [1, tree.proof(genesisLeaf(ACCOUNTS.bob))], { from: ACCOUNTS.mallory }),
    'InvalidMerkleProof',
  );
  await expectRevert(fx.minter.send('mintAcorn', [1, 5000, []], { from: ACCOUNTS.alice }), 'WrongPhase');
  await expectRevert(fx.minter.send('mintQrl', [1], { from: ACCOUNTS.alice }), 'PoolSoldOut');
});

test('a phase opens only once the ecosystem has reached it and the previous season has closed', async () => {
  const fx = await fixture();
  await openGenesis(fx);
  await commit(fx, 2, 60 * DAY);

  await expectRevert(fx.minter.send('openPhase', []), 'PhaseNotReached');
  await fx.phase.send('set', [1]);
  await expectRevert(fx.minter.send('openPhase', []), 'PreviousPhaseOpen');

  fx.chain.advanceTime(30 * DAY);
  await fx.minter.send('openPhase', []);
  const season = await fx.nft.call('seasonView', [2]);
  assert.equal(season.config.primaryCap, 735n);
  assert.equal(season.config.fusionCap, 210n);
  assert.equal(season.config.fusionClosesAt - season.config.fusionOpensAt, BigInt(30 * DAY));
  assert.equal(await fx.nft.call('activeSeason'), 2n);
});

test('an ecosystem that jumps ahead is caught up one season at a time', async () => {
  const fx = await fixture();
  await openGenesis(fx);
  fx.chain.advanceTime(30 * DAY + 1);
  await fx.phase.send('set', [3]); // a Q-Day declaration while the collection is in phase 0

  await commit(fx, 2);
  await fx.minter.send('openPhase', []);
  const [, phase] = await fx.minter.call('currentPhase');
  assert.equal(phase, 1n, 'phase 1 opens first, not phase 3');
});

test('Acorn pool: points are spent per token against the earned balance in the posted root', async () => {
  const fx = await fixture();
  await openPhaseOne(fx);

  await expectRevert(fx.minter.send('postAcornRoot', [1, ZERO32], { from: ACCOUNTS.mallory }), 'NotAcornOracle');
  const a = await postAcorns(fx, 1, [[ACCOUNTS.alice, 5000], [ACCOUNTS.bob, 1000]]);
  await expectRevert(fx.minter.send('postAcornRoot', [1, ZERO32], { from: ORACLE }), 'AcornEpochNotNewer');

  await fx.minter.send('mintAcorn', [2, 5000, a.proof(ACCOUNTS.alice, 5000)], { from: ACCOUNTS.alice });
  assert.equal(await fx.minter.call('acornsSpent', [ACCOUNTS.alice]), 4000n);
  assert.equal(await fx.nft.call('balanceOf', [ACCOUNTS.alice]), 2n);

  await expectRevert(
    fx.minter.send('mintAcorn', [1, 5000, a.proof(ACCOUNTS.alice, 5000)], { from: ACCOUNTS.alice }),
    'InsufficientAcorns',
  );
  await expectRevert(
    fx.minter.send('mintAcorn', [1, 1000, a.proof(ACCOUNTS.bob, 1000)], { from: ACCOUNTS.bob }),
    'InsufficientAcorns',
  );
  // Claiming a balance the root does not hold fails the proof.
  await expectRevert(
    fx.minter.send('mintAcorn', [1, 9000, a.proof(ACCOUNTS.alice, 5000)], { from: ACCOUNTS.alice }),
    'InvalidMerkleProof',
  );

  // A later epoch raises alice's earned total; only the difference over what she spent is usable.
  const b = await postAcorns(fx, 2, [[ACCOUNTS.alice, 7000], [ACCOUNTS.bob, 1000]]);
  await fx.minter.send('mintAcorn', [1, 7000, b.proof(ACCOUNTS.alice, 7000)], { from: ACCOUNTS.alice });
  assert.equal(await fx.minter.call('acornsSpent', [ACCOUNTS.alice]), 6000n);
  const [acorn, qrl] = await fx.minter.call('poolMinted', [1]);
  assert.equal(acorn, 3n);
  assert.equal(qrl, 0n);
});

test('QRL pool: exact fee, per-wallet limit, and the value lands in the collection', async () => {
  const fx = await fixture();
  await openPhaseOne(fx);

  const before = await fx.chain.balanceOf(fx.nft.address);
  await expectRevert(fx.minter.send('mintQrl', [2], { from: ACCOUNTS.bob, value: ONE }), 'IncorrectPayment');
  await fx.minter.send('mintQrl', [2], { from: ACCOUNTS.bob, value: 2n * ONE });
  assert.equal(await fx.nft.call('balanceOf', [ACCOUNTS.bob]), 2n);
  assert.equal((await fx.chain.balanceOf(fx.nft.address)) - before, 2n * ONE);
  assert.equal(await fx.minter.call('qrlMintedBy', [1, ACCOUNTS.bob]), 2n);

  await expectRevert(fx.minter.send('mintQrl', [1], { from: ACCOUNTS.bob, value: ONE }), 'WalletLimitReached');
});

test('the pools stop at the end of the mint window, and the season fuses its own tokens after the reveal', async () => {
  const fx = await fixture();
  const revealAt = await openPhaseOne(fx);
  await fx.minter.send('mintQrl', [2], { from: ACCOUNTS.bob, value: 2n * ONE });

  fx.chain.advanceTime(revealAt - now(fx));
  await expectRevert(fx.minter.send('mintQrl', [1], { from: ACCOUNTS.alice, value: ONE }), 'SeasonNotOpen');

  await revealSeason(fx, 2);
  const first = (await fx.nft.call('totalMinted')) - 1n;
  await fx.nft.send('fuse', [first, first + 1n, [2, 2, 2, 2, 2, 2], 0, []], { from: ACCOUNTS.bob });
  assert.equal(await fx.nft.call('totalBurned'), 2n);
});

test('owner: tunes only the phase in force, inside its bounds, once per cooldown', async () => {
  const fx = await fixture();
  await expectRevert(fx.minter.send('setReqPts', [1500], { from: OWNER }), 'NoPhaseOpen');
  await openPhaseOne(fx);

  await expectRevert(fx.minter.send('setReqPts', [1500], { from: ACCOUNTS.mallory }), 'NotOwner');
  await expectRevert(fx.minter.send('setReqPts', [999], { from: OWNER }), 'OutOfBounds');
  await expectRevert(fx.minter.send('setReqPts', [4001], { from: OWNER }), 'OutOfBounds');
  await fx.minter.send('setReqPts', [1500], { from: OWNER });
  assert.equal(field(await fx.minter.call('rowOf', [1]), 'reqPts'), 1500n);
  await expectRevert(fx.minter.send('setReqPts', [1600], { from: OWNER }), 'OwnerCooldown');

  await expectRevert(fx.minter.send('setMintFee', [3n * ONE], { from: OWNER }), 'OutOfBounds');
  await fx.minter.send('setMintFee', [ONE / 2n], { from: OWNER });
  assert.equal(field(await fx.minter.call('rowOf', [1]), 'mintFee'), ONE / 2n);
  assert.equal(field(await fx.minter.call('rowOf', [2]), 'mintFee'), 2n * ONE, 'the next phase is untouched');

  fx.chain.advanceTime(7 * DAY);
  await fx.minter.send('setReqPts', [1600], { from: OWNER });
});

test('governance: keyed compare-and-swap, bounds re-checked, opened cells closed', async () => {
  const fx = await fixture();
  await openGenesis(fx);

  const key = await fx.minter.call('keyOf', [3, 2]);
  assert.equal(key, paramKey('reqPts', 2), 'the on-chain key matches the off-chain one');

  const change = (k, expected, value) => [[k, expected, value]];
  await expectRevert(
    fx.minter.send('setParamsDiff', [change(paramKey('reqPts', 2), 1500, 1800)], { from: OWNER }),
    'NotGovernance',
  );
  await expectRevert(
    fx.minter.send('setParamsDiff', [change(paramKey('reqPts', 2), 1400, 1800)], { from: GOVERNANCE }),
    'ParamMismatch',
  );
  await expectRevert(
    fx.minter.send('setParamsDiff', [change(paramKey('reqPts', 9), 0, 1)], { from: GOVERNANCE }),
    'UnknownKey',
  );
  await expectRevert(
    fx.minter.send('setParamsDiff', [change(paramKey('reqPts', 2), 1500, 3500)], { from: GOVERNANCE }),
    'InvalidRow',
  );
  await expectRevert(
    fx.minter.send('setParamsDiff', [change(paramKey('acornCap', 0), 105, 210)], { from: GOVERNANCE }),
    'PhaseAlreadyOpened',
  );

  // Raising the bound and the value in one draft passes, because rows are checked after the whole diff.
  await fx.minter.send(
    'setParamsDiff',
    [[
      [paramKey('reqPtsMax', 2), 3000, 4000],
      [paramKey('reqPts', 2), 1500, 3500],
    ]],
    { from: GOVERNANCE },
  );
  const row2 = await fx.minter.call('rowOf', [2]);
  assert.equal(field(row2, 'reqPts'), 3500n);
  assert.equal(field(row2, 'reqPtsMax'), 4000n);
});

test('governance moves itself in two steps and replaces the owner and the Acorn oracle', async () => {
  const fx = await fixture();
  await expectRevert(fx.minter.send('setOwner', [ACCOUNTS.bob], { from: OWNER }), 'NotGovernance');
  await fx.minter.send('setOwner', [ACCOUNTS.bob], { from: GOVERNANCE });
  assert.equal((await fx.minter.call('owner')).toLowerCase(), ACCOUNTS.bob);
  await fx.minter.send('setAcornOracle', [ACCOUNTS.alice], { from: GOVERNANCE });
  assert.equal((await fx.minter.call('acornOracle')).toLowerCase(), ACCOUNTS.alice);
  await expectRevert(fx.minter.send('setOwner', [ZERO], { from: GOVERNANCE }), 'ZeroAddress');

  await fx.minter.send('proposeGovernance', [ACCOUNTS.alice], { from: GOVERNANCE });
  await expectRevert(fx.minter.send('acceptGovernance', [], { from: ACCOUNTS.bob }), 'NotPending');
  await fx.minter.send('acceptGovernance', [], { from: ACCOUNTS.alice });
  assert.equal((await fx.minter.call('governance')).toLowerCase(), ACCOUNTS.alice);
});

test('after five phases there is nothing left to open', async () => {
  const fx = await fixture();
  await openGenesis(fx);
  await fx.phase.send('set', [4]);
  for (let season = 2; season <= 5; season += 1) {
    const last = await fx.nft.call('seasonView', [season - 1]);
    const endsAt = Number(last.config.fusionCap > 0n ? last.config.fusionClosesAt : last.config.closesAt);
    fx.chain.advanceTime(endsAt - now(fx) + 1);
    await commit(fx, season);
    await fx.minter.send('openPhase', []);
  }
  assert.equal(await fx.nft.call('allocatedSupply'), 10500n);
  const last = await fx.nft.call('seasonView', [5]);
  fx.chain.advanceTime(Number(last.config.fusionClosesAt) - now(fx) + 1);
  await expectRevert(fx.minter.send('openPhase', []), 'AllPhasesOpened');
});
