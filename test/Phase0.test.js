/**
 * Phase 0 selection (scripts/phase0/select-phase0.js): three baskets 35 / 45 / 25,
 * one wallet one token, a raffle weighted by sqrt(Acorn) from a published seed,
 * and a root the minter accepts (QuantumArk-Phases.md §5, adopted 2026-10-13).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes } = require('ethers');
const { select, genesisLeaf: phase0Leaf, RAFFLE_FLOOR } = require('../scripts/phase0/select-phase0');
const collection = require('../scripts/collection');
const { deployQurrl, seedFor, commitmentFor, genesisLeaf, role, ACCOUNTS, expectRevert, DAY } = require('./fixtures');

const ROW =
  'tuple(uint32 acornCap,uint32 qrlCap,uint32 fusionCap,uint32 reqPts,uint32 reqPtsMin,uint32 reqPtsMax,' +
  'uint128 mintFee,uint128 mintFeeMin,uint128 mintFeeMax,uint128 fusionFee,uint16 walletLimit,' +
  'uint32 mintDuration,uint32 fusionDuration,uint128 lockBaseFee)';

const addr = (i) => '0x' + i.toString(16).padStart(40, '0');
const SEED = keccak256(toUtf8Bytes('an announced Ethereum block hash'));

/** 300 wallets: Acorn 100..30,000, transactions 0..4, first block by index. */
function snapshot() {
  return Array.from({ length: 300 }, (_, i) => ({ address: addr(i + 1), acorn: 100 * (i + 1), txCount: i % 5, firstBlock: 1000 + i }));
}
const DIRECT = Array.from({ length: 35 }, (_, i) => ({ address: addr(10_000 + i), group: i < 10 ? 'team' : 'supporter' }));

test('three baskets, distinct wallets, 105 in all', () => {
  const out = select({ snapshot: snapshot(), direct: DIRECT, seed: SEED });
  assert.deepEqual(out.counts.direct + out.counts.top + out.counts.raffle, 105);
  assert.equal(out.wallets.length, 105);
  assert.equal(new Set(out.wallets.map((w) => w.address)).size, 105);
  assert.equal(out.wallets.filter((w) => w.basket === 'direct').length, 35);
  const top = out.wallets.filter((w) => w.basket === 'top');
  assert.equal(top.length, 45);
  assert.equal(top[0].acorn, 30_000, 'the highest Acorn first');
  assert.equal(Math.min(...top.map((w) => w.acorn)), 25_600);
});

test('the raffle draws only eligible wallets, deterministically from the seed', () => {
  const a = select({ snapshot: snapshot(), direct: DIRECT, seed: SEED });
  const b = select({ snapshot: snapshot(), direct: DIRECT, seed: SEED });
  assert.equal(a.root, b.root, 'same snapshot and seed, same root');
  const byAddr = new Map(snapshot().map((w) => [w.address, w]));
  for (const w of a.wallets.filter((x) => x.basket === 'raffle')) {
    assert.ok(byAddr.get(w.address).acorn >= RAFFLE_FLOOR);
    assert.ok(byAddr.get(w.address).txCount >= 2);
  }
  const c = select({ snapshot: snapshot(), direct: DIRECT, seed: keccak256(toUtf8Bytes('another block')) });
  assert.notEqual(a.root, c.root, 'another seed draws another raffle');
});

test('heavier Acorn wins the raffle more often (sqrt weight)', () => {
  const pool = [
    ...Array.from({ length: 50 }, (_, i) => ({ address: addr(100 + i), acorn: 600, txCount: 2, firstBlock: 1 })),
    ...Array.from({ length: 50 }, (_, i) => ({ address: addr(200 + i), acorn: 9600, txCount: 2, firstBlock: 1 })),
  ];
  let heavy = 0;
  for (let s = 0; s < 40; s++) {
    // Fill the top basket with others so all 100 enter the raffle.
    const filler = Array.from({ length: 45 }, (_, i) => ({ address: addr(5000 + i), acorn: 1e6, txCount: 9, firstBlock: 0 }));
    const out = select({ snapshot: [...filler, ...pool], direct: [], seed: keccak256(toUtf8Bytes(`seed-${s}`)) });
    heavy += out.wallets.filter((w) => w.basket === 'raffle' && w.acorn === 9600).length;
  }
  // Weight ratio 4:1; without replacement the heavy share of 25 draws is well above half.
  assert.ok(heavy / (40 * 25) > 0.6, `heavy share ${heavy / 1000}`);
});

test('refuses a duplicate wallet, an oversized direct basket and a malformed seed', () => {
  assert.throws(() => select({ snapshot: snapshot(), direct: [...DIRECT, { address: addr(1) }], seed: SEED }), /at most 35/);
  assert.throws(() => select({ snapshot: snapshot(), direct: [{ address: addr(1) }], seed: '0x1234' }), /seed/);
  assert.throws(() => select({ snapshot: [...snapshot(), { address: addr(1), acorn: 1 }], direct: [], seed: SEED }), /twice/);
});

test('the leaf is the minter\'s, and a selected wallet mints its one genesis token', async () => {
  assert.equal(phase0Leaf(ACCOUNTS.alice, false), genesisLeaf(ACCOUNTS.alice));
  const snap = [
    { address: ACCOUNTS.alice, acorn: 5000, txCount: 3, firstBlock: 1 },
    { address: ACCOUNTS.bob, acorn: 700, txCount: 2, firstBlock: 2 },
  ];
  const out = select({ snapshot: snap, direct: [], seed: SEED });

  const fx = await deployQurrl();
  fx.phase = await fx.chain.deploy('ArkPhaseDouble');
  fx.minter = await fx.chain.deploy(
    'QurrlPhaseMinter',
    ['address', 'address', 'address', 'address', 'address', 'address', `${ROW}[5]`],
    [fx.nft.address, fx.registry.address, fx.phase.address, ACCOUNTS.treasurer, ACCOUNTS.seasonAdmin, ACCOUNTS.curator, collection.PHASE_ROWS.map(collection.phaseRowTuple)],
    ACCOUNTS.admin,
  );
  await fx.nft.send('grantRole', [role('MINTER_ROLE'), fx.minter.address], { from: ACCOUNTS.admin });
  await fx.nft.send('grantRole', [role('SEASON_ADMIN_ROLE'), fx.minter.address], { from: ACCOUNTS.admin });
  await fx.minter.send('setGenesis', [out.root, out.perWallet], { from: ACCOUNTS.admin });
  await fx.registry.send('commitSeed', [1, commitmentFor(1, seedFor(1)), Number(fx.chain.timestamp) + 30 * DAY], { from: ACCOUNTS.curator });
  await fx.minter.send('openPhase', []);

  const alice = out.wallets.find((w) => w.address === ACCOUNTS.alice);
  await fx.minter.send('mintGenesis', [1, alice.proof], { from: ACCOUNTS.alice });
  assert.equal(await fx.nft.call('balanceOf', [ACCOUNTS.alice]), 1n);
  await expectRevert(fx.minter.send('mintGenesis', [1, alice.proof], { from: ACCOUNTS.alice }), 'WalletLimitReached');
  await expectRevert(fx.minter.send('mintGenesis', [1, alice.proof], { from: ACCOUNTS.mallory }), 'InvalidMerkleProof');
});
