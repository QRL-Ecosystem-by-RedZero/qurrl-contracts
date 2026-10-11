const test = require('node:test');
const assert = require('node:assert/strict');

const { ACCOUNTS, role, DEFAULT_ADMIN_ROLE } = require('./harness');
const {
  deployQurrl,
  seasonConfig,
  openSeason,
  revealSeason,
  seedFor,
  commitmentFor,
  deriveTraits,
  mintTo,
  expectRevert,
  COLLECTION,
  MAX_SUPPLY,
  DAY,
} = require('./fixtures');

const ZERO_ADDRESS = '0x' + '00'.repeat(20);

/**
 * OZ AccessControl's string revert naming the missing role. The vendored copy prints a
 * fixed '<caller>' placeholder instead of the account (see scripts/vendor-oz.js).
 */
function missingRole(roleName) {
  return new RegExp(`^AccessControl: account (<caller>|0x[0-9a-f]{40}) is missing role ${role(roleName)}$`);
}

test('collection metadata and the supply ceiling are what the spec says', async () => {
  const { nft } = await deployQurrl();
  assert.equal(await nft.call('name'), COLLECTION.name);
  assert.equal(await nft.call('symbol'), COLLECTION.symbol);
  assert.equal(Number(await nft.call('MAX_SUPPLY')), MAX_SUPPLY);
  assert.equal(Number(await nft.call('totalMinted')), 0);
  assert.equal(Number(await nft.call('allocatedSupply')), 0);
});

test('a season cannot be configured before the palette is sealed', async () => {
  const { chain } = await deployQurrl();
  const registry = await chain.deploy('QurrlTraitRegistry', ['address'], [ACCOUNTS.admin]);
  const nft = await chain.deploy(
    'QurrlNFT',
    ['string', 'string', 'address', 'address'],
    [COLLECTION.name, COLLECTION.symbol, ACCOUNTS.admin, registry.address],
  );

  await expectRevert(
    nft.send('configureSeason', [1, seasonConfig(chain)], { from: ACCOUNTS.admin }),
    'PaletteNotFrozen',
  );
});

test('a season cannot be configured before its seed is committed', async () => {
  const fx = await deployQurrl();
  await expectRevert(
    fx.nft.send('configureSeason', [1, seasonConfig(fx.chain)], { from: ACCOUNTS.seasonAdmin }),
    'SeedNotCommitted',
  );
});

test('seasons are append-only and dense from 1', async () => {
  const fx = await deployQurrl();
  await fx.registry.send('commitSeed', [3, commitmentFor(3, seedFor(3)), Number(fx.chain.timestamp) + 30 * DAY], { from: ACCOUNTS.curator });
  await expectRevert(
    fx.nft.send('configureSeason', [3, seasonConfig(fx.chain)], { from: ACCOUNTS.seasonAdmin }),
    'SeasonOutOfOrder',
  );
});

test('an invalid window is rejected', async () => {
  const fx = await deployQurrl();
  await fx.registry.send('commitSeed', [1, commitmentFor(1, seedFor(1)), Number(fx.chain.timestamp) + 30 * DAY], { from: ACCOUNTS.curator });
  const bad = seasonConfig(fx.chain, { closesAt: Number(fx.chain.timestamp) });
  await expectRevert(
    fx.nft.send('configureSeason', [1, bad], { from: ACCOUNTS.seasonAdmin }),
    'InvalidWindow',
  );
});

test('allocation across seasons cannot exceed the lifetime ceiling', async () => {
  const fx = await deployQurrl();
  await openSeason(fx, 1, { primaryCap: 10000, fusionCap: 500 });
  assert.equal(Number(await fx.nft.call('allocatedSupply')), MAX_SUPPLY);

  await fx.registry.send('commitSeed', [2, commitmentFor(2, seedFor(2)), Number(fx.chain.timestamp) + 30 * DAY], { from: ACCOUNTS.curator });
  await expectRevert(
    fx.nft.send('configureSeason', [2, seasonConfig(fx.chain, { primaryCap: 1 })], {
      from: ACCOUNTS.seasonAdmin,
    }),
    'AllocationExceeded',
  );
});

test('retuning a season swaps its allocation rather than adding to it', async () => {
  const fx = await deployQurrl();
  const opensAt = Number(fx.chain.timestamp) + DAY;

  await openSeason(fx, 1, { primaryCap: 105, opensAt });
  assert.equal(Number(await fx.nft.call('allocatedSupply')), 105);

  await fx.nft.send('configureSeason', [1, seasonConfig(fx.chain, { primaryCap: 210, opensAt })], {
    from: ACCOUNTS.seasonAdmin,
  });
  assert.equal(Number(await fx.nft.call('allocatedSupply')), 210);
  assert.equal(Number(await fx.nft.call('seasonCount')), 1);
});

test('a season that has opened can no longer be retuned', async () => {
  const fx = await deployQurrl();
  await openSeason(fx, 1);
  await expectRevert(
    fx.nft.send('configureSeason', [1, seasonConfig(fx.chain, { primaryCap: 210 })], {
      from: ACCOUNTS.seasonAdmin,
    }),
    'SeasonLocked',
  );
});

test('season administration is role-gated', async () => {
  const fx = await deployQurrl();
  await fx.registry.send('commitSeed', [1, commitmentFor(1, seedFor(1)), Number(fx.chain.timestamp) + 30 * DAY], { from: ACCOUNTS.curator });
  await expectRevert(
    fx.nft.send('configureSeason', [1, seasonConfig(fx.chain)], { from: ACCOUNTS.mallory }),
  );
  await expectRevert(fx.nft.send('setActiveSeason', [1], { from: ACCOUNTS.mallory }));
});

test('activating a season that does not exist is rejected', async () => {
  const fx = await deployQurrl();
  await expectRevert(
    fx.nft.send('setActiveSeason', [1], { from: ACCOUNTS.seasonAdmin }),
    'SeasonNotConfigured',
  );
});

test('minting with no active season reverts', async () => {
  const fx = await deployQurrl();
  await expectRevert(mintTo(fx, ACCOUNTS.alice, 1), 'SeasonNotConfigured');
});

test('mintTo is reserved to MINTER_ROLE', async () => {
  const fx = await deployQurrl();
  await openSeason(fx, 1);

  for (const caller of [ACCOUNTS.mallory, ACCOUNTS.alice]) {
    const e = await expectRevert(fx.nft.send('mintTo', [caller, 1], { from: caller }));
    assert.match(e.message, missingRole('MINTER_ROLE'));
  }
  assert.equal(Number(await fx.nft.call('totalMinted')), 0);

  // The grant is what makes the difference, not the caller's identity.
  await fx.nft.send('grantRole', [role('MINTER_ROLE'), ACCOUNTS.alice], { from: ACCOUNTS.admin });
  await fx.nft.send('mintTo', [ACCOUNTS.bob, 1], { from: ACCOUNTS.alice });
  assert.equal(await fx.nft.call('ownerOf', [1]), ACCOUNTS.bob);
});

test('mintTo issues sequential ids to the recipient and records the season', async () => {
  const fx = await deployQurrl();
  await openSeason(fx, 1);

  const res = await mintTo(fx, ACCOUNTS.alice, 3);
  const [event] = fx.nft.events(res, 'Minted');

  assert.equal(Number(event.args.seasonId), 1);
  assert.equal(event.args.to.toLowerCase(), ACCOUNTS.alice.toLowerCase());
  assert.equal(Number(event.args.firstTokenId), 1);
  assert.equal(Number(event.args.quantity), 3);
  assert.equal(Number(res.decoded[0]), 1, 'returns the first id');
  assert.equal(Number(await fx.nft.call('totalMinted')), 3);
  assert.equal(Number(await fx.nft.call('balanceOf', [ACCOUNTS.alice])), 3);
  assert.equal(Number(await fx.nft.call('balanceOf', [ACCOUNTS.seasonAdmin])), 0, 'the minter holds nothing');

  for (const tokenId of [1, 2, 3]) {
    assert.equal(await fx.nft.call('ownerOf', [tokenId]), ACCOUNTS.alice);
    const record = await fx.nft.call('recordOf', [tokenId]);
    assert.equal(Number(record.seasonId), 1);
    assert.equal(Number(record.generation), 1);
    assert.equal(record.traitsLocked, false);
  }
});

test('mintTo is confined to the mint window, and the fusion window does not reopen it', async () => {
  const fx = await deployQurrl();
  const opensAt = Number(fx.chain.timestamp) + DAY;
  const closesAt = opensAt + DAY;
  await openSeason(fx, 1, { opensAt, closesAt, primaryCap: 10, fusionCap: 2 });

  await expectRevert(mintTo(fx, ACCOUNTS.alice, 1), 'SeasonNotOpen');

  fx.chain.advanceTime(DAY);
  assert.equal(Number(fx.chain.timestamp), opensAt);
  await mintTo(fx, ACCOUNTS.alice, 2);

  fx.chain.advanceTime(DAY - 1);
  await mintTo(fx, ACCOUNTS.alice, 1);

  // At closesAt the mint window is over; the fusion window opens at the same instant.
  fx.chain.advanceTime(1);
  assert.equal(Number(fx.chain.timestamp), closesAt);
  await expectRevert(mintTo(fx, ACCOUNTS.alice, 1), 'SeasonNotOpen');

  await revealSeason(fx, 1);
  await fx.nft.send('fuse', [1, 2, [0, 0, 0, 0, 0, 0], 0, []], { from: ACCOUNTS.alice }); // the fusion window is open
  await expectRevert(mintTo(fx, ACCOUNTS.alice, 1), 'SeasonNotOpen');

  fx.chain.advanceTime(10 * DAY);
  await expectRevert(mintTo(fx, ACCOUNTS.alice, 1), 'SeasonNotOpen');
});

test('mintTo rejects zero quantity, the zero address and a sold-out season', async () => {
  const fx = await deployQurrl();
  await openSeason(fx, 1, { primaryCap: 2 });

  await expectRevert(mintTo(fx, ACCOUNTS.alice, 0), 'ZeroQuantity');
  await expectRevert(mintTo(fx, ZERO_ADDRESS, 1), 'ZeroAddress');
  await mintTo(fx, ACCOUNTS.alice, 2);
  await expectRevert(mintTo(fx, ACCOUNTS.bob, 1), 'SeasonSoldOut');
});

test('mintTo keeps whatever value the minter forwards', async () => {
  const fx = await deployQurrl();
  await openSeason(fx, 1);

  await mintTo(fx, ACCOUNTS.alice, 1);
  assert.equal(await fx.chain.balanceOf(fx.nft.address), 0n, 'a free pool forwards nothing');

  const fee = 3n * 10n ** 16n + 7n;
  await mintTo(fx, ACCOUNTS.alice, 2, { value: fee });
  assert.equal(await fx.chain.balanceOf(fx.nft.address), fee);

  // No price is enforced here: the amount is the minter's business.
  await mintTo(fx, ACCOUNTS.bob, 5, { value: 1n });
  assert.equal(await fx.chain.balanceOf(fx.nft.address), fee + 1n);
});

// Price checking, per-wallet limits and the Merkle allowlists moved off the
// collection into the phase minter; they are tested in test/QurrlPhaseMinter.test.js.

test('pausing halts minting without touching transfers', async () => {
  const fx = await deployQurrl();
  await openSeason(fx, 1);
  await mintTo(fx, ACCOUNTS.alice, 1);

  await fx.nft.send('pause', [], { from: ACCOUNTS.admin });
  await expectRevert(mintTo(fx, ACCOUNTS.alice, 1), 'Pausable: paused');

  await fx.nft.send('transferFrom', [ACCOUNTS.alice, ACCOUNTS.bob, 1], { from: ACCOUNTS.alice });
  assert.equal(await fx.nft.call('ownerOf', [1]), ACCOUNTS.bob);

  await fx.nft.send('unpause', [], { from: ACCOUNTS.admin });
  await mintTo(fx, ACCOUNTS.alice, 1);
});

test('fuse is confined to the fusion window, which follows the reveal, and takes the season own tokens', async () => {
  const fx = await deployQurrl();
  const { config } = await openSeason(fx, 1, { primaryCap: 6, fusionCap: 3 });
  assert.equal(config.fusionOpensAt, config.closesAt);
  await mintTo(fx, ACCOUNTS.alice, 6);

  // Inside the mint window: the fusion window has not opened.
  await expectRevert(fx.nft.send('fuse', [1, 2, [0, 0, 0, 0, 0, 0], 0, []], { from: ACCOUNTS.alice }), 'SeasonNotOpen');
  fx.chain.advanceTime(config.fusionOpensAt - Number(fx.chain.timestamp) - 1);
  await expectRevert(fx.nft.send('fuse', [1, 2, [0, 0, 0, 0, 0, 0], 0, []], { from: ACCOUNTS.alice }), 'SeasonNotOpen');

  // The reveal lands on fusionOpensAt; the season fuses its own tokens.
  const seed = await revealSeason(fx, 1);
  assert.equal(Number(fx.chain.timestamp), config.fusionOpensAt);
  const res = await fx.nft.send('fuse', [1, 2, [0, 0, 0, 0, 0, 0], 0, []], { from: ACCOUNTS.alice });
  const heir = Number(fx.nft.events(res, 'Fused')[0].args.tokenId);
  const record = await fx.nft.call('recordOf', [heir]);
  assert.equal(Number(record.seasonId), 1);
  assert.deepEqual((await fx.nft.call('traitsOf', [heir]))[0].map(Number), deriveTraits(seed, 1));

  fx.chain.advanceTime(config.fusionClosesAt - Number(fx.chain.timestamp) - 1);
  await fx.nft.send('fuse', [3, 4, [0, 0, 0, 0, 0, 0], 0, []], { from: ACCOUNTS.alice });

  fx.chain.advanceTime(1);
  await expectRevert(fx.nft.send('fuse', [5, 6, [0, 0, 0, 0, 0, 0], 0, []], { from: ACCOUNTS.alice }), 'SeasonNotOpen');
});

test('a fusion window may not open before the season reveal and must have length', async () => {
  const fx = await deployQurrl();
  const t = Number(fx.chain.timestamp);
  const closesAt = t + 5 * DAY;
  const revealAt = t + 10 * DAY;
  await fx.registry.send('commitSeed', [1, commitmentFor(1, seedFor(1)), revealAt], { from: ACCOUNTS.curator });
  const configure = (overrides) =>
    fx.nft.send('configureSeason', [1, seasonConfig(fx.chain, { closesAt, fusionCap: 2, ...overrides })], {
      from: ACCOUNTS.seasonAdmin,
    });

  // The default opens fusion at the close, which is before this season's reveal.
  await expectRevert(configure({}), 'FusionBeforeReveal');
  await expectRevert(configure({ fusionOpensAt: revealAt - 1, fusionClosesAt: revealAt + DAY }), 'FusionBeforeReveal');

  await expectRevert(configure({ fusionOpensAt: revealAt, fusionClosesAt: revealAt }), 'InvalidWindow');
  await expectRevert(configure({ fusionOpensAt: revealAt + DAY, fusionClosesAt: revealAt }), 'InvalidWindow');

  await configure({ fusionOpensAt: revealAt, fusionClosesAt: revealAt + 1 });
  const view = await fx.nft.call('seasonView', [1]);
  assert.equal(Number(view.config.fusionOpensAt), revealAt);
  assert.equal(Number(view.config.fusionClosesAt), revealAt + 1);
});

test('a season with no fusion budget ignores its fusion window', async () => {
  const fx = await deployQurrl();
  const t = Number(fx.chain.timestamp);
  await fx.registry.send('commitSeed', [1, commitmentFor(1, seedFor(1)), t + 30 * DAY], { from: ACCOUNTS.curator });
  await fx.nft.send(
    'configureSeason',
    [1, seasonConfig(fx.chain, { fusionCap: 0, fusionOpensAt: t, fusionClosesAt: t })],
    { from: ACCOUNTS.seasonAdmin },
  );
});

test('traits read as unrevealed until the season seed is disclosed', async () => {
  const fx = await deployQurrl();
  await openSeason(fx, 1);
  await mintTo(fx, ACCOUNTS.alice, 1);

  let [traits, revealed] = await fx.nft.call('traitsOf', [1]);
  assert.equal(revealed, false);
  assert.deepEqual(traits.map(Number), [0, 0, 0, 0, 0, 0]);

  const seed = await revealSeason(fx, 1);
  [traits, revealed] = await fx.nft.call('traitsOf', [1]);
  assert.equal(revealed, true);
  assert.deepEqual(traits.map(Number), deriveTraits(seed, 1));
});

test('reads on a token that was never minted revert', async () => {
  const fx = await deployQurrl();
  await expectRevert(fx.nft.call('traitsOf', [1]), 'UnknownToken');
  await expectRevert(fx.nft.call('recordOf', [1]), 'UnknownToken');
});

test('tokenURI delegates to the renderer: placeholder while sealed, id-addressed once revealed, frozen on request', async () => {
  const fx = await deployQurrl();
  await openSeason(fx, 1);
  await mintTo(fx, ACCOUNTS.alice, 1);

  assert.equal(await fx.nft.call('tokenURI', [1]), '', 'no renderer yet, no metadata');
  await expectRevert(fx.nft.call('tokenURI', [2]), 'ERC721: invalid token ID');
  await expectRevert(fx.nft.send('setRenderer', [ACCOUNTS.bob], { from: ACCOUNTS.mallory }));

  const meta = await fx.chain.deploy('QurrlMetadata', ['address', 'address'], [fx.nft.address, ACCOUNTS.admin]);
  await fx.nft.send('setRenderer', [meta.address], { from: ACCOUNTS.admin });
  await expectRevert(meta.send('setURIs', ['a', 'b'], { from: ACCOUNTS.mallory }));
  await meta.send('setURIs', ['ipfs://sealed.json', 'ipfs://qurrl/'], { from: ACCOUNTS.admin });

  assert.equal(await fx.nft.call('tokenURI', [1]), 'ipfs://sealed.json', 'sealed tokens all share one placeholder');

  await revealSeason(fx, 1);
  assert.equal(await fx.nft.call('tokenURI', [1]), 'ipfs://qurrl/1');

  await meta.send('freeze', [], { from: ACCOUNTS.admin });
  await expectRevert(meta.send('setURIs', ['x', 'y'], { from: ACCOUNTS.admin }), 'MetadataFrozen');
  assert.equal(await fx.nft.call('tokenURI', [1]), 'ipfs://qurrl/1');
});

test('a season whose window is already over is refused, not locked in with its supply', async () => {
  const fx = await deployQurrl();
  const t = Number(fx.chain.timestamp);
  await fx.registry.send('commitSeed', [1, commitmentFor(1, seedFor(1)), t + 10 * DAY], { from: ACCOUNTS.curator });
  const over = seasonConfig(fx.chain, { opensAt: t - 2 * DAY, closesAt: t - DAY });
  await expectRevert(fx.nft.send('configureSeason', [1, over], { from: ACCOUNTS.seasonAdmin }), 'WindowAlreadyOver');
  assert.equal(Number(await fx.nft.call('allocatedSupply')), 0, 'no supply was reserved');
});

test('a season whose window closes before its reveal moment is refused, one that closes after it is not', async () => {
  const fx = await deployQurrl();
  const seed = seedFor(1);
  const revealAt = Number(fx.chain.timestamp) + 10 * DAY;
  await fx.registry.send('commitSeed', [1, commitmentFor(1, seed), revealAt], { from: ACCOUNTS.curator });

  const late = seasonConfig(fx.chain, { closesAt: revealAt + 1 });
  await expectRevert(fx.nft.send('configureSeason', [1, late], { from: ACCOUNTS.seasonAdmin }), 'RevealBeforeClose');

  const ok = seasonConfig(fx.chain, { closesAt: revealAt });
  await fx.nft.send('configureSeason', [1, ok], { from: ACCOUNTS.seasonAdmin });
});

test('the treasury is withdrawable only by the treasurer, and only once funded', async () => {
  const fx = await deployQurrl();
  const price = 10n ** 17n;
  await openSeason(fx, 1);

  await expectRevert(fx.nft.send('withdraw', [ACCOUNTS.treasurer], { from: ACCOUNTS.treasurer }), 'NothingToWithdraw');

  await mintTo(fx, ACCOUNTS.alice, 3, { value: price * 3n });
  await expectRevert(fx.nft.send('withdraw', [ACCOUNTS.mallory], { from: ACCOUNTS.mallory }));
  await expectRevert(fx.nft.send('withdraw', ['0x' + '00'.repeat(20)], { from: ACCOUNTS.treasurer }), 'ZeroAddress');

  const before = await fx.chain.balanceOf(ACCOUNTS.bob);
  await fx.nft.send('withdraw', [ACCOUNTS.bob], { from: ACCOUNTS.treasurer });
  assert.equal(await fx.chain.balanceOf(ACCOUNTS.bob), before + price * 3n);
  assert.equal(await fx.chain.balanceOf(fx.nft.address), 0n);
});

test('ERC165 reports ERC721, metadata and AccessControl', async () => {
  const { nft } = await deployQurrl();
  for (const id of ['0x01ffc9a7', '0x80ac58cd', '0x5b5e139f', '0x7965db0b']) {
    assert.equal(await nft.call('supportsInterface', [id]), true, id);
  }
  assert.equal(await nft.call('supportsInterface', ['0xdeadbeef']), false);
});

test('a season with a zero allocation on both sides is rejected', async () => {
  const fx = await deployQurrl();
  await fx.registry.send('commitSeed', [1, commitmentFor(1, seedFor(1)), Number(fx.chain.timestamp) + 30 * DAY], { from: ACCOUNTS.curator });
  await expectRevert(
    fx.nft.send('configureSeason', [1, seasonConfig(fx.chain, { primaryCap: 0, fusionCap: 0 })], {
      from: ACCOUNTS.seasonAdmin,
    }),
    'ZeroQuantity',
  );
});

test('an unconfigured season reads back as absent', async () => {
  const fx = await deployQurrl();
  const view = await fx.nft.call('seasonView', [1]);
  assert.equal(view.exists, false);
  assert.equal(Number(view.config.primaryCap), 0);
  assert.equal(Number(view.config.fusionOpensAt), 0);
  assert.equal(Number(view.config.fusionClosesAt), 0);
});

test('royalty: off until set, admin-only, capped at 5%, and the amount follows the rate', async () => {
  const fx = await deployQurrl();
  const [none, zero] = await fx.nft.call('royaltyInfo', [1, 1000n]);
  assert.equal(zero, 0n);
  assert.equal(none, '0x' + '00'.repeat(20));

  await expectRevert(fx.nft.send('setRoyalty', [ACCOUNTS.alice, 250], { from: ACCOUNTS.mallory }));
  await expectRevert(fx.nft.send('setRoyalty', [ACCOUNTS.alice, 501], { from: ACCOUNTS.admin }), 'RoyaltyOutOfRange');
  await expectRevert(fx.nft.send('setRoyalty', ['0x' + '00'.repeat(20), 250], { from: ACCOUNTS.admin }), 'RoyaltyOutOfRange');

  await fx.nft.send('setRoyalty', [ACCOUNTS.alice, 250], { from: ACCOUNTS.admin });
  const [receiver, amount] = await fx.nft.call('royaltyInfo', [9999, 10_000n]);
  assert.equal(receiver.toLowerCase(), ACCOUNTS.alice.toLowerCase());
  assert.equal(amount, 250n, '2.5% of 10,000, for any token id');

  await fx.nft.send('setRoyalty', [ACCOUNTS.alice, 0], { from: ACCOUNTS.admin });
  assert.equal((await fx.nft.call('royaltyInfo', [1, 10_000n]))[1], 0n, 'zero disables it');
});

test('royalty: the royalty interface id is advertised alongside the existing ones', async () => {
  const fx = await deployQurrl();
  assert.equal(await fx.nft.call('supportsInterface', ['0x2a55205a']), true);
  assert.equal(await fx.nft.call('supportsInterface', ['0x80ac58cd']), true, 'ERC721 still reported');
  assert.equal(await fx.nft.call('supportsInterface', ['0xffffffff']), false);
});
