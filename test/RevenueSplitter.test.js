/**
 * QurrlRevenueSplitter: the 10 / cushion / treasury division, the pull-based
 * claims, the Q-Day freeze, and the one governed number.
 */
const { test, describe, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes } = require('ethers');
const { deployQurrl, openSeason, mintTo, expectRevert, ACCOUNTS, role } = require('./fixtures');

const ONE = 10n ** 18n;
const ZERO = '0x' + '00'.repeat(20);
const lane = (n) => keccak256(toUtf8Bytes(`quantumark.lane.${n}.v1`));
const QURRL_FEES = lane('qurrl.fees');

const CREATOR = ACCOUNTS.alice;
const GOVERNANCE = ACCOUNTS.treasurer;
const BUYER = ACCOUNTS.bob;

async function fixture({ qday = true, wire = true } = {}) {
  const fx = await deployQurrl();
  const { chain, nft } = fx;
  fx.oracle = await chain.deploy('FrozenDouble');
  fx.treasury = await chain.deploy('SplitterSink');
  fx.cushion = await chain.deploy('SplitterSink');
  fx.splitter = await chain.deploy(
    'QurrlRevenueSplitter',
    ['address', 'address', 'address', 'address', 'uint16'],
    [nft.address, CREATOR, GOVERNANCE, qday ? fx.oracle.address : ZERO, 3500],
  );
  await nft.send('grantRole', [role('TREASURER_ROLE'), fx.splitter.address], { from: ACCOUNTS.admin });
  if (wire) {
    await fx.splitter.send('setTreasury', [fx.treasury.address], { from: GOVERNANCE });
    await fx.splitter.send('setCushion', [fx.cushion.address], { from: GOVERNANCE });
  }
  await openSeason(fx, 1, { primaryCap: 210 });
  return fx;
}

/** Mints `n` to the buyer with a 1 QRL fee each forwarded, so the collection holds n QRL. */
async function mint(fx, n) {
  await mintTo(fx, BUYER, n, { value: BigInt(n) * ONE });
}

describe('QurrlRevenueSplitter: mint revenue', () => {
  let fx;
  beforeEach(async () => {
    fx = await fixture();
  });

  test('sweep divides 10 / 35 / 55 and leaves the collection empty', async () => {
    await mint(fx, 100);
    const res = await fx.splitter.send('sweep', [], { from: ACCOUNTS.mallory });
    assert.equal(await fx.chain.balanceOf(fx.nft.address), 0n);
    assert.equal(await fx.splitter.call('creatorOwed'), 10n * ONE);
    assert.equal(await fx.splitter.call('cushionOwed'), 35n * ONE);
    assert.equal(await fx.splitter.call('treasuryPrimaryOwed'), 55n * ONE);
    assert.equal(fx.splitter.events(res, 'Swept')[0].args.amount, 100n * ONE);
  });

  test('the ledgers add up to what was swept, whatever the rounding', async () => {
    const wei = 1_000_000_007n;
    const odd = await fixture();
    fx = odd;
    await mintTo(odd, BUYER, 1, { value: wei });
    await fx.splitter.send('sweep');
    const sum =
      (await fx.splitter.call('creatorOwed')) +
      (await fx.splitter.call('cushionOwed')) +
      (await fx.splitter.call('treasuryPrimaryOwed'));
    assert.equal(sum, wei);
    assert.equal(await fx.chain.balanceOf(fx.splitter.address), wei);
  });

  test('sweeping an empty collection does nothing and does not revert', async () => {
    const res = await fx.splitter.send('sweep');
    assert.equal(fx.splitter.events(res, 'Swept').length, 0);
  });

  test('claims pay each line to its own address, and a third party may trigger them', async () => {
    await mint(fx, 100);
    await fx.splitter.send('sweep');

    const before = await fx.chain.balanceOf(CREATOR);
    await fx.splitter.send('claimCreator', [], { from: ACCOUNTS.mallory });
    assert.equal((await fx.chain.balanceOf(CREATOR)) - before, 10n * ONE);

    await fx.splitter.send('claimTreasury');
    assert.equal(await fx.chain.balanceOf(fx.treasury.address), 55n * ONE);
    assert.equal(await fx.treasury.call('laneTotal', [lane('treasury.qurrl-primary')]), 55n * ONE);

    await fx.splitter.send('claimCushion');
    assert.equal(await fx.chain.balanceOf(fx.cushion.address), 35n * ONE);
    assert.equal(await fx.cushion.call('laneTotal', [lane('cushion')]), 35n * ONE);
    assert.equal(await fx.chain.balanceOf(fx.splitter.address), 0n);
  });

  test('a claim with nothing owed reverts', async () => {
    await expectRevert(fx.splitter.send('claimCreator'), 'NothingOwed');
    await expectRevert(fx.splitter.send('claimCushion'), 'NothingOwed');
  });

  test('a closed treasury lane blocks only the treasury line', async () => {
    await mint(fx, 100);
    await fx.splitter.send('sweep');
    await fx.treasury.send('setPrimaryOpen', [false]);

    await expectRevert(fx.splitter.send('claimTreasury'), 'NothingOwed');
    await fx.splitter.send('claimCreator');
    await fx.splitter.send('claimCushion');
    assert.equal(await fx.splitter.call('treasuryPrimaryOwed'), 55n * ONE, 'still owed');

    await fx.treasury.send('setPrimaryOpen', [true]);
    await fx.splitter.send('claimTreasury');
    assert.equal(await fx.splitter.call('treasuryPrimaryOwed'), 0n);
  });

  test('a cushion at its ceiling takes what fits and the rest stays owed', async () => {
    await mint(fx, 100);
    await fx.splitter.send('sweep');
    await fx.cushion.send('setCushionCeiling', [20n * ONE]);

    await fx.splitter.send('claimCushion');
    assert.equal(await fx.chain.balanceOf(fx.cushion.address), 20n * ONE);
    assert.equal(await fx.splitter.call('cushionOwed'), 15n * ONE);
    await expectRevert(fx.splitter.send('claimCushion'), 'NothingOwed');
  });
});

describe('QurrlRevenueSplitter: Q-Day', () => {
  let fx;
  beforeEach(async () => {
    fx = await fixture();
    await mint(fx, 100);
    await fx.splitter.send('sweep');
  });

  test('a freeze stops the creator and treasury claims and leaves the cushion open', async () => {
    await fx.oracle.send('set', [true]);
    await expectRevert(fx.splitter.send('claimCreator'), 'FrozenByQDay');
    await expectRevert(fx.splitter.send('claimTreasury'), 'FrozenByQDay');
    await fx.splitter.send('claimCushion');
    assert.equal(await fx.chain.balanceOf(fx.cushion.address), 35n * ONE);
  });

  test('intake continues during a freeze', async () => {
    await fx.oracle.send('set', [true]);
    await mint(fx, 10);
    await fx.splitter.send('sweep');
    assert.equal(await fx.splitter.call('creatorOwed'), 11n * ONE);
  });

  test('claims resume when the freeze lifts', async () => {
    await fx.oracle.send('set', [true]);
    await fx.oracle.send('set', [false]);
    await fx.splitter.send('claimCreator');
  });

  test('a deployment with no oracle is never frozen', async () => {
    const g = await fixture({ qday: false });
    await mint(g, 10);
    await g.splitter.send('sweep');
    await g.splitter.send('claimCreator');
  });
});

describe('QurrlRevenueSplitter: secondary fees', () => {
  let fx;
  beforeEach(async () => {
    fx = await fixture();
  });

  test('a plain transfer is a fee: 10% creator, 90% treasury', async () => {
    await fx.chain.execute(fx.splitter.address, ACCOUNTS.mallory, '0x', 100n * ONE);
    assert.equal(await fx.splitter.call('creatorOwed'), 10n * ONE);
    assert.equal(await fx.splitter.call('treasurySecondaryOwed'), 90n * ONE);
    assert.equal(await fx.splitter.call('laneTotal', [QURRL_FEES]), 100n * ONE);
  });

  test('the collection paying out on sweep is not counted as a fee', async () => {
    await mint(fx, 10);
    await fx.splitter.send('sweep');
    assert.equal(await fx.splitter.call('treasurySecondaryOwed'), 0n);
    assert.equal(await fx.splitter.call('laneTotal', [QURRL_FEES]), 0n);
  });

  test('fees reach the treasury on the secondary lane', async () => {
    await fx.chain.execute(fx.splitter.address, ACCOUNTS.mallory, '0x', 10n * ONE);
    await fx.splitter.send('claimTreasury');
    assert.equal(await fx.treasury.call('laneTotal', [lane('treasury.qurrl-secondary')]), 9n * ONE);
  });
});

describe('QurrlRevenueSplitter: governed cushion rate', () => {
  let fx;
  beforeEach(async () => {
    fx = await fixture();
  });

  test('only governance moves it', async () => {
    await expectRevert(fx.splitter.send('setCushionBps', [4000], { from: ACCOUNTS.mallory }), 'NotGovernance');
    await expectRevert(fx.splitter.send('setCushionBps', [4000], { from: CREATOR }), 'NotGovernance');
  });

  test('it stays inside 20% - 50% and moves at most 7.5 points a call', async () => {
    await expectRevert(fx.splitter.send('setCushionBps', [4300], { from: GOVERNANCE }), 'CushionStepTooLarge');
    await fx.splitter.send('setCushionBps', [4250], { from: GOVERNANCE });
    await fx.splitter.send('setCushionBps', [5000], { from: GOVERNANCE });
    await expectRevert(fx.splitter.send('setCushionBps', [5100], { from: GOVERNANCE }), 'CushionBpsOutOfRange');
    for (const v of [4250, 3500, 2750, 2000]) await fx.splitter.send('setCushionBps', [v], { from: GOVERNANCE });
    await expectRevert(fx.splitter.send('setCushionBps', [1900], { from: GOVERNANCE }), 'CushionBpsOutOfRange');
  });

  test('money already in the collection is divided at the old rate', async () => {
    await mint(fx, 100);
    await fx.splitter.send('setCushionBps', [4250], { from: GOVERNANCE });
    assert.equal(await fx.splitter.call('cushionOwed'), 35n * ONE, 'swept at 35%');
    await mint(fx, 100);
    await fx.splitter.send('sweep');
    assert.equal(await fx.splitter.call('cushionOwed'), 35n * ONE + (425n * ONE) / 10n);
  });

  test('the creator share is a constant with no setter', async () => {
    assert.equal(await fx.splitter.call('CREATOR_BPS'), 1000n);
    const setters = fx.splitter.iface.fragments.filter((f) => f.type === 'function' && /^set/.test(f.name));
    assert.deepEqual(setters.map((f) => f.name).sort(), ['setCushion', 'setCushionBps', 'setTreasury']);
  });
});

describe('QurrlRevenueSplitter: wiring and roles', () => {
  test('treasury and cushion are set once, by governance and not by the deployer', async () => {
    const fx = await fixture({ wire: false });
    await expectRevert(fx.splitter.send('setTreasury', [fx.treasury.address], { from: ACCOUNTS.mallory }), 'NotGovernance');
    await expectRevert(fx.splitter.send('setTreasury', [fx.treasury.address], { from: ACCOUNTS.admin }), 'NotGovernance');
    await fx.splitter.send('setTreasury', [fx.treasury.address], { from: GOVERNANCE });
    await expectRevert(fx.splitter.send('setTreasury', [fx.cushion.address], { from: GOVERNANCE }), 'AlreadyWired');
    await fx.splitter.send('setCushion', [fx.cushion.address], { from: GOVERNANCE });
    await expectRevert(fx.splitter.send('setCushion', [fx.treasury.address], { from: GOVERNANCE }), 'AlreadyWired');
  });

  test('an unwired cushion accumulates and can only be claimed once wired', async () => {
    const fx = await fixture({ wire: false });
    await mint(fx, 100);
    await fx.splitter.send('sweep');
    await expectRevert(fx.splitter.send('claimCushion'), 'NothingOwed');
    assert.equal(await fx.splitter.call('cushionOwed'), 35n * ONE);
    await fx.splitter.send('setCushion', [fx.cushion.address], { from: GOVERNANCE });
    await fx.splitter.send('claimCushion');
    assert.equal(await fx.chain.balanceOf(fx.cushion.address), 35n * ONE);
  });

  test('the creator rotates in two steps, and only the creator proposes', async () => {
    const fx = await fixture();
    await expectRevert(fx.splitter.send('proposeCreator', [ACCOUNTS.mallory], { from: ACCOUNTS.mallory }), 'NotCreator');
    await fx.splitter.send('proposeCreator', [ACCOUNTS.curator], { from: CREATOR });
    await expectRevert(fx.splitter.send('acceptCreator', [], { from: ACCOUNTS.bob }), 'NotPending');
    await fx.splitter.send('acceptCreator', [], { from: ACCOUNTS.curator });
    assert.equal((await fx.splitter.call('creator')).toLowerCase(), ACCOUNTS.curator.toLowerCase());
  });

  test('governance rotates in two steps', async () => {
    const fx = await fixture();
    await fx.splitter.send('proposeGovernance', [ACCOUNTS.mallory], { from: GOVERNANCE });
    await expectRevert(fx.splitter.send('acceptGovernance', [], { from: ACCOUNTS.bob }), 'NotPending');
    await fx.splitter.send('acceptGovernance', [], { from: ACCOUNTS.mallory });
    await fx.splitter.send('setCushionBps', [4000], { from: ACCOUNTS.mallory });
  });

  test('a creator that refuses value loses only its own claim', async () => {
    const fx = await fixture();
    const refuser = await fx.chain.deploy('RefusesValue');
    const splitter = await fx.chain.deploy(
      'QurrlRevenueSplitter',
      ['address', 'address', 'address', 'address', 'uint16'],
      [fx.nft.address, refuser.address, GOVERNANCE, ZERO, 3500],
    );
    await fx.nft.send('grantRole', [role('TREASURER_ROLE'), splitter.address], { from: ACCOUNTS.admin });
    await splitter.send('setTreasury', [fx.treasury.address], { from: GOVERNANCE });
    await splitter.send('setCushion', [fx.cushion.address], { from: GOVERNANCE });

    await mint(fx, 10);
    await splitter.send('sweep');
    await expectRevert(splitter.send('claimCreator'), 'PayoutFailed');
    await splitter.send('claimTreasury');
    await splitter.send('claimCushion');
    assert.equal(await splitter.call('creatorOwed'), ONE, 'the refused amount stays owed');
  });
});

describe('QurrlRevenueSplitter: nothing is stranded', () => {
  test('revenue withdrawn straight to the splitter, outside sweep, is booked by the next sweep', async () => {
    const fx = await fixture();
    await mint(fx, 100);
    // A treasurer calls the collection directly; the splitter is the recipient but sweep never ran.
    await fx.nft.send('grantRole', [role('TREASURER_ROLE'), ACCOUNTS.treasurer], { from: ACCOUNTS.admin });
    await fx.nft.send('withdraw', [fx.splitter.address], { from: ACCOUNTS.treasurer });
    assert.equal(await fx.chain.balanceOf(fx.splitter.address), 100n * ONE);
    assert.equal(await fx.splitter.call('creatorOwed'), 0n, 'nothing booked yet');

    await fx.splitter.send('sweep');
    assert.equal(await fx.splitter.call('creatorOwed'), 10n * ONE);
    assert.equal(await fx.splitter.call('cushionOwed'), 35n * ONE);
    assert.equal(await fx.splitter.call('treasuryPrimaryOwed'), 55n * ONE);
  });

  test('the ledgers equal the balance after every operation', async () => {
    const fx = await fixture();
    const sum = async () =>
      (await fx.splitter.call('creatorOwed')) +
      (await fx.splitter.call('cushionOwed')) +
      (await fx.splitter.call('treasuryPrimaryOwed')) +
      (await fx.splitter.call('treasurySecondaryOwed'));
    const check = async (label) => assert.equal(await sum(), await fx.chain.balanceOf(fx.splitter.address), label);

    await mint(fx, 37);
    await fx.splitter.send('sweep');
    await check('after sweep');
    await fx.chain.execute(fx.splitter.address, ACCOUNTS.mallory, '0x', 3n * ONE);
    await check('after a fee');
    await fx.splitter.send('claimTreasury');
    await check('after the treasury claim');
    await fx.splitter.send('claimCreator');
    await check('after the creator claim');
    await fx.splitter.send('claimCushion');
    await check('after the cushion claim');
  });
});
