const test = require('node:test');
const assert = require('node:assert/strict');

const { ACCOUNTS } = require('./harness');
const {
  deployQurrl,
  openSeason,
  revealSeason,
  deriveTraits,
  mintTo,
  expectRevert,
  PALETTE,
  MAX_SUPPLY,
} = require('./fixtures');

test('collectionView reports the ceiling and an empty collection', async () => {
  const fx = await deployQurrl();
  const view = await fx.lens.call('collectionView');

  assert.equal(Number(view.maxSupply), MAX_SUPPLY);
  assert.equal(Number(view.totalMinted), 0);
  assert.equal(Number(view.remaining), MAX_SUPPLY);
  assert.equal(Number(view.activeSeason), 0);
  assert.equal(view.paletteFrozen, true);
});

test('paletteView returns the six variant counts in slot order, and no names', async () => {
  const fx = await deployQurrl();
  const variants = await fx.lens.call('paletteView');

  assert.deepEqual(
    variants.map(Number),
    PALETTE.map((p) => p.variants),
  );
});

test('seasonView joins config, counters and reveal state', async () => {
  const fx = await deployQurrl();
  const { config } = await openSeason(fx, 1, { primaryCap: 105, fusionCap: 21, fusionFee: 10n ** 16n });
  await mintTo(fx, ACCOUNTS.alice, 2, { value: 2n * 10n ** 16n });

  let [season, committed, revealed] = await fx.lens.call('seasonView', [1]);
  assert.equal(season.exists, true);
  assert.deepEqual(Object.keys(season.config.toObject()), [
    'primaryCap',
    'fusionCap',
    'opensAt',
    'closesAt',
    'fusionOpensAt',
    'fusionClosesAt',
    'fusionFee',
    'lockBaseFee',
  ]);
  assert.equal(Number(season.config.primaryCap), 105);
  assert.equal(Number(season.config.fusionCap), 21);
  assert.equal(Number(season.config.opensAt), config.opensAt);
  assert.equal(Number(season.config.closesAt), config.closesAt);
  assert.equal(Number(season.config.fusionOpensAt), config.closesAt, 'fusion opens at the reveal, which is the close');
  assert.equal(Number(season.config.fusionClosesAt), config.fusionClosesAt);
  assert.equal(season.config.fusionFee, 10n ** 16n);
  assert.equal(Number(season.primaryMinted), 2);
  assert.equal(Number(season.fusionMinted), 0);
  assert.equal(committed, true);
  assert.equal(revealed, false);

  await revealSeason(fx, 1);
  [, , revealed] = await fx.lens.call('seasonView', [1]);
  assert.equal(revealed, true);
});

test('tokenView carries owner, season and reveal state together', async () => {
  const fx = await deployQurrl();
  await openSeason(fx, 1);
  await mintTo(fx, ACCOUNTS.alice, 1);

  let view = await fx.lens.call('tokenView', [1]);
  assert.equal(view.owner, ACCOUNTS.alice);
  assert.equal(view.revealed, false);
  assert.equal(view.traitsLocked, false);
  assert.equal(Number(view.generation), 1);

  const seed = await revealSeason(fx, 1);
  view = await fx.lens.call('tokenView', [1]);
  assert.equal(view.revealed, true);
  assert.deepEqual(view.traits.map(Number), deriveTraits(seed, 1));
});

test('tokenViews batches, and an unminted id in the batch reverts the whole call', async () => {
  const fx = await deployQurrl();
  await openSeason(fx, 1);
  await mintTo(fx, ACCOUNTS.alice, 3);

  const views = await fx.lens.call('tokenViews', [[1, 2, 3]]);
  assert.equal(views.length, 3);
  assert.deepEqual(
    views.map((v) => Number(v.tokenId)),
    [1, 2, 3],
  );

  await expectRevert(fx.lens.call('tokenViews', [[1, 99]]), 'UnknownToken');
});

test('tokensOfOwner clamps the upper bound and skips burned ids', async () => {
  const fx = await deployQurrl();

  await openSeason(fx, 1, { primaryCap: 6, fusionCap: 1 });
  await mintTo(fx, ACCOUNTS.alice, 4);
  await mintTo(fx, ACCOUNTS.bob, 2);
  await revealSeason(fx, 1);

  assert.deepEqual((await fx.lens.call('tokensOfOwner', [ACCOUNTS.alice, 0, 10500])).map(Number), [1, 2, 3, 4]);
  assert.deepEqual((await fx.lens.call('tokensOfOwner', [ACCOUNTS.bob, 0, 10500])).map(Number), [5, 6]);
  assert.deepEqual((await fx.lens.call('tokensOfOwner', [ACCOUNTS.alice, 3, 10500])).map(Number), [3, 4]);
  assert.deepEqual((await fx.lens.call('tokensOfOwner', [ACCOUNTS.mallory, 0, 10500])).map(Number), []);

  await fx.nft.send('fuse', [1, 2, [0, 0, 0, 0, 0, 0], 0, []], { from: ACCOUNTS.alice });

  assert.deepEqual((await fx.lens.call('tokensOfOwner', [ACCOUNTS.alice, 0, 10500])).map(Number), [3, 4, 7]);
});

test('lineageOf stops at a generation-0 ancestor and honours maxDepth', async () => {
  const fx = await deployQurrl();

  await openSeason(fx, 1, { primaryCap: 4, fusionCap: 3 });
  await mintTo(fx, ACCOUNTS.alice, 4);
  await revealSeason(fx, 1); // the clock is now inside season 1's fusion window

  await fx.nft.send('fuse', [1, 2, [0, 0, 0, 0, 0, 0], 0, []], { from: ACCOUNTS.alice }); // 5
  await fx.nft.send('fuse', [5, 3, [0, 0, 0, 0, 0, 0], 0, []], { from: ACCOUNTS.alice }); // 6
  await fx.nft.send('fuse', [6, 4, [0, 0, 0, 0, 0, 0], 0, []], { from: ACCOUNTS.alice }); // 7

  assert.deepEqual((await fx.lens.call('lineageOf', [7, 10])).map(Number), [7, 6, 5, 1]);
  assert.deepEqual((await fx.lens.call('lineageOf', [7, 2])).map(Number), [7, 6]);
  assert.deepEqual((await fx.lens.call('lineageOf', [3, 10])).map(Number), [3]);
});
