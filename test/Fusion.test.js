const test = require('node:test');
const assert = require('node:assert/strict');

const { ACCOUNTS } = require('./harness');
const {
  deployQurrl,
  openSeason,
  revealSeason,
  deriveTraits,
  drawFromA,
  acornLeaf,
  merkleTree,
  mintTo,
  expectRevert,
  DAY,
} = require('./fixtures');

const ONE = 10n ** 18n;
const KEEP_A = [0, 0, 0, 0, 0, 0];
const KEEP_B = [1, 1, 1, 1, 1, 1];
const ALL_DRAWN = [2, 2, 2, 2, 2, 2];
const NO_PROOF = [0, []];

/** `fuse(a, b, choices, earned, proof)` with the caller defaulting to alice and no tier proof. */
function fuse(fx, a, b, { choices = KEEP_A, tier = NO_PROOF, from = ACCOUNTS.alice, value } = {}) {
  return fx.nft.send('fuse', [a, b, choices, tier[0], tier[1]], { from, ...(value === undefined ? {} : { value }) });
}

/**
 * Season 1 opens with a primary and a fusion budget, mints, and reveals. The reveal lands
 * on `fusionOpensAt`, so the clock is inside the fusion window and the season's own tokens
 * are fusible. Tokens 1-4 are alice's and 5-6 bob's, all generation 1.
 */
async function fusionReady({ fusionCap = 4, fusionFee = 0n, lockBaseFee = 0n, primaryCap = 10, alice = 4 } = {}) {
  const fx = await deployQurrl();

  const { config } = await openSeason(fx, 1, { primaryCap, fusionCap, fusionFee, lockBaseFee });
  await mintTo(fx, ACCOUNTS.alice, alice);
  await mintTo(fx, ACCOUNTS.bob, 2);
  const seed = await revealSeason(fx, 1);

  return { ...fx, seed, config };
}

/** Acorn tiers for alice (5,001 earned, three free locks) and bob (501, one free lock). */
function tierProofs(fx) {
  const leaves = [acornLeaf(ACCOUNTS.alice, 5001n), acornLeaf(ACCOUNTS.bob, 501n)];
  const tree = merkleTree(leaves);
  return {
    root: tree.root,
    alice: [5001n, tree.proof(leaves[0])],
    bob: [501n, tree.proof(leaves[1])],
  };
}

test('equal generations ascend: the heir is one generation up and the refine count restarts', async () => {
  const fx = await fusionReady();
  const expected = deriveTraits(fx.seed, 1);

  const res = await fuse(fx, 1, 2);
  const [event] = fx.nft.events(res, 'Fused');

  const heir = Number(event.args.tokenId);
  assert.equal(heir, 7);
  assert.equal(Number(event.args.generation), 2);
  assert.equal(event.args.owner.toLowerCase(), ACCOUNTS.alice);

  assert.equal(await fx.nft.call('ownerOf', [heir]), ACCOUNTS.alice);
  await expectRevert(fx.nft.call('ownerOf', [1]), 'ERC721: invalid token ID');
  await expectRevert(fx.nft.call('ownerOf', [2]), 'ERC721: invalid token ID');

  const [traits, revealed] = await fx.nft.call('traitsOf', [heir]);
  assert.equal(revealed, true);
  assert.deepEqual(traits.map(Number), expected, 'six locks on A keep A');

  const record = await fx.nft.call('recordOf', [heir]);
  assert.equal(record.traitsLocked, true);
  assert.equal(Number(record.lockedFrom), 1);
  assert.equal(Number(record.refineCount), 0);
  assert.equal(Number(record.seasonId), 1, 'the heir belongs to the season whose window issued it');

  const view = await fx.nft.call('seasonView', [1]);
  assert.equal(Number(view.fusionMinted), 1);
  assert.equal(Number(view.primaryMinted), 6);
});

test('primary mints are generation 1', async () => {
  const fx = await fusionReady();
  assert.equal(Number((await fx.nft.call('recordOf', [1])).generation), 1);
});

test('the accounting is +1 issued, -2 circulating', async () => {
  const fx = await fusionReady();
  assert.equal(Number(await fx.nft.call('totalMinted')), 6);
  assert.equal(Number(await fx.nft.call('totalBurned')), 0);

  await fuse(fx, 1, 2);

  assert.equal(Number(await fx.nft.call('totalMinted')), 7);
  assert.equal(Number(await fx.nft.call('totalBurned')), 2);
  assert.equal(Number(await fx.nft.call('balanceOf', [ACCOUNTS.alice])), 3);

  const collection = await fx.lens.call('collectionView');
  assert.equal(Number(collection.circulating), 5);
  assert.equal(Number(collection.remaining), 10500 - 7);
});

test('a choice per slot takes that slot from A or from B', async () => {
  const fx = await fusionReady();
  const a = deriveTraits(fx.seed, 3);
  const b = deriveTraits(fx.seed, 4);

  await fuse(fx, 3, 4, { choices: [0, 1, 0, 1, 0, 1] });
  const [traits] = await fx.nft.call('traitsOf', [7]);
  assert.deepEqual(traits.map(Number), [a[0], b[1], a[2], b[3], a[4], b[5]]);

  const fx2 = await fusionReady();
  await fuse(fx2, 3, 4, { choices: KEEP_B });
  assert.deepEqual((await fx2.nft.call('traitsOf', [7]))[0].map(Number), b);
});

test('a drawn slot follows the weighted draw and quoteFusion shows it beforehand', async () => {
  const fx = await fusionReady();
  const a = deriveTraits(fx.seed, 1);
  const b = deriveTraits(fx.seed, 2);
  const expected = a.map((t, i) => (drawFromA(fx.seed, 1, 2, i, 1, 1) ? t : b[i]));

  const quote = await fx.nft.call('quoteFusion', [1, 2, ALL_DRAWN, 0]);
  assert.deepEqual(quote.traits.map(Number), expected);
  assert.equal(Number(quote.generation), 2);
  assert.equal(quote.lockFee, 0n, 'drawn slots are not locks');

  await fuse(fx, 1, 2, { choices: ALL_DRAWN });
  assert.deepEqual((await fx.nft.call('traitsOf', [7]))[0].map(Number), expected);
});

test('a refinement keeps the higher generation, favours its traits and counts a refine', async () => {
  const fx = await fusionReady();
  await fuse(fx, 1, 2); // 7: generation 2

  // Higher token as A, then as B: the generation and the refine count do not depend on the side.
  const quote = await fx.nft.call('quoteFusion', [7, 3, ALL_DRAWN, 0]);
  assert.equal(Number(quote.generation), 2);
  assert.equal(Number(quote.refineCount), 1);
  const high = await fx.nft.call('traitsOf', [7]);
  const low = deriveTraits(fx.seed, 3);
  const expected = high[0].map((t, i) => (drawFromA(fx.seed, 7, 3, i, 2, 1) ? Number(t) : low[i]));
  assert.deepEqual(quote.traits.map(Number), expected);

  const swapped = await fx.nft.call('quoteFusion', [3, 7, ALL_DRAWN, 0]);
  assert.equal(Number(swapped.generation), 2);
  assert.equal(Number(swapped.refineCount), 1);

  await fuse(fx, 3, 7, { choices: KEEP_B });
  const record = await fx.nft.call('recordOf', [8]);
  assert.equal(Number(record.generation), 2);
  assert.equal(Number(record.refineCount), 1);
  assert.deepEqual((await fx.nft.call('traitsOf', [8]))[0].map(Number), high[0].map(Number));
});

test('a token takes at most two refinements, and the count rides along to the heir', async () => {
  const fx = await fusionReady({ fusionCap: 8, alice: 8, primaryCap: 12 });
  await fuse(fx, 1, 2); // 11: generation 2, refine 0 (bob holds 9 and 10)
  await fuse(fx, 11, 3); // 12: refine 1
  await fuse(fx, 12, 4); // 13: refine 2
  assert.equal(Number((await fx.nft.call('recordOf', [13])).refineCount), 2);

  await expectRevert(fuse(fx, 13, 5), 'RefineLimitReached');
  await expectRevert(fuse(fx, 5, 13), 'RefineLimitReached');

  // Ascension is still open: it needs an equal partner and resets the count.
  await fuse(fx, 5, 6); // 14
  await fuse(fx, 13, 14); // 15
  const record = await fx.nft.call('recordOf', [15]);
  assert.equal(Number(record.generation), 3);
  assert.equal(Number(record.refineCount), 0);
});

test('lock fees escalate: 1, 2, 4, 8, 16, 32 times the base fee', async () => {
  const fx = await fusionReady({ lockBaseFee: ONE });

  const paid = async (choices, free = 0) => (await fx.nft.call('quoteFusion', [1, 2, choices, free])).lockFee;
  assert.equal(await paid(ALL_DRAWN), 0n);
  assert.equal(await paid([0, 2, 2, 2, 2, 2]), 1n * ONE);
  assert.equal(await paid([0, 1, 2, 2, 2, 2]), 3n * ONE);
  assert.equal(await paid([0, 1, 0, 2, 2, 2]), 7n * ONE);
  assert.equal(await paid([0, 1, 0, 1, 2, 2]), 15n * ONE);
  assert.equal(await paid([0, 1, 0, 1, 0, 2]), 31n * ONE);
  assert.equal(await paid(KEEP_A), 63n * ONE);

  assert.equal(await paid(KEEP_A, 1), 31n * ONE);
  assert.equal(await paid(KEEP_A, 2), 15n * ONE);
  assert.equal(await paid(KEEP_A, 3), 7n * ONE);
  assert.equal(await paid([0, 2, 2, 2, 2, 2], 3), 0n, 'free locks cover a short selection');
});

test('free locks follow the proven Acorn tier', async () => {
  const fx = await fusionReady({ lockBaseFee: ONE });
  const tiers = tierProofs(fx);
  await fx.acorn.send('set', [tiers.root], { from: ACCOUNTS.admin });

  for (const [earned, free] of [[0, 0], [500, 0], [501, 1], [2000, 1], [2001, 2], [5000, 2], [5001, 3], [90000, 3]]) {
    assert.equal(Number(await fx.nft.call('freeLocks', [earned])), free, `earned ${earned}`);
  }

  // Alice (three free locks) fuses six locks for 7 base fees; the payment is exact.
  await expectRevert(fuse(fx, 1, 2, { tier: tiers.alice, value: 63n * ONE }), 'IncorrectPayment');
  await fuse(fx, 1, 2, { tier: tiers.alice, value: 7n * ONE });
  assert.equal(await fx.chain.balanceOf(fx.nft.address), 7n * ONE);

  // Bob (one free lock) pays 31.
  await fuse(fx, 5, 6, { tier: tiers.bob, from: ACCOUNTS.bob, value: 31n * ONE });
});

test('a tier proof must match the caller and the oracle root', async () => {
  const fx = await fusionReady({ lockBaseFee: ONE });
  const tiers = tierProofs(fx);
  await fx.acorn.send('set', [tiers.root], { from: ACCOUNTS.admin });

  // Bob presenting alice's proof, alice inflating her points, and a proof with no points.
  await expectRevert(fuse(fx, 5, 6, { tier: tiers.alice, from: ACCOUNTS.bob, value: 7n * ONE }), 'InvalidMerkleProof');
  await expectRevert(fuse(fx, 1, 2, { tier: [90000n, tiers.alice[1]], value: 0n }), 'InvalidMerkleProof');
  await expectRevert(fuse(fx, 1, 2, { tier: [0n, tiers.alice[1]], value: 63n * ONE }), 'InvalidMerkleProof');
});

test('the Acorn source is set once and by the admin', async () => {
  const fx = await deployQurrl();
  await expectRevert(fx.nft.send('setAcornSource', [fx.acorn.address], { from: ACCOUNTS.admin }), 'AcornSourceAlreadySet');
  await expectRevert(fx.nft.send('setAcornSource', [fx.acorn.address], { from: ACCOUNTS.mallory }));
});

test('an invalid choice and a lock base fee over the ceiling are refused', async () => {
  const fx = await fusionReady();
  await expectRevert(fuse(fx, 1, 2, { choices: [0, 0, 0, 0, 0, 3] }), 'InvalidChoice');

  const fx2 = await deployQurrl();
  await expectRevert(openSeason(fx2, 1, { primaryCap: 4, fusionCap: 2, lockBaseFee: 5n * ONE }), 'LockBaseFeeTooHigh');
});

test('locked traits survive a second fusion verbatim', async () => {
  const fx = await fusionReady();
  const original = deriveTraits(fx.seed, 1);

  await fuse(fx, 1, 2); // -> 7, gen 2
  await fuse(fx, 7, 3); // -> 8: refine with token 3, keeping the higher token

  const [traits] = await fx.nft.call('traitsOf', [8]);
  assert.deepEqual(traits.map(Number), original);

  const record = await fx.nft.call('recordOf', [8]);
  assert.equal(Number(record.generation), 2);
  assert.equal(Number(record.lockedFrom), 7);
});

test('a burned parent keeps its record so the lineage stays walkable', async () => {
  const fx = await fusionReady();
  await fuse(fx, 1, 2);
  await fuse(fx, 7, 3);

  const record = await fx.nft.call('recordOf', [1]);
  assert.equal(Number(record.seasonId), 1);

  const chain = (await fx.lens.call('lineageOf', [8, 8])).map(Number);
  assert.deepEqual(chain, [8, 7, 1]);

  const view = await fx.lens.call('tokenView', [1]);
  assert.equal(Number(view.owner), 0);
  assert.equal(Number(view.seasonId), 1);
});

test('fusion refuses tokens the caller does not control', async () => {
  const fx = await fusionReady();
  await expectRevert(fuse(fx, 1, 5), 'NotTokenHolder');
  await expectRevert(fuse(fx, 5, 1, { from: ACCOUNTS.bob }), 'NotTokenHolder');
});

test('an approved operator may fuse, but the heir goes to the owner of A', async () => {
  const fx = await fusionReady();
  await fx.nft.send('setApprovalForAll', [ACCOUNTS.mallory, true], { from: ACCOUNTS.alice });

  await fuse(fx, 1, 2, { from: ACCOUNTS.mallory });
  assert.equal(await fx.nft.call('ownerOf', [7]), ACCOUNTS.alice);
  assert.equal(Number(await fx.nft.call('balanceOf', [ACCOUNTS.mallory])), 0);
});

test('a token cannot be fused with itself', async () => {
  const fx = await fusionReady();
  await expectRevert(fuse(fx, 1, 1), 'IdenticalTokens');
});

test('fusion is refused when the season has no fusion budget', async () => {
  const fx = await deployQurrl();
  await openSeason(fx, 1, { primaryCap: 4 });
  await mintTo(fx, ACCOUNTS.alice, 2);
  await revealSeason(fx, 1);

  await expectRevert(fuse(fx, 1, 2), 'FusionDisabled');
});

test('the season fusion budget is a hard stop', async () => {
  const fx = await fusionReady({ fusionCap: 1 });
  await fuse(fx, 1, 2);
  await expectRevert(fuse(fx, 3, 4), 'FusionBudgetExhausted');
});

test('the fusion fee is charged exactly, on top of any lock fee', async () => {
  const fee = 5n * 10n ** 16n;
  const fx = await fusionReady({ fusionFee: fee, lockBaseFee: ONE });
  const choices = [0, 2, 2, 2, 2, 2];

  await expectRevert(fuse(fx, 1, 2, { choices }), 'IncorrectPayment');
  await expectRevert(fuse(fx, 1, 2, { choices, value: fee }), 'IncorrectPayment');
  await expectRevert(fuse(fx, 1, 2, { choices, value: fee + ONE * 2n }), 'IncorrectPayment');

  await fuse(fx, 1, 2, { choices, value: fee + ONE });
  assert.equal(await fx.chain.balanceOf(fx.nft.address), fee + ONE);
});

test('a season own tokens cannot be fused before its reveal: the fusion window opens at it', async () => {
  const fx = await deployQurrl();
  const { config } = await openSeason(fx, 1, { primaryCap: 4, fusionCap: 2 });
  await mintTo(fx, ACCOUNTS.alice, 4);

  // Sealed tokens, mint window open: the fusion window has not started.
  await expectRevert(fuse(fx, 1, 2), 'SeasonNotOpen');

  // The fusion window opens at revealNotBefore. Until the curator reveals, the
  // tokens are still sealed, from either side of the fusion.
  fx.chain.advanceTime(config.fusionOpensAt - Number(fx.chain.timestamp));
  assert.equal(await fx.registry.call('isRevealed', [1]), false);
  await expectRevert(fuse(fx, 1, 2), 'TraitsNotRevealed');
  await expectRevert(fuse(fx, 2, 1), 'TraitsNotRevealed');

  // The reveal is what unlocks them.
  const seed = await revealSeason(fx, 1);
  await fuse(fx, 1, 2);
  assert.deepEqual((await fx.nft.call('traitsOf', [5]))[0].map(Number), deriveTraits(seed, 1));
});

test('sealed parents cannot be fused from either side, next to revealed ones', async () => {
  const fx = await deployQurrl();

  // Season 1: primary only, minted and revealed.
  await openSeason(fx, 1, { primaryCap: 2 });
  await mintTo(fx, ACCOUNTS.alice, 2);
  const seed = await revealSeason(fx, 1);

  // Season 2 mints tokens 3 and 4; its fusion window opens at its revealNotBefore.
  const { config } = await openSeason(fx, 2, { primaryCap: 2, fusionCap: 2 });
  await mintTo(fx, ACCOUNTS.alice, 2);
  fx.chain.advanceTime(config.fusionOpensAt - Number(fx.chain.timestamp));

  // Season 2 is not revealed yet, so neither it nor its tokens can be used.
  await expectRevert(fuse(fx, 3, 1), 'TraitsNotRevealed');
  await expectRevert(fuse(fx, 1, 3), 'TraitsNotRevealed');

  // Once it is, both revealed parents fuse, which proves the guard is about the seal.
  await revealSeason(fx, 2);
  await fuse(fx, 1, 2);
  assert.deepEqual((await fx.nft.call('traitsOf', [5]))[0].map(Number), deriveTraits(seed, 1));
});

test('earlier-season tokens stay fusible in a later season fusion window', async () => {
  const fx = await deployQurrl();

  await openSeason(fx, 1, { primaryCap: 2 });
  await mintTo(fx, ACCOUNTS.alice, 2);
  const seed = await revealSeason(fx, 1);

  await openSeason(fx, 2, { primaryCap: 2, fusionCap: 1 });
  await revealSeason(fx, 2);

  await fuse(fx, 1, 2); // 3
  const record = await fx.nft.call('recordOf', [3]);
  assert.equal(Number(record.seasonId), 2, 'charged to the budget of the season that fused it');
  assert.equal(Number(record.generation), 2);
  assert.deepEqual((await fx.nft.call('traitsOf', [3]))[0].map(Number), deriveTraits(seed, 1));
  assert.equal(Number((await fx.nft.call('seasonView', [2])).fusionMinted), 1);
});

test('fusion respects the fusion window and the pause switch', async () => {
  const fx = await fusionReady();

  await fx.nft.send('pause', [], { from: ACCOUNTS.admin });
  await expectRevert(fuse(fx, 1, 2), 'Pausable: paused');
  await fx.nft.send('unpause', [], { from: ACCOUNTS.admin });

  fx.chain.advanceTime(fx.config.fusionClosesAt - Number(fx.chain.timestamp) - 1);
  await fuse(fx, 1, 2);

  fx.chain.advanceTime(1);
  await expectRevert(fuse(fx, 3, 4), 'SeasonNotOpen');
  fx.chain.advanceTime(31 * DAY);
  await expectRevert(fuse(fx, 3, 4), 'SeasonNotOpen');
});
