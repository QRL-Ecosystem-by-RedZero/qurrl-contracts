/**
 * Live check of tokenURI end to end, on a throwaway collection: the renderer's
 * cross-contract read of traitsOf, the shared placeholder while a token is sealed,
 * and the id-addressed URI after the reveal (which runs the vendored
 * Strings.toString, the library that reverted on QRVM before it was replaced).
 *
 *   ARK_QRVM=1 node scripts/metadata-check.js
 *
 * Opens phase 0 through a throwaway QurrlPhaseMinter (a one-leaf genesis list of the
 * caller, the ecosystem phase a fresh ArkPhaseDouble stand-in), mints two genesis
 * tokens, and waits about 7 minutes for the reveal, because the registry refuses an
 * earlier one.
 */
const assert = require('node:assert/strict');
const { connect, deploy, contractAt, sendRaw } = require('./qrl');
const { keccak256, toUtf8Bytes } = require('ethers');
const { PALETTE, PHASE_ROWS, phaseRowTuple, manifestHash, seedFor, commitmentFor, genesisLeaf } = require('./collection');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chainNow = async (web3) => Number((await web3.qrl.getBlock('latest')).timestamp);

async function main() {
  const { web3, account } = connect();
  const from = account.address;
  const send = (to, data, gas = 500_000) => sendRaw(web3, account, { to, data, gas });

  console.log('Strings.toString on this chain');
  const probe = await deploy(web3, account, 'StringsProbe');
  const probeContract = contractAt(web3, 'StringsProbe', probe.options.address);
  for (const n of [0n, 7n, 10n, 10500n, 2n ** 64n]) {
    assert.equal(await probeContract.methods.decimal(n).call(), n.toString(), `toString(${n})`);
  }
  console.log('   toString(0, 7, 10, 10500, 2^64) is correct\n');

  console.log('deploying a throwaway collection');
  const registry = await deploy(web3, account, 'QurrlTraitRegistry', [from]);
  const registryAddress = registry.options.address;
  const registryContract = contractAt(web3, 'QurrlTraitRegistry', registryAddress);
  for (const [slot, entry] of PALETTE.entries()) {
    await send(registryAddress, registryContract.methods.setCategory(slot, entry.weights).encodeABI(), 600_000);
  }
  await send(registryAddress, registryContract.methods.sealPalette().encodeABI(), 200_000);
  await send(registryAddress, registryContract.methods.commitManifest(manifestHash()).encodeABI(), 200_000);

  const nft = await deploy(web3, account, 'QurrlNFT', ['Qurrl Metadata', 'QURRLD', from, registryAddress]);
  const nftAddress = nft.options.address;
  const nftContract = contractAt(web3, 'QurrlNFT', nftAddress);
  const meta = await deploy(web3, account, 'QurrlMetadata', [nftAddress, from]);
  const metaContract = contractAt(web3, 'QurrlMetadata', meta.options.address);
  await send(nftAddress, nftContract.methods.setRenderer(meta.options.address).encodeABI(), 200_000);
  await send(meta.options.address, metaContract.methods.setURIs('ipfs://sealed.json', 'ipfs://qurrl/').encodeABI(), 500_000);

  const arkPhase = await deploy(web3, account, 'ArkPhaseDouble', []);
  const minter = await deploy(web3, account, 'QurrlPhaseMinter', [
    nftAddress,
    registryAddress,
    arkPhase.options.address,
    from,
    from,
    from,
    PHASE_ROWS.map(phaseRowTuple),
  ]);
  const minterAddress = minter.options.address;
  const minterContract = contractAt(web3, 'QurrlPhaseMinter', minterAddress);
  for (const r of ['MINTER_ROLE', 'SEASON_ADMIN_ROLE']) {
    await send(nftAddress, nftContract.methods.grantRole(keccak256(toUtf8Bytes(r)), minterAddress).encodeABI(), 200_000);
  }
  console.log(`   ArkPhase ${arkPhase.options.address}  (stand-in)  QurrlPhaseMinter ${minterAddress}`);

  const now = await chainNow(web3);
  // Block gaps of two minutes happen on this devnet, and the seed commit must still be in the future when it lands.
  const closesAt = now + Number(process.env.METADATA_WINDOW || 420);
  await send(registryAddress, registryContract.methods.commitSeed(1, commitmentFor(1, seedFor('metadata-check', 1)), closesAt).encodeABI(), 200_000);
  // One-leaf genesis list: the root is the caller's leaf and the proof is empty.
  await send(minterAddress, minterContract.methods.setGenesis(genesisLeaf(from), 2).encodeABI(), 200_000);
  await send(minterAddress, minterContract.methods.openPhase().encodeABI(), 600_000);
  await send(minterAddress, minterContract.methods.mintGenesis(2, []).encodeABI(), 800_000);

  assert.equal(await nftContract.methods.tokenURI(1).call(), 'ipfs://sealed.json', 'a sealed token shows the shared placeholder');
  console.log('\nsealed: tokenURI(1) = ipfs://sealed.json');

  console.log('waiting for the reveal time');
  while ((await chainNow(web3)) < closesAt) await sleep(5000);
  await send(registryAddress, registryContract.methods.revealSeed(1, seedFor('metadata-check', 1)).encodeABI(), 300_000);

  assert.equal(await nftContract.methods.tokenURI(1).call(), 'ipfs://qurrl/1');
  assert.equal(await nftContract.methods.tokenURI(2).call(), 'ipfs://qurrl/2');
  console.log('revealed: tokenURI(1) = ipfs://qurrl/1, tokenURI(2) = ipfs://qurrl/2');

  await send(meta.options.address, metaContract.methods.freeze().encodeABI(), 200_000);
  let refused = false;
  try {
    await send(meta.options.address, metaContract.methods.setURIs('x', 'y').encodeABI(), 300_000);
  } catch {
    refused = true;
  }
  assert.equal(refused, true, 'a frozen renderer must refuse new URIs');
  console.log('frozen: setURIs refused');

  console.log('\nmetadata check ok');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
