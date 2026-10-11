/**
 * Live smoke test against the deployed collection.
 *
 * Reads the whole collection through the Lens, mints one token through
 * QurrlPhaseMinter from the phase in force, and asserts calls that must revert.
 * A deployment where the happy path works but nothing rejects is a deployment
 * whose guards were never wired.
 *
 * Phase 0 mints from the genesis whitelist, which needs this caller's proof:
 * pass `--proof 0x..,0x..` (none for a one-leaf tree of the caller). From phase 1
 * the QRL pool needs no proof and is used.
 */
const assert = require('node:assert/strict');
const { connect, contractAt, sendRaw, loadDeployment } = require('./qrl');

async function expectRevert(promise, label) {
  try {
    await promise;
  } catch {
    console.log(`   reverted as expected: ${label}`);
    return;
  }
  throw new Error(`${label} was supposed to revert and did not`);
}

function proofFlag() {
  const i = process.argv.indexOf('--proof');
  if (i === -1 || !process.argv[i + 1]) return [];
  return process.argv[i + 1].split(',').filter(Boolean);
}

async function main() {
  const { web3, account, env } = connect();
  const deployment = loadDeployment();

  const nftAddress = deployment.contracts.QurrlNFT;
  const minterAddress = deployment.contracts.QurrlPhaseMinter;
  assert.ok(minterAddress, 'this deployment has no QurrlPhaseMinter; redeploy with: npm run deploy');
  const nft = contractAt(web3, 'QurrlNFT', nftAddress);
  const minter = contractAt(web3, 'QurrlPhaseMinter', minterAddress);
  const lens = contractAt(web3, 'QurrlLens', deployment.contracts.QurrlLens);

  console.log(`network  ${env.QRL_RPC_URL}`);
  console.log(`caller   ${account.address}\n`);

  const variants = await lens.methods.paletteView().call();
  console.log('palette (counts only; names are not on chain)');
  for (let i = 0; i < 6; i += 1) console.log(`   slot ${i}  ${variants[i]} variants`);

  const before = await lens.methods.collectionView().call();
  console.log(
    `\ncollection  issued ${before.totalMinted}/${before.maxSupply}  circulating ${before.circulating}` +
      `  active season ${before.activeSeason}`,
  );

  const current = await minter.methods.currentPhase().call();
  assert.equal(current.opened ?? current[0], true, 'no phase opened - run: npm run seasons -- --commit 0 && npm run seasons -- --open');
  const phase = Number(current.phase ?? current[1]);
  const row = await minter.methods.rowOf(phase).call();
  const fee = BigInt(row.mintFee);

  console.log(`\nminting 1 in phase ${phase}`);
  const data =
    phase === 0 ? minter.methods.mintGenesis(1, proofFlag()).encodeABI() : minter.methods.mintQrl(1).encodeABI();
  const receipt = await sendRaw(web3, account, {
    to: minterAddress,
    data,
    value: phase === 0 ? 0n : fee,
    gas: 500_000,
  });
  console.log(`   ${phase === 0 ? 'mintGenesis' : 'mintQrl'} tx ${receipt.transactionHash}  gas ${receipt.gasUsed}`);

  const after = await lens.methods.collectionView().call();
  assert.equal(Number(after.totalMinted), Number(before.totalMinted) + 1);

  const tokenId = Number(after.totalMinted);
  const view = await lens.methods.tokenView(tokenId).call();
  console.log(
    `   token ${tokenId}  owner ${view.owner}  season ${view.seasonId}  gen ${view.generation}` +
      `  revealed ${view.revealed}`,
  );
  console.log(`   tokenURI ${await nft.methods.tokenURI(tokenId).call()}`);

  console.log('\nnegative checks');
  await expectRevert(nft.methods.traitsOf(999999).call(), 'traitsOf on an unminted id');
  await expectRevert(
    sendRaw(web3, account, {
      to: nftAddress,
      data: nft.methods.fuse(tokenId, tokenId, [2, 2, 2, 2, 2, 2], 0, []).encodeABI(),
      gas: 400_000,
    }),
    'fusing a token with itself',
  );
  await expectRevert(
    sendRaw(web3, account, {
      to: nftAddress,
      data: nft.methods.mintTo(account.address, 1).encodeABI(),
      gas: 400_000,
    }),
    'mintTo around the minter (MINTER_ROLE)',
  );
  if (phase > 0) {
    await expectRevert(
      sendRaw(web3, account, {
        to: minterAddress,
        data: minter.methods.mintQrl(1).encodeABI(),
        value: fee + 1n,
        gas: 500_000,
      }),
      'mintQrl with the wrong value',
    );
  }

  console.log('\nsmoke ok');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
