const test = require('node:test');
const assert = require('node:assert/strict');

const { Chain, ACCOUNTS, role, DEFAULT_ADMIN_ROLE } = require('./harness');
const {
  commitmentFor,
  deriveTraits,
  effectiveSeed,
  expectRevert,
  seedFor,
  PALETTE,
  weightsFor,
  MANIFEST_HASH,
  DAY,
} = require('./fixtures');

async function bareRegistry({ palette = true } = {}) {
  const chain = await Chain.create();
  const registry = await chain.deploy('QurrlTraitRegistry', ['address'], [ACCOUNTS.admin]);
  await registry.send('grantRole', [role('CURATOR_ROLE'), ACCOUNTS.curator], { from: ACCOUNTS.admin });
  if (palette) {
    for (const [slot, entry] of PALETTE.entries()) {
      await registry.send('setCategory', [slot, entry.weights], { from: ACCOUNTS.curator });
    }
    await registry.send('sealPalette', [], { from: ACCOUNTS.admin });
    await registry.send('commitManifest', [MANIFEST_HASH], { from: ACCOUNTS.curator });
  }
  return { chain, registry };
}

const notBefore = (chain, days = 30) => Number(chain.timestamp) + days * DAY;

async function commit(ctx, seasonId, days = 30) {
  const at = notBefore(ctx.chain, days);
  await ctx.registry.send('commitSeed', [seasonId, commitmentFor(seasonId, seedFor(seasonId)), at], {
    from: ACCOUNTS.curator,
  });
  return at;
}

test('constructor grants admin and curator to the deployer nominee', async () => {
  const { registry } = await bareRegistry({ palette: false });
  assert.equal(await registry.call('hasRole', [DEFAULT_ADMIN_ROLE, ACCOUNTS.admin]), true);
  assert.equal(await registry.call('hasRole', [role('CURATOR_ROLE'), ACCOUNTS.admin]), true);
});

test('constructor rejects a zero admin', async () => {
  const chain = await Chain.create();
  await assert.rejects(
    chain.deploy('QurrlTraitRegistry', ['address'], ['0x' + '00'.repeat(20)]),
    /deploy QurrlTraitRegistry failed/,
  );
});

test('palette editing is curator-gated and validates the weights', async () => {
  const { registry } = await bareRegistry({ palette: false });
  const ok = weightsFor(8);

  await expectRevert(registry.send('setCategory', [0, ok], { from: ACCOUNTS.mallory }));
  await expectRevert(registry.send('setCategory', [0, []], { from: ACCOUNTS.curator }), 'InvalidVariantCount');
  await expectRevert(
    registry.send('setCategory', [0, Array(33).fill(300)], { from: ACCOUNTS.curator }),
    'InvalidVariantCount',
  );
  await expectRevert(registry.send('setCategory', [6, ok], { from: ACCOUNTS.curator }), 'UnknownTraitSlot');
  await expectRevert(registry.send('setCategory', [0, [5000, 4000]], { from: ACCOUNTS.curator }), 'InvalidWeights');
  await expectRevert(registry.send('setCategory', [0, [5000, 5000, 1]], { from: ACCOUNTS.curator }), 'InvalidWeights');
  await expectRevert(registry.send('setCategory', [0, [10000, 0]], { from: ACCOUNTS.curator }), 'InvalidWeights');

  await registry.send('setCategory', [0, ok], { from: ACCOUNTS.curator });
  assert.equal(Number((await registry.call('palette'))[0]), 8);
  assert.deepEqual((await registry.call('weightsOf', [0])).map(Number), ok, 'weights round-trip through the cumulative table');
});

test('sealing needs every slot, is admin-only, irreversible, and freezes the weights', async () => {
  const { registry } = await bareRegistry({ palette: false });
  await expectRevert(registry.send('sealPalette', [], { from: ACCOUNTS.admin }), 'InvalidVariantCount');

  for (const [slot, entry] of PALETTE.entries()) {
    await registry.send('setCategory', [slot, entry.weights], { from: ACCOUNTS.curator });
  }
  await expectRevert(registry.send('sealPalette', [], { from: ACCOUNTS.curator }));
  await registry.send('sealPalette', [], { from: ACCOUNTS.admin });

  assert.equal(await registry.call('paletteFrozen'), true);
  await expectRevert(registry.send('sealPalette', [], { from: ACCOUNTS.admin }), 'PaletteFrozen');
  await expectRevert(registry.send('setCategory', [0, weightsFor(8)], { from: ACCOUNTS.curator }), 'PaletteFrozen');
});

test('the registry exposes no names: there is no function to read one', async () => {
  const { registry } = await bareRegistry();
  const names = registry.iface.fragments.filter((f) => f.type === 'function').map((f) => f.name);
  assert.ok(!names.some((n) => /name/i.test(n)), `unexpected name accessor in ${names.join(', ')}`);
});

test('a commitment is write-once and must name a future reveal time', async () => {
  const ctx = await bareRegistry();
  const c = commitmentFor(1, seedFor(1));

  await expectRevert(ctx.registry.send('commitSeed', [1, c, 5], { from: ACCOUNTS.curator }), 'RevealTimeInvalid');
  await expectRevert(
    ctx.registry.send('commitSeed', [1, '0x' + '00'.repeat(32), notBefore(ctx.chain)], { from: ACCOUNTS.curator }),
    'SeedMismatch',
  );
  await expectRevert(ctx.registry.send('commitSeed', [1, c, notBefore(ctx.chain)], { from: ACCOUNTS.mallory }));

  const at = await commit(ctx, 1);
  assert.equal(await ctx.registry.call('hasCommitment', [1]), true);
  assert.equal(Number(await ctx.registry.call('revealNotBeforeOf', [1])), at);
  await expectRevert(ctx.registry.send('commitSeed', [1, c, at], { from: ACCOUNTS.curator }), 'SeedAlreadyCommitted');
});

test('the curator cannot reveal before the committed moment, nor with the wrong seed', async () => {
  const ctx = await bareRegistry();
  const at = await commit(ctx, 1);

  await expectRevert(ctx.registry.send('revealSeed', [1, seedFor(1)], { from: ACCOUNTS.curator }), 'RevealTooEarly');

  ctx.chain.advanceTime(at - Number(ctx.chain.timestamp));
  await expectRevert(ctx.registry.send('revealSeed', [1, seedFor(2)], { from: ACCOUNTS.curator }), 'SeedMismatch');
  await expectRevert(ctx.registry.send('revealSeed', [1, seedFor(1)], { from: ACCOUNTS.mallory }));
  await expectRevert(ctx.registry.send('revealSeed', [2, seedFor(2)], { from: ACCOUNTS.curator }), 'SeedNotCommitted');
});

test('the curator can no longer reveal once the 14-day window has passed, so a default never races a reveal', async () => {
  const ctx = await bareRegistry();
  const at = await commit(ctx, 1);
  ctx.chain.advanceTime(at - Number(ctx.chain.timestamp) + 14 * DAY + 1);

  await expectRevert(ctx.registry.send('revealSeed', [1, seedFor(1)], { from: ACCOUNTS.curator }), 'RevealWindowClosed');
  await ctx.registry.send('revealDefault', [1], { from: ACCOUNTS.mallory });
});

test('a reveal cannot be scheduled further out than 400 days, so the default always becomes callable', async () => {
  const ctx = await bareRegistry();
  const c = commitmentFor(1, seedFor(1));
  await expectRevert(
    ctx.registry.send('commitSeed', [1, c, Number(ctx.chain.timestamp) + 401 * DAY], { from: ACCOUNTS.curator }),
    'RevealTimeInvalid',
  );
  await expectRevert(
    ctx.registry.send('commitSeed', [1, c, 2n ** 64n - 1n], { from: ACCOUNTS.curator }),
    'RevealTimeInvalid',
  );
  await ctx.registry.send('commitSeed', [1, c, Number(ctx.chain.timestamp) + 400 * DAY], { from: ACCOUNTS.curator });
});

test('the commitment binds the season: a disclosed seed cannot be re-committed for another', async () => {
  const ctx = await bareRegistry();
  await ctx.registry.send('commitSeed', [2, commitmentFor(1, seedFor(1)), notBefore(ctx.chain)], { from: ACCOUNTS.curator });
  ctx.chain.advanceTime(31 * DAY);
  await expectRevert(ctx.registry.send('revealSeed', [2, seedFor(1)], { from: ACCOUNTS.curator }), 'SeedMismatch');
});

test('the effective seed mixes the curator seed with block entropy, and the event shows both', async () => {
  const ctx = await bareRegistry();
  const at = await commit(ctx, 1);
  ctx.chain.advanceTime(at - Number(ctx.chain.timestamp));

  const res = await ctx.registry.send('revealSeed', [1, seedFor(1)], { from: ACCOUNTS.curator });
  const [ev] = ctx.registry.events(res, 'SeedRevealed');

  assert.equal(ev.args.curatorSeed, seedFor(1));
  assert.equal(ev.args.defaulted, false);
  assert.equal(ev.args.effectiveSeed, effectiveSeed(seedFor(1), ev.args.entropy), 'anyone can recompute it from the event');
  assert.equal(await ctx.registry.call('seedOf', [1]), ev.args.effectiveSeed);
  assert.notEqual(ev.args.effectiveSeed, seedFor(1), 'the curator seed alone no longer determines traits');
  assert.equal(await ctx.registry.call('isRevealed', [1]), true);
  await expectRevert(ctx.registry.send('revealSeed', [1, seedFor(1)], { from: ACCOUNTS.curator }), 'SeedAlreadyRevealed');
});

test('entropy differs between blocks, so the curator cannot precompute a reveal', async () => {
  const a = await bareRegistry();
  const b = await bareRegistry();
  const atA = await commit(a, 1);
  const atB = await commit(b, 1);
  a.chain.advanceTime(atA - Number(a.chain.timestamp));
  b.chain.advanceTime(atB - Number(b.chain.timestamp) + 5 * DAY);

  await a.registry.send('revealSeed', [1, seedFor(1)], { from: ACCOUNTS.curator });
  await b.registry.send('revealSeed', [1, seedFor(1)], { from: ACCOUNTS.curator });
  assert.notEqual(await a.registry.call('seedOf', [1]), await b.registry.call('seedOf', [1]));
});

test('a curator who never reveals cannot hold the season sealed: anyone defaults it after 14 days', async () => {
  const ctx = await bareRegistry();
  const at = await commit(ctx, 1);

  await expectRevert(ctx.registry.send('revealDefault', [1], { from: ACCOUNTS.mallory }), 'RevealTooEarly');
  ctx.chain.advanceTime(at - Number(ctx.chain.timestamp) + 13 * DAY);
  await expectRevert(ctx.registry.send('revealDefault', [1], { from: ACCOUNTS.mallory }), 'RevealTooEarly');
  ctx.chain.advanceTime(2 * DAY);
  await expectRevert(ctx.registry.send('revealDefault', [9], { from: ACCOUNTS.mallory }), 'SeedNotCommitted');

  const res = await ctx.registry.send('revealDefault', [1], { from: ACCOUNTS.mallory });
  const [ev] = ctx.registry.events(res, 'SeedRevealed');
  assert.equal(ev.args.defaulted, true);
  assert.equal(ev.args.curatorSeed, '0x' + '00'.repeat(32));
  assert.equal(ev.args.effectiveSeed, effectiveSeed(ev.args.curatorSeed, ev.args.entropy));

  const traits = (await ctx.registry.call('deriveTraits', [1, 1])).map(Number);
  assert.equal(traits.length, 6);
  await expectRevert(ctx.registry.send('revealSeed', [1, seedFor(1)], { from: ACCOUNTS.curator }), 'SeedAlreadyRevealed');
});

test('deriving traits before the reveal reverts', async () => {
  const ctx = await bareRegistry();
  await commit(ctx, 1);
  await expectRevert(ctx.registry.call('deriveTraits', [1, 1]), 'TraitsNotRevealed');
});

test('on-chain derivation matches the off-chain mirror and stays inside each slot', async () => {
  const ctx = await bareRegistry();
  const at = await commit(ctx, 1);
  ctx.chain.advanceTime(at - Number(ctx.chain.timestamp));
  await ctx.registry.send('revealSeed', [1, seedFor(1)], { from: ACCOUNTS.curator });
  const effective = await ctx.registry.call('seedOf', [1]);

  for (const tokenId of [1, 2, 3, 500, 10500]) {
    const onChain = (await ctx.registry.call('deriveTraits', [1, tokenId])).map(Number);
    assert.deepEqual(onChain, deriveTraits(effective, tokenId), `token ${tokenId}`);
    for (const [slot, value] of onChain.entries()) {
      assert.ok(value < PALETTE[slot].variants, `slot ${slot} out of range`);
    }
  }
});

test('the same token id gets different traits in different seasons', async () => {
  const ctx = await bareRegistry();
  const at = await commit(ctx, 1);
  await commit(ctx, 2);
  ctx.chain.advanceTime(at - Number(ctx.chain.timestamp));
  for (const seasonId of [1, 2]) {
    await ctx.registry.send('revealSeed', [seasonId, seedFor(seasonId)], { from: ACCOUNTS.curator });
  }
  const a = (await ctx.registry.call('deriveTraits', [1, 7])).map(Number);
  const b = (await ctx.registry.call('deriveTraits', [2, 7])).map(Number);
  assert.notDeepEqual(a, b);
});

test('rarity is by design: the realised frequencies follow the weights', async () => {
  // Pure mirror test of the derivation over 10,500 ids, checked against the weights
  // with a tolerance of five standard deviations. The on-chain function is pinned to
  // the mirror above, so this is the statement about the collection itself.
  const effective = effectiveSeed(seedFor(1), seedFor(2));
  const N = 10500;
  const counts = PALETTE.map((s) => Array(s.variants).fill(0));
  for (let id = 1; id <= N; id += 1) {
    deriveTraits(effective, id).forEach((v, slot) => (counts[slot][v] += 1));
  }
  for (const [slot, entry] of PALETTE.entries()) {
    entry.weights.forEach((w, j) => {
      const p = w / 10000;
      const expected = N * p;
      const sd = Math.sqrt(N * p * (1 - p));
      assert.ok(
        Math.abs(counts[slot][j] - expected) <= 5 * sd + 1,
        `slot ${slot} variant ${j}: got ${counts[slot][j]}, expected ${expected.toFixed(1)} +/- ${(5 * sd).toFixed(1)}`,
      );
    });
  }
  const rarest = Math.min(...PALETTE.flatMap((s, i) => counts[i]));
  assert.ok(rarest > 0, 'even the rarest variant appears');
});

test('the trait manifest is write-once, non-zero, curator-only, and required before any seed', async () => {
  const { registry } = await bareRegistry({ palette: false });
  const c = commitmentFor(1, seedFor(1));
  const at = Number((await registry.call('revealNotBeforeOf', [1])).toString()) + 10 * DAY || 10 * DAY;

  await expectRevert(registry.send('commitSeed', [1, c, 2_000_000_000], { from: ACCOUNTS.curator }), 'ManifestNotCommitted');
  await expectRevert(registry.send('commitManifest', [MANIFEST_HASH], { from: ACCOUNTS.mallory }));
  await expectRevert(registry.send('commitManifest', ['0x' + '00'.repeat(32)], { from: ACCOUNTS.curator }), 'ManifestInvalid');

  assert.equal(await registry.call('manifestOf'), '0x' + '00'.repeat(32));
  await registry.send('commitManifest', [MANIFEST_HASH], { from: ACCOUNTS.curator });
  assert.equal(await registry.call('manifestOf'), MANIFEST_HASH);
  await expectRevert(registry.send('commitManifest', [MANIFEST_HASH], { from: ACCOUNTS.curator }), 'ManifestAlreadyCommitted');
  assert.ok(at > 0);
});
