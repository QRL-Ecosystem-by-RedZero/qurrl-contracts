/**
 * Live check of the two Merkle trees QurrlPhaseMinter verifies, on a throwaway
 * collection: the phase 0 genesis list and the Acorn pool's earned-points tree.
 *
 * Both leaves contain msg.sender, which is 20 bytes on the v2 line and 64 bytes on
 * QIP-55, and the Merkle verification is OpenZeppelin code that the vendoring step
 * rewrites for QRVM. The local harness can prove neither on v3. This script does:
 * two-leaf trees (the deployer and a made-up second address), mints with a
 * non-empty proof, and the refusals that must hold. It also checks the vendored
 * Strings.toString, which reverted on QRVM before it was replaced.
 *
 *   ARK_QRVM=1 node scripts/merkle-check.js
 *
 * The Acorn pool opens from phase 1, which waits for phase 0's mint window to end:
 * the throwaway phase 0 row lasts MERKLE_WINDOW seconds (150, or 900 on QIP-55), and
 * the ecosystem phase is a fresh ArkPhaseDouble (stand-in). No season is revealed.
 */
const assert = require('node:assert/strict');
const { keccak256, concat, toUtf8Bytes } = require('ethers');
const { connect, deploy, contractAt, sendRaw } = require('./qrl');
const { PALETTE, PHASE_ROWS, phaseRowTuple, manifestHash, seedFor, commitmentFor, genesisLeaf, acornLeaf } = require('./collection');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function expectRevert(promise, label) {
  try {
    await promise;
  } catch {
    console.log(`   refused as expected: ${label}`);
    return;
  }
  throw new Error(`${label} was supposed to revert and did not`);
}

async function main() {
  const { web3, account } = connect();
  const from = account.address;
  const v3 = process.env.ARK_QRVM === '1';
  const other = v3 ? 'Q' + '55'.repeat(64) : 'Q' + '55'.repeat(20);
  const window = Number(process.env.MERKLE_WINDOW || (v3 ? 900 : 150));
  const chainNow = async () => Number((await web3.qrl.getBlock('latest')).timestamp);
  const role = (n) => keccak256(toUtf8Bytes(n));

  console.log(`caller ${from}\n`);
  console.log('deploying a throwaway registry, collection and minter');
  const registry = await deploy(web3, account, 'QurrlTraitRegistry', [from]);
  const registryContract = contractAt(web3, 'QurrlTraitRegistry', registry.options.address);
  for (const [slot, entry] of PALETTE.entries()) {
    await sendRaw(web3, account, { to: registry.options.address, data: registryContract.methods.setCategory(slot, entry.weights).encodeABI(), gas: 600_000 });
  }
  await sendRaw(web3, account, { to: registry.options.address, data: registryContract.methods.sealPalette().encodeABI(), gas: 200_000 });
  await sendRaw(web3, account, { to: registry.options.address, data: registryContract.methods.commitManifest(manifestHash()).encodeABI(), gas: 200_000 });

  const nft = await deploy(web3, account, 'QurrlNFT', ['Qurrl Merkle', 'QURRLM', from, registry.options.address]);
  const nftContract = contractAt(web3, 'QurrlNFT', nft.options.address);
  const arkPhase = await deploy(web3, account, 'ArkPhaseDouble', []);
  const arkPhaseContract = contractAt(web3, 'ArkPhaseDouble', arkPhase.options.address);
  const rows = PHASE_ROWS.map((r, p) => (p === 0 ? { ...r, mintDuration: window } : r));
  const minter = await deploy(web3, account, 'QurrlPhaseMinter', [
    nft.options.address,
    registry.options.address,
    arkPhase.options.address,
    from,
    from,
    from,
    rows.map(phaseRowTuple),
  ]);
  const M = minter.options.address;
  const minterContract = contractAt(web3, 'QurrlPhaseMinter', M);
  for (const r of ['MINTER_ROLE', 'SEASON_ADMIN_ROLE']) {
    await sendRaw(web3, account, { to: nft.options.address, data: nftContract.methods.grantRole(role(r), M).encodeABI(), gas: 200_000 });
  }
  console.log(`   ArkPhase ${arkPhase.options.address}  (stand-in)`);
  console.log(`   QurrlPhaseMinter ${M}`);

  const send = (data, gas = 600_000) => sendRaw(web3, account, { to: M, data, gas });
  const commitAndOpen = async (seasonId) => {
    await sendRaw(web3, account, {
      to: registry.options.address,
      data: registryContract.methods.commitSeed(seasonId, commitmentFor(seasonId, seedFor('merkle-check', seasonId)), (await chainNow()) + 3600).encodeABI(),
      gas: 200_000,
    });
    await send(minterContract.methods.openPhase().encodeABI());
  };

  /* Phase 0: the genesis list. */
  const gMine = genesisLeaf(from);
  const gOther = genesisLeaf(other);
  const gRoot = keccak256(concat([gMine, gOther].sort()));
  console.log(`\ngenesis list: 2 leaves, root ${gRoot}`);
  await send(minterContract.methods.setGenesis(gRoot, 2).encodeABI(), 200_000);
  await commitAndOpen(1);
  const closes1 = Number((await nftContract.methods.seasonView(1).call()).config.closesAt);

  const mintGenesis = (quantity, proof) => send(minterContract.methods.mintGenesis(quantity, proof).encodeABI());
  await expectRevert(mintGenesis(1, []), 'an empty proof on a two-leaf list');
  await expectRevert(mintGenesis(1, [gMine]), 'the wrong sibling');
  await mintGenesis(2, [gOther]);
  assert.equal(Number(await nftContract.methods.totalMinted().call()), 2);
  console.log('   minted 2 with a one-element proof');
  await expectRevert(mintGenesis(1, [gOther]), 'a third token past the per-wallet 2');

  /* Phase 1: the Acorn pool, cumulative earned points, reqPts spent per token. */
  console.log(`\nwaiting for phase 0's window to end (chain time ${closes1})`);
  while ((await chainNow()) < closes1) await sleep(5000);
  await sendRaw(web3, account, { to: arkPhase.options.address, data: arkPhaseContract.methods.set(1).encodeABI(), gas: 100_000 });
  console.log('   ArkPhaseDouble set to 1 (stand-in)');
  await commitAndOpen(2);

  const reqPts = Number((await minterContract.methods.rowOf(1).call()).reqPts);
  const earned = 2 * reqPts;
  const aMine = acornLeaf(from, earned);
  const aOther = acornLeaf(other, 7 * reqPts);
  const aRoot = keccak256(concat([aMine, aOther].sort()));
  console.log(`acorn tree: 2 leaves, root ${aRoot}; earned ${earned}, ${reqPts} per token`);
  await send(minterContract.methods.postAcornRoot(1, aRoot).encodeABI(), 200_000);
  await expectRevert(send(minterContract.methods.postAcornRoot(1, aRoot).encodeABI(), 200_000), 'an Acorn root for an epoch already posted');

  const mintAcorn = (quantity, claimed, proof) => send(minterContract.methods.mintAcorn(quantity, claimed, proof).encodeABI());
  await expectRevert(mintAcorn(1, earned + reqPts, [aOther]), 'claiming more earned points than the leaf carries');
  await expectRevert(mintAcorn(1, earned, []), 'an empty proof on a two-leaf tree');
  await expectRevert(mintAcorn(3, earned, [aOther]), 'three tokens on points for two');
  await mintAcorn(2, earned, [aOther]);
  assert.equal(Number(await minterContract.methods.acornsSpent(from).call()), earned);
  assert.equal(Number(await nftContract.methods.totalMinted().call()), 4);
  console.log('   minted 2 with a one-element proof; the points are spent');
  await expectRevert(mintAcorn(1, earned, [aOther]), 'a token on points already spent');

  console.log('\nthe vendored Strings library, which tokenURI uses once a token is revealed');
  const probe = await deploy(web3, account, 'StringsProbe');
  const probeContract = contractAt(web3, 'StringsProbe', probe.options.address);
  for (const n of [0n, 7n, 10n, 10500n, 2n ** 64n]) {
    assert.equal(await probeContract.methods.decimal(n).call(), n.toString(), `Strings.toString(${n})`);
  }
  console.log('   toString(0, 7, 10, 10500, 2^64) is correct');

  console.log(`\nmerkle check ok on ${v3 ? 'QIP-55 (64-byte addresses)' : 'the 20-byte line'}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
