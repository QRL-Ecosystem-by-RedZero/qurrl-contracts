/**
 * The collection's off-chain constants and the hash constructions the
 * contracts depend on.
 *
 * Season seeds are derived from a single secret in `.env` rather than picked at
 * random per season. A seed that cannot be reproduced at reveal time is a seed
 * that seals its season forever, and there is no recovery path: `revealSeed`
 * only accepts the preimage of a commitment already on chain.
 */
const { keccak256, AbiCoder, getBytes, toUtf8Bytes, solidityPacked } = require('ethers');

const coder = AbiCoder.defaultAbiCoder();

const MAX_SUPPLY = 10500;
const DAY = 86400;

/**
 * Rarity weights for a slot with `n` variants, in basis points summing to
 * exactly 10,000, each at least 1. Geometric: every variant is `ratio` times
 * as likely as the one before it.
 *
 * DEV PLACEHOLDER. The real variant counts and weights are the project's to
 * decide and, once chosen, are sealed on chain with the palette. They are
 * numbers only: this file deliberately carries no trait or slot names, and the
 * private manifest that does lives outside the repository (CLAUDE.md "Trait
 * confidentiality").
 */
function tieredWeights(n, ratio = 0.62) {
  const raw = Array.from({ length: n }, (_, j) => ratio ** j);
  const sum = raw.reduce((a, b) => a + b, 0);
  const weights = raw.map((r) => Math.max(1, Math.floor((r / sum) * 10000)));
  // Rounding dust goes to the most common variant, which can absorb it.
  weights[0] += 10000 - weights.reduce((a, b) => a + b, 0);
  return weights;
}

/**
 * Placeholder palette: six slots and their variant counts. Slot order is
 * load-bearing (the metadata pipeline and `deriveTraits` index by it), so
 * append, never reorder. No names: see tieredWeights.
 */
const PALETTE = [8, 10, 8, 12, 12, 6].map((variants) => ({ variants, weights: tieredWeights(variants) }));

/**
 * The shipped schedule (QuantumArk-Phases.md section 5): one ecosystem phase is one
 * on-chain season, `seasonId = phase + 1`, five seasons in all. `QurrlPhaseMinter`
 * receives the five rows in its constructor and configures each season from its row
 * when `openPhase` runs, so this table is what the chain enforces.
 *
 *   primary 7,350 (Acorn pool 2,310 incl. the 105 genesis, QRL pool 5,040)
 *   + fusion 3,150 = 10,500 issued; a fully spent fusion budget burns 6,300,
 *   leaving a 4,200 circulating floor.
 *
 * Inside a season the mint window runs first (both pools side by side), then the
 * fusion window opens at the season's reveal, so the season's own tokens can be
 * fused. Spending a phase's fusion budget needs at most 57.2% of the revealed
 * circulating supply at that moment; test/Supply.test.js checks this against an
 * independent copy.
 *
 * Phase 0 is the genesis whitelist (`setGenesis`, built off chain from Acorn
 * >= GENESIS_MIN_ACORNS), free. From phase 1, `reqPts` is the Acorn points spent per
 * token and `mintFee` the QRL price per token; the owner may move either inside
 * [min, max] for the phase in force. Amounts in wei. Durations are PLACEHOLDERS.
 */
const QRL = 10n ** 18n;
const MINT_DURATION = 30 * DAY;
const FUSION_DURATION = 30 * DAY;
const GENESIS_MIN_ACORNS = 2001;

const PHASES = [
  {
    phase: 0, codename: 'Genesis Inventory',
    acornCap: 105, qrlCap: 0, fusionCap: 0,
    reqPts: 0, reqPtsMin: 0, reqPtsMax: 0,
    mintFee: 0n, mintFeeMin: 0n, mintFeeMax: 0n, fusionFee: 0n, lockBaseFee: 0n,
    walletLimit: 0, mintDuration: MINT_DURATION, fusionDuration: 0,
  },
  {
    phase: 1, codename: 'Lattice Shift',
    acornCap: 525, qrlCap: 210, fusionCap: 210,
    reqPts: 2000, reqPtsMin: 1000, reqPtsMax: 4000,
    mintFee: 1n * QRL, mintFeeMin: QRL / 2n, mintFeeMax: 2n * QRL, fusionFee: 0n, lockBaseFee: QRL,
    walletLimit: 2, mintDuration: MINT_DURATION, fusionDuration: FUSION_DURATION,
  },
  {
    phase: 2, codename: 'Classical Sunset',
    acornCap: 735, qrlCap: 840, fusionCap: 630,
    reqPts: 1500, reqPtsMin: 750, reqPtsMax: 3000,
    mintFee: 2n * QRL, mintFeeMin: 1n * QRL, mintFeeMax: 4n * QRL, fusionFee: QRL / 2n, lockBaseFee: QRL,
    walletLimit: 3, mintDuration: MINT_DURATION, fusionDuration: FUSION_DURATION,
  },
  {
    phase: 3, codename: 'Q-Day',
    acornCap: 630, qrlCap: 1575, fusionCap: 1050,
    reqPts: 1000, reqPtsMin: 500, reqPtsMax: 2000,
    mintFee: 3n * QRL, mintFeeMin: (3n * QRL) / 2n, mintFeeMax: 6n * QRL, fusionFee: QRL / 2n, lockBaseFee: QRL,
    walletLimit: 5, mintDuration: MINT_DURATION, fusionDuration: FUSION_DURATION,
  },
  {
    phase: 4, codename: 'Restoration',
    acornCap: 315, qrlCap: 2415, fusionCap: 1260,
    reqPts: 1000, reqPtsMin: 500, reqPtsMax: 2000,
    mintFee: 4n * QRL, mintFeeMin: 2n * QRL, mintFeeMax: 8n * QRL, fusionFee: QRL / 2n, lockBaseFee: QRL,
    walletLimit: 10, mintDuration: MINT_DURATION, fusionDuration: FUSION_DURATION,
  },
];

/** `IQurrlPhaseMinter.PhaseRow`, in declaration order. The order is the ABI: never reorder. */
const PHASE_ROW_FIELDS = [
  'acornCap',
  'qrlCap',
  'fusionCap',
  'reqPts',
  'reqPtsMin',
  'reqPtsMax',
  'mintFee',
  'mintFeeMin',
  'mintFeeMax',
  'fusionFee',
  'walletLimit',
  'mintDuration',
  'fusionDuration',
  'lockBaseFee',
];

/** The five `PhaseRow`s for the `QurrlPhaseMinter` constructor, keys in field order. */
const PHASE_ROWS = PHASES.map((p) => Object.fromEntries(PHASE_ROW_FIELDS.map((f) => [f, p[f]])));

/** A row as a positional tuple of decimal strings, which every encoder on both lines accepts. */
function phaseRowTuple(row) {
  return PHASE_ROW_FIELDS.map((f) => row[f].toString());
}

const ZERO32 = '0x' + '00'.repeat(32);

/** Deterministic season seed. Reproducible from the secret alone. */
function seedFor(secret, seasonId) {
  return keccak256(coder.encode(['bytes32', 'uint16'], [keccak256(toUtf8Bytes(secret)), seasonId]));
}

/** Must match `QurrlTraitRegistry.revealSeed`: the commitment binds the season. */
function commitmentFor(seasonId, seed) {
  return keccak256(solidityPacked(['uint16', 'bytes32'], [seasonId, seed]));
}

/**
 * Must match `QurrlTraitRegistry._finish`: what traits are actually derived
 * from. `curatorSeed` is the committed preimage (bytes32(0) on a defaulted
 * reveal) and `entropy` is read from the SeedRevealed event.
 */
function effectiveSeed(curatorSeed, entropy) {
  return keccak256(solidityPacked(['bytes32', 'bytes32'], [curatorSeed, entropy]));
}

/** Must match `QurrlTraitRegistry.deriveTraits`: 32 bits per slot against the cumulative weights. */
function deriveTraits(effective, tokenId, palette = PALETTE) {
  const digest = BigInt(keccak256(solidityPacked(['bytes32', 'uint256'], [effective, tokenId])));
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

/**
 * The packed address: 20 bytes on v2, 64 on QIP-55 (v3). A leaf must use the width
 * of the line it is verified on, so a tree is built per line.
 */
function addressBytes(addressHex) {
  return '0x' + String(addressHex).replace(/^(Q|0x)/i, '').toLowerCase();
}

/** Must match `QurrlPhaseMinter.mintGenesis`. Double-hashed, per OZ convention. */
function genesisLeaf(addressHex) {
  return keccak256(getBytes(keccak256(solidityPacked(['bytes'], [addressBytes(addressHex)]))));
}

/** Must match `QurrlPhaseMinter.mintAcorn`: the account and its cumulative EARNED points. */
function acornLeaf(addressHex, earned) {
  return keccak256(getBytes(keccak256(solidityPacked(['bytes', 'uint64'], [addressBytes(addressHex), earned]))));
}

/** Must match `QurrlPhaseMinter.keyOf`: keccak256 of `<field>@<phase>`, the `setParamsDiff` key. */
function paramKey(field, phase) {
  if (!PHASE_ROW_FIELDS.includes(field)) throw new Error(`${field} is not a PhaseRow field`);
  if (!Number.isInteger(phase) || phase < 0 || phase >= PHASES.length) throw new Error(`no phase ${phase}`);
  return keccak256(toUtf8Bytes(`${field}@${phase}`));
}

/**
 * The trait manifest hash committed on chain before any season seed. The real one is the hash
 * of the private manifest (slot and variant names, art hashes); QURRL_MANIFEST_HASH carries
 * it. Without it a clearly labelled placeholder is used, which is acceptable on a throwaway
 * network and wrong on any other.
 */
function manifestHash(env = process.env) {
  if (env.QURRL_MANIFEST_HASH) return env.QURRL_MANIFEST_HASH;
  return keccak256(toUtf8Bytes('qurrl-dev-manifest-placeholder'));
}

module.exports = {
  manifestHash,
  tieredWeights,
  effectiveSeed,
  MAX_SUPPLY,
  DAY,
  QRL,
  PALETTE,
  PHASES,
  PHASE_ROW_FIELDS,
  PHASE_ROWS,
  phaseRowTuple,
  GENESIS_MIN_ACORNS,
  ZERO32,
  seedFor,
  commitmentFor,
  deriveTraits,
  genesisLeaf,
  acornLeaf,
  paramKey,
};
