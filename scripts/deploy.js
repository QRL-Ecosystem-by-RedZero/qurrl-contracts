/**
 * Deploys and wires the Qurrl collection on a private QRL Zond network.
 *
 * Role graph established here, and asserted by test/fixtures.js:
 *
 *   QurrlTraitRegistry
 *     DEFAULT_ADMIN_ROLE -> deployer                  (seals the palette)
 *     CURATOR_ROLE       -> deployer, plus CURATOR_ADDRESS
 *   QurrlNFT
 *     DEFAULT_ADMIN_ROLE -> deployer                  (renderer, royalty)
 *     SEASON_ADMIN_ROLE  -> deployer, plus QurrlPhaseMinter
 *     MINTER_ROLE        -> QurrlPhaseMinter
 *     TREASURER_ROLE     -> deployer, plus TREASURER_ADDRESS
 *     PAUSER_ROLE        -> deployer
 *   QurrlMetadata
 *     DEFAULT_ADMIN_ROLE -> deployer                  (URIs, freeze)
 *   QurrlRevenueSplitter
 *     TREASURER_ROLE on QurrlNFT, royalty receiver
 *     governance         -> deployer, until `npm run handover` (wiring is one-shot governance)
 *     treasury           -> TREASURY_ROUTER_ADDRESS when set (ArkTreasuryRouter, once)
 *   QurrlBudget
 *     the QURRL_BUDGET lane (Treasury-Flows §7); governance -> deployer, until handover
 *   QurrlLens
 *     no roles, no state, holds nothing
 *   QurrlPhaseMinter
 *     deployer           -> the deploying account     (setGenesis, once)
 *     governance         -> deployer, until handover moves it to GOVERNANCE_ADDRESS
 *     owner              -> MINTER_OWNER_ADDRESS or deployer   (reqPts, mintFee)
 *     acornOracle        -> ACORN_ORACLE_ADDRESS or deployer   (postAcornRoot)
 *     arkPhase           -> ARK_PHASE_ADDRESS, else a fresh ArkPhaseDouble (stand-in)
 *
 * The minter configures and activates every season itself (`openPhase`) and reads
 * the phase from the collection's season count, so it must end up the ONLY holder
 * of SEASON_ADMIN_ROLE: SEASON_ADMIN_ADDRESS is no longer granted, and
 * `npm run handover` renounces the deployer's copy. Every other admin role is on
 * the deployer when this script ends; `handover` moves all but the curator's
 * reveal right to GOVERNANCE_ADDRESS.
 *
 * The NFT holds no role on the registry. It only ever reads from it, so a
 * compromised NFT cannot rewrite a season seed, and a redeployed Lens can never
 * invalidate collection state.
 *
 * The palette is sealed here because `configureSeason` refuses to run against
 * an open one. On a private network that is free - redeploy to change it. Do
 * not carry this straight to a public network: sealing placeholder variant
 * counts fixes the trait distribution before the art exists.
 */
const { connect, deploy, sendRaw, contractAt, saveDeployment } = require('./qrl');
const { PALETTE, PHASE_ROWS, phaseRowTuple, manifestHash } = require('./collection');
const { keccak256, toUtf8Bytes } = require('ethers');

const role = (n) => keccak256(toUtf8Bytes(n));
const ZERO_ADDRESS = process.env.ARK_QRVM === '1' ? 'Q' + '00'.repeat(64) : '0x' + '00'.repeat(20);

const NAME = process.env.QURRL_NAME || 'Qurrl';
const SYMBOL = process.env.QURRL_SYMBOL || 'QURRL';
const SEALED_URI = process.env.QURRL_SEALED_URI || 'https://qurrl.qrl/meta/sealed.json';
const REVEALED_BASE = process.env.QURRL_REVEALED_BASE || 'https://qurrl.qrl/meta/';
const CUSHION_BPS = Number(process.env.QURRL_CUSHION_BPS || 3500);
const ROYALTY_BPS = Number(process.env.QURRL_ROYALTY_BPS || 250);

async function grant(web3, account, name, address, roleHash, to, label) {
  const c = contractAt(web3, name, address);
  await sendRaw(web3, account, { to: address, data: c.methods.grantRole(roleHash, to).encodeABI(), gas: 200_000 });
  console.log(`   granted ${label} -> ${to}`);
}

async function main() {
  const seal = !process.argv.includes('--no-seal');
  const { web3, account, env } = connect();
  const chainId = await web3.qrl.getChainId();

  console.log(`network  ${env.QRL_RPC_URL}  chainId ${chainId}`);
  console.log(`deployer ${account.address}\n`);

  const registry = await deploy(web3, account, 'QurrlTraitRegistry', [account.address]);
  const registryAddress = registry.options.address;
  console.log(`QurrlTraitRegistry  ${registryAddress}`);

  console.log('\nwriting the placeholder palette');
  const registryContract = contractAt(web3, 'QurrlTraitRegistry', registryAddress);
  for (const [slot, entry] of PALETTE.entries()) {
    await sendRaw(web3, account, {
      to: registryAddress,
      data: registryContract.methods.setCategory(slot, entry.weights).encodeABI(),
      gas: 600_000,
    });
    console.log(`   slot ${slot}  ${entry.variants} variants`);
  }

  if (seal) {
    await sendRaw(web3, account, {
      to: registryAddress,
      data: registryContract.methods.sealPalette().encodeABI(),
      gas: 150_000,
    });
    console.log('   palette sealed');
    await sendRaw(web3, account, {
      to: registryAddress,
      data: registryContract.methods.commitManifest(manifestHash(env)).encodeABI(),
      gas: 150_000,
    });
    console.log(`   manifest committed ${manifestHash(env)}${env.QURRL_MANIFEST_HASH ? '' : '  (PLACEHOLDER: set QURRL_MANIFEST_HASH)'}`);
  } else {
    console.log('   palette left open (--no-seal); seasons cannot be configured yet');
  }

  const nft = await deploy(web3, account, 'QurrlNFT', [NAME, SYMBOL, account.address, registryAddress]);
  const nftAddress = nft.options.address;
  console.log(`\nQurrlNFT            ${nftAddress}`);

  const lens = await deploy(web3, account, 'QurrlLens', [nftAddress, registryAddress]);
  console.log(`QurrlLens           ${lens.options.address}`);

  const metadata = await deploy(web3, account, 'QurrlMetadata', [nftAddress, account.address]);
  const metadataAddress = metadata.options.address;
  console.log(`QurrlMetadata       ${metadataAddress}`);

  const creator = env.CREATOR_ADDRESS || account.address;
  // Every governed contract starts on the deployer: the splitter's wiring is one-shot
  // governance, and `npm run handover` moves all of them to GOVERNANCE_ADDRESS at once.
  const governance = account.address;
  const splitter = await deploy(web3, account, 'QurrlRevenueSplitter', [
    nftAddress,
    creator,
    governance,
    env.QDAY_ORACLE_ADDRESS || ZERO_ADDRESS,
    CUSHION_BPS,
  ]);
  const splitterAddress = splitter.options.address;
  console.log(`QurrlRevenueSplitter ${splitterAddress}`);

  const budget = await deploy(web3, account, 'QurrlBudget', [governance, env.QDAY_ORACLE_ADDRESS || ZERO_ADDRESS]);
  const budgetAddress = budget.options.address;
  console.log(`QurrlBudget         ${budgetAddress}`);
  if (env.TREASURY_ROUTER_ADDRESS) {
    const splitterContract = contractAt(web3, 'QurrlRevenueSplitter', splitterAddress);
    await sendRaw(web3, account, { to: splitterAddress, data: splitterContract.methods.setTreasury(env.TREASURY_ROUTER_ADDRESS).encodeABI(), gas: 200_000 });
    console.log(`   splitter treasury -> ${env.TREASURY_ROUTER_ADDRESS} (ArkTreasuryRouter)`);
  }

  // contracts/core's ArkPhase is not deployed yet; until it is, a stand-in anyone can set.
  let arkPhaseAddress = env.ARK_PHASE_ADDRESS;
  const arkPhaseStandIn = !arkPhaseAddress;
  if (arkPhaseStandIn) {
    const double = await deploy(web3, account, 'ArkPhaseDouble', []);
    arkPhaseAddress = double.options.address;
    console.log(`ArkPhase            ${arkPhaseAddress}  (stand-in, contracts/core ArkPhase not deployed)`);
  } else {
    console.log(`ArkPhase            ${arkPhaseAddress}  (ARK_PHASE_ADDRESS)`);
  }

  // Deployed directly, never through ChunkedDeployer: `setGenesis` is gated on the
  // constructor's msg.sender, which must be this account.
  const minterOwner = env.MINTER_OWNER_ADDRESS || account.address;
  const acornOracle = env.ACORN_ORACLE_ADDRESS || account.address;
  const minter = await deploy(web3, account, 'QurrlPhaseMinter', [
    nftAddress,
    registryAddress,
    arkPhaseAddress,
    governance,
    minterOwner,
    acornOracle,
    PHASE_ROWS.map(phaseRowTuple),
  ]);
  const minterAddress = minter.options.address;
  console.log(`QurrlPhaseMinter    ${minterAddress}\n`);

  console.log('wiring the collection');
  const nftContract = contractAt(web3, 'QurrlNFT', nftAddress);
  const metadataContract = contractAt(web3, 'QurrlMetadata', metadataAddress);
  await sendRaw(web3, account, { to: nftAddress, data: nftContract.methods.setRenderer(metadataAddress).encodeABI(), gas: 200_000 });
  console.log('   renderer set');
  await sendRaw(web3, account, {
    to: metadataAddress,
    data: metadataContract.methods.setURIs(SEALED_URI, REVEALED_BASE).encodeABI(),
    gas: 500_000,
  });
  console.log('   metadata URIs set (placeholders; mutable until QurrlMetadata.freeze)');
  await grant(web3, account, 'QurrlNFT', nftAddress, role('TREASURER_ROLE'), splitterAddress, 'TREASURER_ROLE (splitter)');
  await sendRaw(web3, account, {
    to: nftAddress,
    data: nftContract.methods.setRoyalty(splitterAddress, ROYALTY_BPS).encodeABI(),
    gas: 200_000,
  });
  console.log(`   royalty ${ROYALTY_BPS} bps -> splitter`);
  await grant(web3, account, 'QurrlNFT', nftAddress, role('MINTER_ROLE'), minterAddress, 'MINTER_ROLE (minter)');
  await grant(web3, account, 'QurrlNFT', nftAddress, role('SEASON_ADMIN_ROLE'), minterAddress, 'SEASON_ADMIN_ROLE (minter)');
  // Tier proofs for free trait locks are checked against the root the minter holds; set once.
  await sendRaw(web3, account, { to: nftAddress, data: nftContract.methods.setAcornSource(minterAddress).encodeABI(), gas: 200_000 });
  console.log('QurrlNFT acorn source -> minter');
  console.log('');

  console.log('wiring roles');
  if (env.CURATOR_ADDRESS) {
    await grant(web3, account, 'QurrlTraitRegistry', registryAddress, role('CURATOR_ROLE'), env.CURATOR_ADDRESS, 'CURATOR_ROLE');
  }
  if (env.SEASON_ADMIN_ADDRESS) {
    console.log('   SEASON_ADMIN_ADDRESS ignored: QurrlPhaseMinter must be the only season admin');
  }
  if (env.TREASURER_ADDRESS) {
    await grant(web3, account, 'QurrlNFT', nftAddress, role('TREASURER_ROLE'), env.TREASURER_ADDRESS, 'TREASURER_ROLE');
  }
  if (!env.CURATOR_ADDRESS && !env.TREASURER_ADDRESS) {
    console.log('   every role stays on the deployer');
  }

  const out = saveDeployment('private', {
    network: env.QRL_RPC_URL,
    chainId: Number(chainId),
    deployer: account.address,
    deployedAt: new Date().toISOString(),
    collection: { name: NAME, symbol: SYMBOL, maxSupply: 10500, cushionBps: CUSHION_BPS, royaltyBps: ROYALTY_BPS },
    roles: { creator, governance, targetGovernance: env.GOVERNANCE_ADDRESS || null, minterOwner, acornOracle },
    arkPhaseStandIn,
    paletteSealed: seal,
    contracts: {
      QurrlTraitRegistry: registryAddress,
      QurrlNFT: nftAddress,
      QurrlLens: lens.options.address,
      QurrlMetadata: metadataAddress,
      QurrlRevenueSplitter: splitterAddress,
      QurrlPhaseMinter: minterAddress,
      QurrlBudget: budgetAddress,
      ArkPhase: arkPhaseAddress,
    },
  });

  console.log(`\nsaved -> ${out}`);
  console.log('next: npm run seasons -- --genesis <root> <perWallet>   (once, this deployer, before phase 0 opens)');
  console.log('      npm run seasons -- --commit 0 && npm run seasons -- --open');
  console.log('then, when setup is done: npm run handover -- --execute   (needs GOVERNANCE_ADDRESS)');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
