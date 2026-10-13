/**
 * The off-chain half of the collection: the schedule rows the minter is deployed
 * with, the leaf and key constructions the scripts build trees and proposals from,
 * and the agreement of the independent mirrors of the trait derivation.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const collection = require('../scripts/collection');
const fixtures = require('./fixtures');
const { Chain, artifact, ACCOUNTS } = require('./harness');

const ROW_TYPE = 'tuple(uint32,uint32,uint32,uint32,uint32,uint32,uint128,uint128,uint128,uint128,uint16,uint32,uint32,uint128)[5]';

function minterRowComponents() {
  const ctor = artifact('QurrlPhaseMinter').abi.find((e) => e.type === 'constructor');
  return ctor.inputs[ctor.inputs.length - 1].components;
}

test('PHASE_ROWS follow the PhaseRow declaration order of the compiled minter', () => {
  const components = minterRowComponents();
  assert.deepEqual(components.map((c) => c.name), collection.PHASE_ROW_FIELDS);
  assert.equal(collection.PHASE_ROWS.length, 5);
  for (const row of collection.PHASE_ROWS) assert.deepEqual(Object.keys(row), collection.PHASE_ROW_FIELDS);
  assert.deepEqual(
    collection.PHASES.map((p) => p.codename),
    ['Genesis Inventory', 'Lattice Shift', 'Classical Sunset', 'Q-Day', 'Restoration'],
  );
  assert.deepEqual(collection.PHASE0, { direct: 35, top: 45, raffle: 25, raffleFloor: 600, raffleMinTx: 2, perWallet: 1 });
  assert.equal(collection.PHASE0.direct + collection.PHASE0.top + collection.PHASE0.raffle, collection.PHASES[0].acornCap);
});

test('the minter constructor accepts the shipped rows and reads them back; its keys are paramKey', async () => {
  const chain = await Chain.create();
  // The constructor only checks the addresses are non-zero, so any accounts will do here.
  const minter = await chain.deploy(
    'QurrlPhaseMinter',
    ['address', 'address', 'address', 'address', 'address', 'address', ROW_TYPE],
    [ACCOUNTS.admin, ACCOUNTS.curator, ACCOUNTS.seasonAdmin, ACCOUNTS.treasurer, ACCOUNTS.alice, ACCOUNTS.bob, collection.PHASE_ROWS.map(collection.phaseRowTuple)],
  );

  for (const [p, row] of collection.PHASE_ROWS.entries()) {
    const onChain = await minter.call('rowOf', [p]);
    assert.deepEqual(
      collection.PHASE_ROW_FIELDS.map((_, i) => onChain[i].toString()),
      collection.phaseRowTuple(row),
      `phase ${p}`,
    );
    for (const [f, field] of collection.PHASE_ROW_FIELDS.entries()) {
      assert.equal(await minter.call('keyOf', [f, p]), collection.paramKey(field, p), `${field}@${p}`);
    }
  }
  assert.throws(() => collection.paramKey('mintPrice', 1), /not a PhaseRow field/);
  assert.throws(() => collection.paramKey('reqPts', 5), /no phase/);
});

test('the genesis and Acorn leaves agree with the independent mirrors, and the address width is the line', () => {
  for (const address of [ACCOUNTS.alice, ACCOUNTS.bob]) {
    assert.equal(collection.genesisLeaf(address), fixtures.genesisLeaf(address));
    assert.equal(collection.genesisLeaf('Q' + address.slice(2)), fixtures.genesisLeaf(address));
    for (const earned of [0, 2001, 1_000_000]) {
      assert.equal(collection.acornLeaf(address, earned), fixtures.acornLeaf(address, earned));
    }
  }
  // A 64-byte (QIP-55) address packs all 64 bytes: a v2 tree never verifies on v3.
  const wide = 'Q' + '55'.repeat(64);
  assert.notEqual(collection.genesisLeaf(wide), collection.genesisLeaf(ACCOUNTS.alice));
  assert.notEqual(collection.acornLeaf(ACCOUNTS.alice, 1), collection.acornLeaf(ACCOUNTS.alice, 2));
});

test('the shipped palette is valid: six slots, weights sum to 10,000, none is zero', () => {
  assert.equal(collection.PALETTE.length, 6);
  for (const slot of collection.PALETTE) {
    assert.equal(slot.weights.length, slot.variants);
    assert.equal(slot.weights.reduce((a, b) => a + b, 0), 10000);
    assert.ok(slot.weights.every((w) => w >= 1));
    assert.ok(slot.variants <= 32);
  }
});

test('the palette carries numbers only: no slot or variant is named anywhere in the repository code', () => {
  for (const slot of collection.PALETTE) {
    assert.deepEqual(Object.keys(slot).sort(), ['variants', 'weights']);
  }
});

test('the two independent derivations agree, with the shipped palette and the test palette', () => {
  const effective = collection.effectiveSeed(collection.seedFor('s', 1), collection.seedFor('s', 2));
  assert.equal(effective, fixtures.effectiveSeed(collection.seedFor('s', 1), collection.seedFor('s', 2)));

  for (const id of [1, 2, 99, 10500]) {
    assert.deepEqual(collection.deriveTraits(effective, id), fixtures.deriveTraits(effective, id, collection.PALETTE));
    assert.deepEqual(
      collection.deriveTraits(effective, id, fixtures.PALETTE),
      fixtures.deriveTraits(effective, id),
    );
  }
});
