/**
 * Deploys a fresh QurrlMetadata for the recorded collection, points the NFT at it
 * and sets its URIs. This is the only moving part of the metadata: the collection
 * itself never changes, so the art can be wired, replaced and finally frozen
 * without touching a token.
 *
 *   npm run renderer -- --sealed ipfs://.../sealed.json --base ipfs://.../
 *   npm run renderer -- --freeze        # irreversible
 *
 * Needs DEFAULT_ADMIN_ROLE on QurrlNFT (to call setRenderer) and on the renderer
 * (which the deployer has until the handover; after it, governance runs this).
 */
const { connect, deploy, contractAt, sendRaw, loadDeployment, saveDeployment } = require('./qrl');

function flag(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (process.argv[i + 1] ?? true);
}

async function main() {
  const { web3, account } = connect();
  const record = loadDeployment();
  const nftAddress = record.contracts.QurrlNFT;
  const nft = contractAt(web3, 'QurrlNFT', nftAddress);

  if (flag('freeze')) {
    const address = record.contracts.QurrlMetadata;
    const meta = contractAt(web3, 'QurrlMetadata', address);
    await sendRaw(web3, account, { to: address, data: meta.methods.freeze().encodeABI(), gas: 200_000 });
    console.log(`QurrlMetadata ${address} is frozen: its URIs can never change`);
    return;
  }

  const sealed = flag('sealed', 'https://qurrl.qrl/meta/sealed.json');
  const base = flag('base', 'https://qurrl.qrl/meta/');

  const meta = await deploy(web3, account, 'QurrlMetadata', [nftAddress, account.address]);
  const address = meta.options.address;
  console.log(`QurrlMetadata       ${address}`);

  const contract = contractAt(web3, 'QurrlMetadata', address);
  await sendRaw(web3, account, { to: address, data: contract.methods.setURIs(sealed, base).encodeABI(), gas: 500_000 });
  await sendRaw(web3, account, { to: nftAddress, data: nft.methods.setRenderer(address).encodeABI(), gas: 200_000 });
  console.log(`   renderer set; sealed ${sealed}  base ${base}`);

  record.contracts.QurrlMetadata = address;
  record.rendererUpdatedAt = new Date().toISOString();
  saveDeployment('private', record);
  console.log('   deployment record updated');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
