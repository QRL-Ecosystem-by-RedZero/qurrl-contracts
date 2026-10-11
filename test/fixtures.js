/**
 * Shared deployment fixture, season helpers and the off-chain mirrors of the
 * two hash constructions the contracts rely on.
 *
 * `deriveTraits`, the minter leaves and `paramKey` are reimplemented here rather than read
 * back from the chain on purpose: a test that asks the contract what it thinks
 * the answer is cannot catch the contract being wrong.
 */
const assert = require('node:assert/strict');
const { keccak256, AbiCoder, getBytes, concat, solidityPacked, toUtf8Bytes } = require('ethers');
const { Chain, ACCOUNTS, role, DEFAULT_ADMIN_ROLE } = require('./harness');

const coder = AbiCoder.defaultAbiCoder();

const DAY = 86400;
const MANIFEST_HASH = keccak256(coder.encode(['string'], ['test-manifest']));
const ZERO32 = '0x' + '00'.repeat(32);
const MAX_SUPPLY = 10500;

/**
 * Placeholder palette: variant counts and rarity weights only. Hand-written
 * here, not imported from scripts/collection.js, for the reason this file
 * exists: a test that asks the code under test for its own expected value
 * cannot catch the code being wrong.
 */
function weightsFor(n) {
  const rest = Array.from({ length: n - 1 }, (_, j) => 400 + (n - 1 - j) * 50);
  return [10000 - rest.reduce((a, b) => a + b, 0), ...rest];
}
const PALETTE = [8, 10, 8, 12, 12, 6].map((variants) => ({ variants, weights: weightsFor(variants) }));

const COLLECTION = {
  name: 'Qurrl',
  symbol: 'QURRL',
};

function seedFor(seasonId) {
  return keccak256(coder.encode(['string', 'uint16'], ['qurrl-season-seed', seasonId]));
}

/** Must match `QurrlTraitRegistry.revealSeed`. Binds the season, not just the seed. */
function commitmentFor(seasonId, seed) {
  return keccak256(solidityPacked(['uint16', 'bytes32'], [seasonId, seed]));
}

/** Must match `QurrlTraitRegistry.deriveTraits`: 32 bits per slot against the cumulative weights. */
function deriveTraits(effectiveSeed, tokenId, palette = PALETTE) {
  const digest = BigInt(keccak256(solidityPacked(['bytes32', 'uint256'], [effectiveSeed, tokenId])));
  return palette.map((slot, i) => {
    const draw = Number(((digest >> BigInt(i * 32)) & 0xffffffffn) % 10000n);
    let cum = 0;
    for (let j = 0; j < slot.weights.length; j += 1) {
      cum += slot.weights[j];
      if (draw < cum) return j;
    }
    throw new Error('weights do not sum to 10,000');
  });
}

/** Must match `QurrlTraitRegistry._finish`. */
function effectiveSeed(curatorSeed, entropy) {
  return keccak256(solidityPacked(['bytes32', 'bytes32'], [curatorSeed, entropy]));
}

/** Must match `QurrlPhaseMinter.mintGenesis`. Double-hashed, per OZ convention. */
function genesisLeaf(address) {
  return keccak256(getBytes(keccak256(solidityPacked(['address'], [address]))));
}

/** Must match `QurrlPhaseMinter.mintAcorn`: the account and its cumulative EARNED points. */
function acornLeaf(address, earned) {
  return keccak256(getBytes(keccak256(solidityPacked(['address', 'uint64'], [address, earned]))));
}

/**
 * Must match `QurrlNFT._plan`: the generation-weighted draw for a slot left to chance.
 * Returns true when the slot comes from parent A.
 */
function drawFromA(effective, a, b, slot, genA, genB) {
  const digest = BigInt(keccak256(solidityPacked(['bytes32', 'uint256', 'uint256', 'uint8'], [effective, a, b, slot])));
  return digest % BigInt(genA + genB) < BigInt(genA);
}

/** Must match `QurrlPhaseMinter.keyOf`: the field name, an at-sign and the phase digit. */
function paramKey(field, phase) {
  return keccak256(toUtf8Bytes(`${field}@${phase}`));
}

/** Sorted-pair Merkle tree, matching OpenZeppelin MerkleProof.verify. */
function merkleTree(leaves) {
  const layers = [leaves.slice()];
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1];
    const next = [];
    for (let i = 0; i < prev.length; i += 2) {
      if (i + 1 === prev.length) next.push(prev[i]);
      else {
        const [a, b] = [prev[i], prev[i + 1]].sort();
        next.push(keccak256(concat([a, b])));
      }
    }
    layers.push(next);
  }
  return {
    root: layers[layers.length - 1][0],
    proof(leaf) {
      let idx = layers[0].indexOf(leaf);
      assert.notEqual(idx, -1, 'leaf not in tree');
      const proof = [];
      for (let l = 0; l < layers.length - 1; l++) {
        const sibling = idx % 2 === 0 ? idx + 1 : idx - 1;
        if (sibling < layers[l].length) proof.push(layers[l][sibling]);
        idx = Math.floor(idx / 2);
      }
      return proof;
    },
  };
}

/**
 * Deploys the collection with the palette sealed and the role graph
 * `scripts/deploy.js` establishes.
 */
async function deployQurrl() {
  const chain = await Chain.create();

  const registry = await chain.deploy('QurrlTraitRegistry', ['address'], [ACCOUNTS.admin]);
  for (const [slot, entry] of PALETTE.entries()) {
    await registry.send('setCategory', [slot, entry.weights], { from: ACCOUNTS.admin });
  }
  await registry.send('sealPalette', [], { from: ACCOUNTS.admin });
  await registry.send('commitManifest', [MANIFEST_HASH], { from: ACCOUNTS.admin });

  const nft = await chain.deploy(
    'QurrlNFT',
    ['string', 'string', 'address', 'address'],
    [COLLECTION.name, COLLECTION.symbol, ACCOUNTS.admin, registry.address],
  );
  const lens = await chain.deploy('QurrlLens', ['address', 'address'], [nft.address, registry.address]);
  const acorn = await chain.deploy('AcornRootDouble', [], []);
  await nft.send('setAcornSource', [acorn.address], { from: ACCOUNTS.admin });

  await registry.send('grantRole', [role('CURATOR_ROLE'), ACCOUNTS.curator], { from: ACCOUNTS.admin });
  await nft.send('grantRole', [role('SEASON_ADMIN_ROLE'), ACCOUNTS.seasonAdmin], { from: ACCOUNTS.admin });
  await nft.send('grantRole', [role('TREASURER_ROLE'), ACCOUNTS.treasurer], { from: ACCOUNTS.admin });
  // The collection-level suite mints directly; in a deployment only QurrlPhaseMinter holds this.
  await nft.send('grantRole', [role('MINTER_ROLE'), ACCOUNTS.seasonAdmin], { from: ACCOUNTS.admin });

  return { chain, registry, nft, lens, acorn };
}

/**
 * Season defaults: mint window open now for 30 days, no fusion. A season with a
 * fusion budget gets a 30-day fusion window from its reveal (= its close) unless the
 * override names one.
 */
function seasonConfig(chain, overrides = {}) {
  const opensAt = Number(chain.timestamp);
  const closesAt = overrides.closesAt ?? opensAt + 30 * DAY;
  const fusionOpensAt = overrides.fusionOpensAt ?? ((overrides.fusionCap ?? 0) > 0 ? closesAt : 0);
  return {
    primaryCap: 105,
    fusionCap: 0,
    opensAt,
    closesAt,
    fusionOpensAt,
    fusionClosesAt: overrides.fusionClosesAt ?? (fusionOpensAt ? fusionOpensAt + 30 * DAY : 0),
    fusionFee: 0n,
    lockBaseFee: 0n,
    ...overrides,
  };
}

/** Commit the seed (reveal at the close), configure the season, point the mint at it. */
async function openSeason(fx, seasonId, overrides = {}) {
  const seed = seedFor(seasonId);
  const config = seasonConfig(fx.chain, overrides);

  await fx.registry.send('commitSeed', [seasonId, commitmentFor(seasonId, seed), config.closesAt], { from: ACCOUNTS.curator });
  await fx.nft.send('configureSeason', [seasonId, config], { from: ACCOUNTS.seasonAdmin });
  await fx.nft.send('setActiveSeason', [seasonId], { from: ACCOUNTS.seasonAdmin });

  return { seed, config };
}

/** Primary mint through MINTER_ROLE (held by `seasonAdmin` in this suite). */
function mintTo(fx, to, quantity, opts = {}) {
  return fx.nft.send('mintTo', [to, quantity], { from: ACCOUNTS.seasonAdmin, ...opts });
}

/**
 * Walks the clock to the moment the registry allows a reveal, reveals, and
 * returns the effective seed (what traits are derived from), not the curator
 * seed. Revealing therefore always closes the window it belongs to.
 */
async function revealSeason(fx, seasonId) {
  const notBefore = Number(await fx.registry.call('revealNotBeforeOf', [seasonId]));
  const now = Number(fx.chain.timestamp);
  if (now < notBefore) fx.chain.advanceTime(notBefore - now);
  await fx.registry.send('revealSeed', [seasonId, seedFor(seasonId)], { from: ACCOUNTS.curator });
  return fx.registry.call('seedOf', [seasonId]);
}

/** Asserts the call reverts, and that the custom error is exactly `name`. */
async function expectRevert(promise, name) {
  try {
    await promise;
  } catch (e) {
    assert.equal(e.reverted, true, `expected a revert, got: ${e.message}`);
    if (name) assert.equal(e.message, name, `expected revert ${name}, got ${e.message}`);
    return e;
  }
  assert.fail(`expected revert ${name || ''} but the call succeeded`);
}

module.exports = {
  deployQurrl,
  seasonConfig,
  openSeason,
  revealSeason,
  seedFor,
  commitmentFor,
  deriveTraits,
  effectiveSeed,
  weightsFor,
  genesisLeaf,
  acornLeaf,
  drawFromA,
  paramKey,
  mintTo,
  merkleTree,
  expectRevert,
  ACCOUNTS,
  role,
  DEFAULT_ADMIN_ROLE,
  PALETTE,
  COLLECTION,
  MAX_SUPPLY,
  MANIFEST_HASH,
  DAY,
  ZERO32,
  coder,
};
