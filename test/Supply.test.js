const test = require('node:test');
const assert = require('node:assert/strict');

const { ACCOUNTS } = require('./harness');
const {
  deployQurrl,
  openSeason,
  revealSeason,
  seedFor,
  commitmentFor,
  expectRevert,
  seasonConfig,
  mintTo,
  MAX_SUPPLY,
  DAY,
} = require('./fixtures');

const QRL = 10n ** 18n;
const D30 = 30 * DAY;

/**
 * The shipped schedule (QuantumArk-Phases.md section 5): one phase is one season,
 * season id = phase + 1. Every allocation is a multiple of 105 and the sum is exactly
 * the lifetime ceiling, so the last season cannot be configured if any earlier one
 * was over-allocated.
 *
 * Written out rather than imported from `scripts/collection.js`, for the same
 * reason `fixtures.js` reimplements `deriveTraits`: a test that asks the thing
 * under test what it believes cannot catch it believing the wrong number. The
 * field order is `IQurrlPhaseMinter.PhaseRow`.
 */
const SCHEDULE = [
  { acornCap: 105, qrlCap: 0, fusionCap: 0, reqPts: 0, reqPtsMin: 0, reqPtsMax: 0, mintFee: 0n, mintFeeMin: 0n, mintFeeMax: 0n, fusionFee: 0n, walletLimit: 0, mintDuration: D30, fusionDuration: 0, lockBaseFee: 0n },
  { acornCap: 525, qrlCap: 210, fusionCap: 210, reqPts: 2000, reqPtsMin: 1000, reqPtsMax: 4000, mintFee: QRL, mintFeeMin: QRL / 2n, mintFeeMax: 2n * QRL, fusionFee: 0n, walletLimit: 2, mintDuration: D30, fusionDuration: D30, lockBaseFee: QRL },
  { acornCap: 735, qrlCap: 840, fusionCap: 630, reqPts: 1500, reqPtsMin: 750, reqPtsMax: 3000, mintFee: 2n * QRL, mintFeeMin: QRL, mintFeeMax: 4n * QRL, fusionFee: QRL / 2n, walletLimit: 3, mintDuration: D30, fusionDuration: D30, lockBaseFee: QRL },
  { acornCap: 630, qrlCap: 1575, fusionCap: 1050, reqPts: 1000, reqPtsMin: 500, reqPtsMax: 2000, mintFee: 3n * QRL, mintFeeMin: 1_500_000_000_000_000_000n, mintFeeMax: 6n * QRL, fusionFee: QRL / 2n, walletLimit: 5, mintDuration: D30, fusionDuration: D30, lockBaseFee: QRL },
  { acornCap: 315, qrlCap: 2415, fusionCap: 1260, reqPts: 1000, reqPtsMin: 500, reqPtsMax: 2000, mintFee: 4n * QRL, mintFeeMin: 2n * QRL, mintFeeMax: 8n * QRL, fusionFee: QRL / 2n, walletLimit: 10, mintDuration: D30, fusionDuration: D30, lockBaseFee: QRL },
];

const primaryOf = (row) => row.acornCap + row.qrlCap;

test('the schedule script and this independent copy agree row by row, in PhaseRow field order', () => {
  const { PHASE_ROWS } = require('../scripts/collection');
  assert.deepEqual(PHASE_ROWS, SCHEDULE);
  for (const [p, row] of PHASE_ROWS.entries()) {
    assert.deepEqual(Object.keys(row), Object.keys(SCHEDULE[p]), `phase ${p} field order`);
  }
});

test('the phases add up to the ceiling exactly: 7,350 primary, 3,150 fusion', () => {
  const primary = SCHEDULE.reduce((n, r) => n + primaryOf(r), 0);
  const fusion = SCHEDULE.reduce((n, r) => n + r.fusionCap, 0);
  assert.equal(primary, 7350);
  assert.equal(fusion, 3150);
  assert.equal(primary + fusion, MAX_SUPPLY);

  assert.equal(SCHEDULE.reduce((n, r) => n + r.acornCap, 0), 2310, 'Acorn pool, the 105 genesis included');
  assert.equal(SCHEDULE.reduce((n, r) => n + r.qrlCap, 0), 5040, 'QRL pool');

  assert.deepEqual(SCHEDULE.map(primaryOf), [105, 735, 1575, 2205, 2730]);
  let issued = 0;
  const cumulative = SCHEDULE.map((r) => (issued += primaryOf(r) + r.fusionCap));
  assert.deepEqual(cumulative, [105, 1050, 3255, 6510, 10500]);
});

test('every allocation is a multiple of 105', () => {
  for (const [p, row] of SCHEDULE.entries()) {
    for (const field of ['acornCap', 'qrlCap', 'fusionCap']) {
      assert.equal(row[field] % 105, 0, `phase ${p} ${field}`);
    }
  }
});

test('every default sits inside its bounds, and phase 0 is free and has no fusion', () => {
  for (const [p, row] of SCHEDULE.entries()) {
    assert.ok(row.reqPtsMin <= row.reqPts && row.reqPts <= row.reqPtsMax, `phase ${p} reqPts`);
    assert.ok(row.mintFeeMin <= row.mintFee && row.mintFee <= row.mintFeeMax, `phase ${p} mintFee`);
    if (row.fusionCap > 0) assert.ok(row.fusionDuration > 0, `phase ${p} fusion window`);
  }
  assert.equal(SCHEDULE[0].qrlCap, 0);
  assert.equal(SCHEDULE[0].mintFee, 0n);
  assert.equal(SCHEDULE[0].fusionCap, 0);
});

test('a fusion budget can always be spent: it never needs more than 58% of the revealed supply', () => {
  // Phase k's fusion window opens at its own season's reveal, so the parents available are
  // everything issued in phases 0..k (its own primary included), minus what earlier fusions
  // burned, plus their heirs. Hardest case for the budget: every earlier budget spent in full.
  let revealed = 0;
  const ratios = [];
  for (const [p, row] of SCHEDULE.entries()) {
    revealed += primaryOf(row);
    if (row.fusionCap > 0) {
      const parents = 2 * row.fusionCap;
      assert.ok(parents <= revealed, `phase ${p}: ${parents} parents needed, ${revealed} revealed`);
      ratios.push({ phase: p, parents, revealed });
    }
    revealed -= row.fusionCap; // two burned, one heir
  }
  assert.deepEqual(ratios, [
    { phase: 1, parents: 420, revealed: 840 },
    { phase: 2, parents: 1260, revealed: 2205 },
    { phase: 3, parents: 2100, revealed: 3780 },
    { phase: 4, parents: 2520, revealed: 5460 },
  ]);
  const shares = ratios.map((r) => Math.round((r.parents / r.revealed) * 1000) / 1000);
  assert.deepEqual(shares, [0.5, 0.571, 0.556, 0.462]);
  assert.ok(Math.max(...ratios.map((r) => r.parents / r.revealed)) <= 0.58);
});

test('fusion opening with the mint window would fail: phase 1 needs 420 parents, phase 0 revealed 105', () => {
  assert.ok(2 * SCHEDULE[1].fusionCap > primaryOf(SCHEDULE[0]));
});

test('the five seasons configure back to back on the collection and a sixth has nothing left', async () => {
  const fx = await deployQurrl();
  let opensAt = Number(fx.chain.timestamp);

  for (const [p, row] of SCHEDULE.entries()) {
    const seasonId = p + 1;
    const closesAt = opensAt + row.mintDuration;
    await fx.registry.send('commitSeed', [seasonId, commitmentFor(seasonId, seedFor(seasonId)), closesAt], {
      from: ACCOUNTS.curator,
    });
    await fx.nft.send(
      'configureSeason',
      [
        seasonId,
        seasonConfig(fx.chain, {
          primaryCap: primaryOf(row),
          fusionCap: row.fusionCap,
          fusionFee: row.fusionFee,
          opensAt,
          closesAt,
          fusionOpensAt: row.fusionCap > 0 ? closesAt : 0,
          fusionClosesAt: row.fusionCap > 0 ? closesAt + row.fusionDuration : 0,
        }),
      ],
      { from: ACCOUNTS.seasonAdmin },
    );
    opensAt = closesAt + row.fusionDuration; // the next phase opens after this one's last window
  }

  assert.equal(Number(await fx.nft.call('allocatedSupply')), MAX_SUPPLY);
  assert.equal(Number(await fx.nft.call('seasonCount')), SCHEDULE.length);

  await fx.registry.send('commitSeed', [6, commitmentFor(6, seedFor(6)), opensAt + D30], { from: ACCOUNTS.curator });
  await expectRevert(
    fx.nft.send('configureSeason', [6, seasonConfig(fx.chain, { primaryCap: 105, opensAt, closesAt: opensAt + D30 })], {
      from: ACCOUNTS.seasonAdmin,
    }),
    'AllocationExceeded',
  );
});

test('every fusion trades one unit of issuance headroom for two tokens off the float', async () => {
  const fx = await deployQurrl();

  // One season, as a phase is: mint window, then the fusion window from the reveal.
  await openSeason(fx, 1, { primaryCap: 8, fusionCap: 4 });
  await mintTo(fx, ACCOUNTS.alice, 8);
  await revealSeason(fx, 1);

  let issued = 8;
  let circulating = 8;

  for (const [keep, sacrifice] of [
    [1, 2],
    [3, 4],
    [5, 6],
    [7, 8],
  ]) {
    await fx.nft.send('fuse', [keep, sacrifice, [0, 0, 0, 0, 0, 0], 0, []], { from: ACCOUNTS.alice });
    issued += 1;
    circulating -= 1;

    assert.equal(Number(await fx.nft.call('totalMinted')), issued);
    assert.equal(Number(await fx.nft.call('totalMinted')) - Number(await fx.nft.call('totalBurned')), circulating);
  }

  assert.equal(Number(await fx.nft.call('balanceOf', [ACCOUNTS.alice])), 4);
  await expectRevert(fx.nft.send('fuse', [9, 10, [0, 0, 0, 0, 0, 0], 0, []], { from: ACCOUNTS.alice }), 'FusionBudgetExhausted');
});

test('a season allocation is a hard stop, and allocation is what makes the ceiling unreachable', async () => {
  const fx = await deployQurrl();

  // Season 1 at its shipped size. Exhausting it is the realistic boundary; the
  // MAX_SUPPLY check inside `mintTo` is a backstop that allocation accounting
  // already makes unreachable, since sum(caps) <= MAX_SUPPLY is enforced at
  // configuration time and no season can mint past its own cap.
  await openSeason(fx, 1, { primaryCap: 105 });
  for (let i = 0; i < 3; i += 1) {
    await mintTo(fx, ACCOUNTS.alice, 35);
  }

  assert.equal(Number(await fx.nft.call('totalMinted')), 105);
  const collection = await fx.lens.call('collectionView');
  assert.equal(Number(collection.remaining), MAX_SUPPLY - 105);
  assert.equal(Number(collection.allocated), 105);

  await expectRevert(mintTo(fx, ACCOUNTS.bob, 1), 'SeasonSoldOut');
});

test('burned ids are never reissued', async () => {
  const fx = await deployQurrl();

  await openSeason(fx, 1, { primaryCap: 4, fusionCap: 2 });
  await mintTo(fx, ACCOUNTS.alice, 4);
  await revealSeason(fx, 1);
  await fx.nft.send('fuse', [1, 2, [0, 0, 0, 0, 0, 0], 0, []], { from: ACCOUNTS.alice });

  await openSeason(fx, 2, { primaryCap: 4 });
  const res = await mintTo(fx, ACCOUNTS.bob, 1);
  const [event] = fx.nft.events(res, 'Minted');

  // Ids 1 and 2 are gone forever; the next primary mint continues past the heir.
  assert.equal(Number(event.args.firstTokenId), 6);
  await expectRevert(fx.nft.call('ownerOf', [1]), 'ERC721: invalid token ID');
});
