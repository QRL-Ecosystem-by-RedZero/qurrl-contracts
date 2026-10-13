/**
 * Phase 0 (Genesis Inventory): the 105 genesis places, chosen off chain in three
 * baskets and committed with one `setGenesis(root, 1)` (QuantumArk-Phases.md
 * §5, adopted 2026-10-13).
 *
 *   1. Direct      up to 35 wallets named by the deployer, published with their group
 *   2. Top Acorn   the 45 highest Acorn snapshots among the rest; a tie goes to the
 *                  earlier first scoring block, then to the lower address bytes
 *   3. Raffle      25 among the rest with >= 600 Acorn and >= 2 on-chain
 *                  transactions from the wallet itself, without replacement,
 *                  weight sqrt(Acorn) (Efraimidis-Spirakis)
 *
 * One wallet, one token: the three baskets are one list of distinct addresses.
 * The raffle seed is a value published before the snapshot closes and outside
 * any chain the team runs: the hash of an announced Ethereum mainnet block, or
 * an announced drand round. Anyone re-runs this script on the published
 * snapshot and seed and gets the same list and root.
 *
 *   node scripts/phase0/select-phase0.js --snapshot acorn_snapshot.json \
 *        --direct direct_whitelist.json --seed 0x<32 bytes> [--qrvm] [--out phase0_selection.json]
 *
 * Snapshot: [{ address, acorn, txCount, firstBlock }]. Direct: [{ address, group }].
 * `--qrvm` builds the leaves at the QIP-55 address width (64 bytes), as the v3
 * minter verifies them; the default is the 20-byte line.
 */
const fs = require('fs');
const { keccak256, concat, getBytes, toUtf8Bytes, solidityPacked } = require('ethers');

const DIRECT = 35;
const TOP = 45;
const RAFFLE = 25;
const RAFFLE_FLOOR = 600;
const RAFFLE_MIN_TX = 2;
const DOMAIN = 'QURRL_PHASE0_RAFFLE_V1';

/** Address bytes without prefix, lower case; `Q` and `0x` forms compare equal. */
const norm = (a) => String(a).replace(/^(Q|0x)/i, '').toLowerCase();

/** The packed address width of the line: 20 bytes on v2, 64 on QIP-55. */
function addressBytes(address, qrvm) {
  const hex = norm(address);
  const width = qrvm ? 128 : 40;
  if (hex.length > width) throw new Error(`${address} is wider than the ${qrvm ? 'QIP-55' : 'v2'} address`);
  return '0x' + hex.padStart(width, '0');
}

/** Must match `QurrlPhaseMinter.mintGenesis` (scripts/collection.js genesisLeaf). */
function genesisLeaf(address, qrvm) {
  return keccak256(getBytes(keccak256(solidityPacked(['bytes'], [addressBytes(address, qrvm)]))));
}

/** Sorted-pair tree, OpenZeppelin MerkleProof. */
function merkle(leaves) {
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
  const proof = (index) => {
    const out = [];
    let idx = index;
    for (let l = 0; l < layers.length - 1; l++) {
      const sib = idx % 2 === 0 ? idx + 1 : idx - 1;
      if (sib < layers[l].length) out.push(layers[l][sib]);
      idx = Math.floor(idx / 2);
    }
    return out;
  };
  return { root: layers[layers.length - 1][0], proof };
}

/** The raffle key of one wallet: ln(u) / w, larger wins (Efraimidis-Spirakis, u^(1/w) in log form). */
function raffleKey(seed, address, acorn) {
  const domainSeed = keccak256(concat([getBytes(seed), toUtf8Bytes(DOMAIN)]));
  const h = BigInt(keccak256(concat([getBytes(domainSeed), getBytes('0x' + norm(address).padStart(40, '0'))])));
  // u in (0, 1): never 0, so ln(u) is finite.
  const u = (Number(h >> 11n) + 0.5) / 2 ** 245;
  return Math.log(u) / Math.sqrt(acorn);
}

function select({ snapshot, direct, seed, qrvm = false }) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(seed)) throw new Error('seed: 32 bytes of hex (an Ethereum block hash or a drand round)');
  if (direct.length > DIRECT) throw new Error(`direct basket: at most ${DIRECT}, got ${direct.length}`);

  const taken = new Set();
  const take = (address) => {
    const k = norm(address);
    if (taken.has(k)) throw new Error(`${address} appears twice`);
    taken.add(k);
  };

  const chosen = [];
  for (const d of direct) {
    take(d.address);
    chosen.push({ address: d.address, basket: 'direct', group: d.group || null });
  }

  const seen = new Set();
  const wallets = snapshot.map((w) => {
    const k = norm(w.address);
    if (seen.has(k)) throw new Error(`snapshot lists ${w.address} twice`);
    seen.add(k);
    return { address: w.address, acorn: Number(w.acorn), txCount: Number(w.txCount || 0), firstBlock: Number(w.firstBlock ?? Infinity) };
  });

  const rest = wallets.filter((w) => !taken.has(norm(w.address)));
  rest.sort((a, b) => b.acorn - a.acorn || a.firstBlock - b.firstBlock || (norm(a.address) < norm(b.address) ? -1 : 1));
  for (const w of rest.slice(0, TOP)) {
    take(w.address);
    chosen.push({ address: w.address, basket: 'top', acorn: w.acorn });
  }

  const eligible = wallets.filter((w) => !taken.has(norm(w.address)) && w.acorn >= RAFFLE_FLOOR && w.txCount >= RAFFLE_MIN_TX);
  const keyed = eligible.map((w) => ({ ...w, key: raffleKey(seed, w.address, w.acorn) }));
  keyed.sort((a, b) => b.key - a.key || (norm(a.address) < norm(b.address) ? -1 : 1));
  for (const w of keyed.slice(0, RAFFLE)) {
    take(w.address);
    chosen.push({ address: w.address, basket: 'raffle', acorn: w.acorn, key: w.key });
  }

  const leaves = chosen.map((c) => genesisLeaf(c.address, qrvm));
  const tree = merkle(leaves);
  return {
    seed,
    line: qrvm ? 'qip55' : 'v2',
    counts: { direct: direct.length, top: Math.min(TOP, rest.length), raffle: Math.min(RAFFLE, keyed.length), eligibleForRaffle: eligible.length },
    root: tree.root,
    perWallet: 1,
    wallets: chosen.map((c, i) => ({ ...c, leaf: leaves[i], proof: tree.proof(i) })),
  };
}

function main() {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const snapshot = JSON.parse(fs.readFileSync(arg('--snapshot'), 'utf8'));
  const direct = arg('--direct') ? JSON.parse(fs.readFileSync(arg('--direct'), 'utf8')) : [];
  const out = select({ snapshot, direct, seed: arg('--seed'), qrvm: process.argv.includes('--qrvm') });
  const file = arg('--out') || 'phase0_selection.json';
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`root ${out.root} (${out.line}); direct ${out.counts.direct}, top ${out.counts.top}, raffle ${out.counts.raffle} of ${out.counts.eligibleForRaffle} eligible -> ${file}`);
}

if (require.main === module) main();

module.exports = { select, genesisLeaf, raffleKey, merkle, DIRECT, TOP, RAFFLE, RAFFLE_FLOOR, RAFFLE_MIN_TX };
