/**
 * QurrlBudget: the QURRL_BUDGET lane in, governance-only payouts out
 * (QuantumArk-Treasury-Flows.md §7, adopted 2026-10-13).
 */
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes } = require('ethers');
const { Chain, ACCOUNTS } = require('./harness');
const { expectRevert } = require('./fixtures');

const BUDGET = keccak256(toUtf8Bytes('quantumark.lane.qurrl.budget.v1'));
const CUSHION = keccak256(toUtf8Bytes('quantumark.lane.cushion.v1'));
const ONE = 10n ** 18n;
const GOV = ACCOUNTS.treasurer;
const REF = '0x' + '00'.repeat(32);

async function fixture() {
  const chain = await Chain.create();
  const budget = await chain.deploy('QurrlBudget', ['address', 'address'], [GOV, '0x' + '00'.repeat(20)]);
  return { chain, budget };
}

test('accepts the budget lane only', async () => {
  const { budget } = await fixture();
  await budget.send('deposit', [BUDGET, REF], { from: ACCOUNTS.alice, value: 5n * ONE });
  assert.equal(await budget.call('laneTotal', [BUDGET]), 5n * ONE);
  await expectRevert(budget.send('deposit', [CUSHION, REF], { from: ACCOUNTS.alice, value: ONE }), 'LaneUnknown');
});

test('only governance pays, never more than it holds', async () => {
  const { chain, budget } = await fixture();
  await budget.send('deposit', [BUDGET, REF], { from: ACCOUNTS.alice, value: 5n * ONE });
  await expectRevert(budget.send('payBudget', [ACCOUNTS.mallory, ONE], { from: ACCOUNTS.mallory }), 'NotGovernance');
  await expectRevert(budget.send('payBudget', [ACCOUNTS.bob, 6n * ONE], { from: GOV }), 'InsufficientBudget');
  const before = await chain.balanceOf(ACCOUNTS.bob);
  await budget.send('payBudget', [ACCOUNTS.bob, 2n * ONE], { from: GOV });
  assert.equal((await chain.balanceOf(ACCOUNTS.bob)) - before, 2n * ONE);
});

test('governance hands over in two steps', async () => {
  const { budget } = await fixture();
  await budget.send('proposeGovernance', [ACCOUNTS.admin], { from: GOV });
  await expectRevert(budget.send('acceptGovernance', [], { from: ACCOUNTS.mallory }), 'NotPending');
  await budget.send('acceptGovernance', [], { from: ACCOUNTS.admin });
  await expectRevert(budget.send('payBudget', [ACCOUNTS.bob, 0], { from: GOV }), 'NotGovernance');
});
