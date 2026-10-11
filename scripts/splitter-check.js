/**
 * Live check of royalty and the revenue split, on a throwaway collection.
 *
 * Paid mints fill the collection, the splitter sweeps it and books 10 / 35 / 55,
 * a plain transfer to the splitter is booked as a secondary fee (10 / 90), the
 * creator line is claimed, and revenue withdrawn straight to the splitter outside
 * `sweep` is booked by the next sweep instead of being stranded.
 *
 *   ARK_QRVM=1 node scripts/splitter-check.js
 *
 * Paid mints go through a throwaway QurrlPhaseMinter's QRL pool, which forwards the
 * value to the collection. Its phase 0 row is the shipped one except that 20 of the
 * 105 are sold in a QRL pool (throwaway), so no phase has to elapse; the ecosystem
 * phase is a fresh ArkPhaseDouble (stand-in). No season is revealed, so it does not
 * wait for a window to close.
 */
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes } = require('ethers');
const { connect, deploy, contractAt, sendRaw } = require('./qrl');
const { PALETTE, PHASE_ROWS, phaseRowTuple, manifestHash, seedFor, commitmentFor, genesisLeaf } = require('./collection');

async function main() {
  const { web3, account } = connect();
  const from = account.address;
  const send = (to, data, gas = 500_000, value = 0n) => sendRaw(web3, account, { to, data, gas, value });
  const zero = process.env.ARK_QRVM === '1' ? 'Q' + '00'.repeat(64) : '0x' + '00'.repeat(20);

  console.log('deploying a throwaway collection and splitter');
  const registry = await deploy(web3, account, 'QurrlTraitRegistry', [from]);
  const registryAddress = registry.options.address;
  const registryContract = contractAt(web3, 'QurrlTraitRegistry', registryAddress);
  for (const [slot, entry] of PALETTE.entries()) {
    await send(registryAddress, registryContract.methods.setCategory(slot, entry.weights).encodeABI(), 600_000);
  }
  await send(registryAddress, registryContract.methods.sealPalette().encodeABI(), 200_000);
  await send(registryAddress, registryContract.methods.commitManifest(manifestHash()).encodeABI(), 200_000);

  const nft = await deploy(web3, account, 'QurrlNFT', ['Qurrl Split', 'QURRLS', from, registryAddress]);
  const nftAddress = nft.options.address;
  const nftContract = contractAt(web3, 'QurrlNFT', nftAddress);

  const splitter = await deploy(web3, account, 'QurrlRevenueSplitter', [nftAddress, from, from, zero, 3500]);
  const splitterAddress = splitter.options.address;
  const splitterContract = contractAt(web3, 'QurrlRevenueSplitter', splitterAddress);

  const TREASURER = keccak256(toUtf8Bytes('TREASURER_ROLE'));
  await send(nftAddress, nftContract.methods.grantRole(TREASURER, splitterAddress).encodeABI(), 200_000);
  await send(nftAddress, nftContract.methods.setRoyalty(splitterAddress, 250).encodeABI(), 200_000);
  const royalty = await nftContract.methods.royaltyInfo(1, 10_000).call();
  assert.equal(BigInt(royalty[1]), 250n, 'royaltyInfo is 2.5%');
  assert.equal(String(royalty[0]).toLowerCase(), splitterAddress.toLowerCase(), 'royalty is paid to the splitter');
  console.log('royaltyInfo(1, 10000) = 250 -> splitter');

  const price = 10n ** 16n;
  const rows = PHASE_ROWS.map((r, p) =>
    p === 0 ? { ...r, acornCap: r.acornCap - 20, qrlCap: 20, mintFee: price, mintFeeMin: price, mintFeeMax: price } : r,
  );
  const arkPhase = await deploy(web3, account, 'ArkPhaseDouble', []);
  const minter = await deploy(web3, account, 'QurrlPhaseMinter', [nftAddress, registryAddress, arkPhase.options.address, from, from, from, rows.map(phaseRowTuple)]);
  const minterAddress = minter.options.address;
  const minterContract = contractAt(web3, 'QurrlPhaseMinter', minterAddress);
  for (const r of ['MINTER_ROLE', 'SEASON_ADMIN_ROLE']) {
    await send(nftAddress, nftContract.methods.grantRole(keccak256(toUtf8Bytes(r)), minterAddress).encodeABI(), 200_000);
  }
  console.log(`ArkPhase ${arkPhase.options.address}  (stand-in)  QurrlPhaseMinter ${minterAddress}`);

  const now = Number((await web3.qrl.getBlock('latest')).timestamp);
  await send(registryAddress, registryContract.methods.commitSeed(1, commitmentFor(1, seedFor('splitter-check', 1)), now + 3600).encodeABI(), 200_000);
  await send(minterAddress, minterContract.methods.setGenesis(genesisLeaf(from), 1).encodeABI(), 200_000);
  await send(minterAddress, minterContract.methods.openPhase().encodeABI(), 600_000);
  await send(minterAddress, minterContract.methods.mintQrl(10).encodeABI(), 1_800_000, price * 10n);
  assert.equal(BigInt(await web3.qrl.getBalance(minterAddress)), 0n, 'the minter forwards every payment');

  const held = BigInt(await web3.qrl.getBalance(nftAddress));
  assert.equal(held, price * 10n);
  console.log(`\ncollection holds ${held} wei after 10 paid mints`);

  await send(splitterAddress, splitterContract.methods.sweep().encodeABI());
  assert.equal(BigInt(await web3.qrl.getBalance(nftAddress)), 0n, 'the collection is emptied');
  const owed = async () => ({
    creator: BigInt(await splitterContract.methods.creatorOwed().call()),
    cushion: BigInt(await splitterContract.methods.cushionOwed().call()),
    treasury: BigInt(await splitterContract.methods.treasuryPrimaryOwed().call()),
    secondary: BigInt(await splitterContract.methods.treasurySecondaryOwed().call()),
  });
  let o = await owed();
  assert.equal(o.creator, (held * 1000n) / 10000n, 'creator 10%');
  assert.equal(o.cushion, (held * 3500n) / 10000n, 'cushion 35%');
  assert.equal(o.creator + o.cushion + o.treasury, held, 'the ledgers add up to what was swept');
  console.log(`sweep: creator ${o.creator}  cushion ${o.cushion}  treasury ${o.treasury}  (10 / 35 / 55)`);

  const fee = 10n ** 15n;
  await send(splitterAddress, '0x', 300_000, fee);
  const o2 = await owed();
  assert.equal(o2.creator, o.creator + fee / 10n, 'a plain transfer is a fee: 10% to the creator');
  assert.equal(o2.secondary, fee - fee / 10n, 'and 90% to the treasury');
  console.log(`secondary fee ${fee}: creator +${fee / 10n}, treasury +${fee - fee / 10n}`);

  // Revenue the treasurer pulls straight to the splitter, bypassing sweep.
  await send(nftAddress, nftContract.methods.grantRole(TREASURER, from).encodeABI(), 200_000);
  await send(minterAddress, minterContract.methods.mintQrl(2).encodeABI(), 800_000, price * 2n);
  await send(nftAddress, nftContract.methods.withdraw(splitterAddress).encodeABI(), 300_000);
  const stranded = BigInt(await web3.qrl.getBalance(splitterAddress)) - (o2.creator + o2.cushion + o2.treasury + o2.secondary);
  assert.equal(stranded, price * 2n, 'withdrawn outside sweep: held but not yet booked');
  await send(splitterAddress, splitterContract.methods.sweep().encodeABI());
  const o3 = await owed();
  const total = o3.creator + o3.cushion + o3.treasury + o3.secondary;
  assert.equal(total, BigInt(await web3.qrl.getBalance(splitterAddress)), 'after sweep the ledgers equal the balance');
  console.log('a direct withdraw to the splitter was booked by the next sweep: ledgers equal the balance');

  await send(splitterAddress, splitterContract.methods.claimCreator().encodeABI(), 300_000);
  assert.equal(BigInt(await splitterContract.methods.creatorOwed().call()), 0n);
  assert.equal(
    BigInt(await splitterContract.methods.cushionOwed().call()),
    o3.cushion,
    'claiming the creator line leaves the other lines untouched',
  );
  console.log('claimCreator paid the creator line and nothing else');

  console.log('\nsplitter check ok');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
