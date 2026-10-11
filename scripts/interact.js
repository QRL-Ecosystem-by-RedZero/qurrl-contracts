/**
 * Full lifecycle against the live private network: genesis mint, reveal, the
 * phase 1 QRL pool, fuse, withdraw.
 *
 * Deploys its own collection and QurrlPhaseMinter rather than reusing
 * deployments/private.json, because the run needs season windows it can walk
 * through in one sitting and a fusion budget it is allowed to spend. It leaves the
 * real deployment alone. The ecosystem phase comes from a fresh ArkPhaseDouble
 * (stand-in): this run moves it from 0 to 1 itself, which the real ArkPhase only
 * allows by ArkTimelock vote.
 *
 * Every season's mint window is cut at its committed reveal, so committing the
 * seed a few minutes ahead keeps the shipped 30-day durations and still walks
 * through in minutes. Prices are throwaway; caps are the shipped rows.
 *
 * Live gas is reported per flow. Unlike the local ZVM figures these include the
 * 21,000 intrinsic cost and calldata; the ML-DSA-87 signature and public key
 * ride in the transaction envelope and never appear in gas accounting.
 */
const assert = require('node:assert/strict');
const { connect, deploy, contractAt, sendRaw, toHex } = require('./qrl');
const { PALETTE, PHASE_ROWS, phaseRowTuple, manifestHash, seedFor, commitmentFor, deriveTraits, genesisLeaf } = require('./collection');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function chainNow(web3) {
  return Number((await web3.qrl.getBlock('latest')).timestamp);
}

const SECRET = 'qurrl-interact-run';
const gas = {};

const PRICE = 10n ** 16n;
const FUSION_FEE = 5n * 10n ** 16n;
/** The shipped rows with throwaway prices and no wallet limit. */
const ROWS = PHASE_ROWS.map((r, p) =>
  p === 0 ? r : { ...r, mintFee: PRICE, mintFeeMin: PRICE, mintFeeMax: PRICE, fusionFee: FUSION_FEE, lockBaseFee: 0n, walletLimit: 0 },
);

async function step(label, promise) {
  const receipt = await promise;
  gas[label] = Number(receipt.gasUsed);
  console.log(`   ${label.padEnd(24)} gas ${receipt.gasUsed}`);
  return receipt;
}

async function main() {
  const { web3, account, env } = connect();
  const from = account.address;

  console.log(`network  ${env.QRL_RPC_URL}`);
  console.log(`caller   ${from}\n`);

  console.log('deploying a throwaway collection');
  const registry = await deploy(web3, account, 'QurrlTraitRegistry', [from]);
  const registryAddress = registry.options.address;
  const registryContract = contractAt(web3, 'QurrlTraitRegistry', registryAddress);

  for (const [slot, entry] of PALETTE.entries()) {
    await sendRaw(web3, account, {
      to: registryAddress,
      data: registryContract.methods.setCategory(slot, entry.weights).encodeABI(),
      gas: 250_000,
    });
  }
  await step(
    'sealPalette',
    sendRaw(web3, account, {
      to: registryAddress,
      data: registryContract.methods.sealPalette().encodeABI(),
      gas: 200_000,
    }),
  );
  await step(
    'commitManifest',
    sendRaw(web3, account, {
      to: registryAddress,
      data: registryContract.methods.commitManifest(manifestHash()).encodeABI(),
      gas: 200_000,
    }),
  );

  const nft = await deploy(web3, account, 'QurrlNFT', [
    'Qurrl Interact',
    'QURRLX',
    from,
    registryAddress,
  ]);
  const nftAddress = nft.options.address;
  const nftContract = contractAt(web3, 'QurrlNFT', nftAddress);

  const lens = await deploy(web3, account, 'QurrlLens', [nftAddress, registryAddress]);
  const lensContract = contractAt(web3, 'QurrlLens', lens.options.address);

  const arkPhase = await deploy(web3, account, 'ArkPhaseDouble', []);
  const arkPhaseAddress = arkPhase.options.address;
  const arkPhaseContract = contractAt(web3, 'ArkPhaseDouble', arkPhaseAddress);

  const minter = await deploy(web3, account, 'QurrlPhaseMinter', [
    nftAddress,
    registryAddress,
    arkPhaseAddress,
    from,
    from,
    from,
    ROWS.map(phaseRowTuple),
  ]);
  const minterAddress = minter.options.address;
  const minterContract = contractAt(web3, 'QurrlPhaseMinter', minterAddress);

  const { keccak256, toUtf8Bytes } = require('ethers');
  const role = (n) => keccak256(toUtf8Bytes(n));
  for (const r of ['MINTER_ROLE', 'SEASON_ADMIN_ROLE']) {
    await sendRaw(web3, account, { to: nftAddress, data: nftContract.methods.grantRole(role(r), minterAddress).encodeABI(), gas: 200_000 });
  }

  console.log(`   QurrlTraitRegistry ${registryAddress}`);
  console.log(`   QurrlNFT           ${nftAddress}`);
  console.log(`   QurrlLens          ${lens.options.address}`);
  console.log(`   ArkPhase           ${arkPhaseAddress}  (stand-in)`);
  console.log(`   QurrlPhaseMinter   ${minterAddress}\n`);

  // Block production on the private devnet is irregular (gaps of minutes), so each
  // window is long enough to outlast the transactions that must land inside it.
  const WINDOW = Number(process.env.INTERACT_WINDOW || (process.env.ARK_QRVM === '1' ? 900 : 150));

  /* Phase 0 (season 1): the genesis whitelist, here a one-leaf tree of the caller. */
  console.log('phase 0, season 1');
  const seed1 = seedFor(SECRET, 1);
  const reveal1 = (await chainNow(web3)) + WINDOW;
  await step(
    'setGenesis',
    sendRaw(web3, account, {
      to: minterAddress,
      data: minterContract.methods.setGenesis(genesisLeaf(from), 2).encodeABI(),
      gas: 200_000,
    }),
  );
  await step(
    'commitSeed',
    sendRaw(web3, account, {
      to: registryAddress,
      data: registryContract.methods.commitSeed(1, commitmentFor(1, seed1), reveal1).encodeABI(),
      gas: 150_000,
    }),
  );
  await step('openPhase 0', sendRaw(web3, account, { to: minterAddress, data: minterContract.methods.openPhase().encodeABI(), gas: 600_000 }));
  await step('mintGenesis x1', sendRaw(web3, account, { to: minterAddress, data: minterContract.methods.mintGenesis(1, []).encodeABI(), gas: 500_000 }));
  await step('mintGenesis x1 (warm)', sendRaw(web3, account, { to: minterAddress, data: minterContract.methods.mintGenesis(1, []).encodeABI(), gas: 500_000 }));

  let [, revealed] = Object.values(await nftContract.methods.traitsOf(1).call());
  assert.equal(revealed, false, 'traits must stay sealed until the seed is revealed');
  console.log('   token 1 is sealed before the reveal');

  console.log('   waiting for the reveal time; the registry refuses an earlier reveal');
  try {
    await sendRaw(web3, account, {
      to: registryAddress,
      data: registryContract.methods.revealSeed(1, seed1).encodeABI(),
      gas: 200_000,
    });
    assert.fail('an early reveal was accepted');
  } catch (e) {
    if (e.code === 'ERR_ASSERTION') throw e;
    console.log('   an early reveal was refused');
  }
  while ((await chainNow(web3)) < reveal1) await sleep(5000);

  await step(
    'revealSeed',
    sendRaw(web3, account, {
      to: registryAddress,
      data: registryContract.methods.revealSeed(1, seed1).encodeABI(),
      gas: 150_000,
    }),
  );

  const effective1 = await registryContract.methods.seedOf(1).call();
  const onChain = Object.values(await nftContract.methods.traitsOf(1).call())[0].map(Number);
  assert.deepEqual(onChain, deriveTraits(effective1, 1), 'on-chain traits must match the off-chain derivation');
  console.log(`   token 1 traits ${JSON.stringify(onChain)} match the off-chain mirror`);

  /* Phase 1 (season 2): the QRL pool, then fusion from the season's reveal. */
  console.log('\nphase 1, season 2');
  await sendRaw(web3, account, { to: arkPhaseAddress, data: arkPhaseContract.methods.set(1).encodeABI(), gas: 100_000 });
  console.log('   ArkPhaseDouble set to 1 (stand-in; the real ArkPhase moves by vote)');
  const seed2 = seedFor(SECRET, 2);
  const reveal2 = (await chainNow(web3)) + WINDOW;
  await sendRaw(web3, account, {
    to: registryAddress,
    data: registryContract.methods.commitSeed(2, commitmentFor(2, seed2), reveal2).encodeABI(),
    gas: 150_000,
  });
  await step('openPhase 1', sendRaw(web3, account, { to: minterAddress, data: minterContract.methods.openPhase().encodeABI(), gas: 600_000 }));
  await step('mintQrl x1', sendRaw(web3, account, { to: minterAddress, data: minterContract.methods.mintQrl(1).encodeABI(), value: PRICE, gas: 500_000 }));
  await step('mintQrl x3', sendRaw(web3, account, { to: minterAddress, data: minterContract.methods.mintQrl(3).encodeABI(), value: PRICE * 3n, gas: 1_000_000 }));

  console.log('   waiting for the fusion window (it opens at the season 2 reveal time)');
  while ((await chainNow(web3)) < reveal2) await sleep(5000);

  const beforeFusion = await lensContract.methods.collectionView().call();
  await step(
    'fuse',
    sendRaw(web3, account, {
      to: nftAddress,
      data: nftContract.methods.fuse(1, 2, [0, 0, 0, 0, 0, 0], 0, []).encodeABI(),
      value: FUSION_FEE,
      gas: 600_000,
    }),
  );

  const afterFusion = await lensContract.methods.collectionView().call();
  assert.equal(Number(afterFusion.totalMinted), Number(beforeFusion.totalMinted) + 1);
  assert.equal(Number(afterFusion.totalBurned), Number(beforeFusion.totalBurned) + 2);
  assert.equal(Number(afterFusion.circulating), Number(beforeFusion.circulating) - 1);
  console.log(
    `   issuance ${beforeFusion.totalMinted} -> ${afterFusion.totalMinted},` +
      ` circulating ${beforeFusion.circulating} -> ${afterFusion.circulating}`,
  );

  const heir = Number(afterFusion.totalMinted);
  const view = await lensContract.methods.tokenView(heir).call();
  assert.equal(view.traitsLocked, true);
  assert.deepEqual(view.traits.map(Number), deriveTraits(effective1, 1), 'the heir must carry parent A traits');
  assert.equal(Number(view.generation), 2);
  console.log(`   token ${heir} is generation 2 with locked traits from token ${view.lockedFrom}`);

  const lineage = (await lensContract.methods.lineageOf(heir, 8).call()).map(Number);
  console.log(`   lineage ${lineage.join(' <- ')}`);

  /* Renderer, royalty and the revenue split. */
  console.log('\nrenderer, royalty and revenue split');
  const meta = await deploy(web3, account, 'QurrlMetadata', [nftAddress, from]);
  const metaContract = contractAt(web3, 'QurrlMetadata', meta.options.address);
  await step('setRenderer', sendRaw(web3, account, { to: nftAddress, data: nftContract.methods.setRenderer(meta.options.address).encodeABI(), gas: 200_000 }));
  await step('setURIs', sendRaw(web3, account, { to: meta.options.address, data: metaContract.methods.setURIs('ipfs://sealed.json', 'ipfs://qurrl/').encodeABI(), gas: 400_000 }));
  // Token 1 was burned by the fusion; the heir (locked traits, so revealed at once) is served.
  assert.equal(await nftContract.methods.tokenURI(heir).call(), `ipfs://qurrl/${heir}`, 'a revealed token is served from the revealed base');
  console.log(`   tokenURI(${heir}) = ipfs://qurrl/${heir}`);
  await assert.rejects(nftContract.methods.tokenURI(1).call(), 'a burned token has no URI');

  const zero = process.env.ARK_QRVM === '1' ? 'Q' + '00'.repeat(64) : '0x' + '00'.repeat(20);
  const splitter = await deploy(web3, account, 'QurrlRevenueSplitter', [nftAddress, from, from, zero, 3500]);
  const splitterAddress = splitter.options.address;
  const splitterContract = contractAt(web3, 'QurrlRevenueSplitter', splitterAddress);
  await step('grant TREASURER', sendRaw(web3, account, { to: nftAddress, data: nftContract.methods.grantRole(role('TREASURER_ROLE'), splitterAddress).encodeABI(), gas: 200_000 }));
  await step('setRoyalty', sendRaw(web3, account, { to: nftAddress, data: nftContract.methods.setRoyalty(splitterAddress, 250).encodeABI(), gas: 200_000 }));
  const royalty = await nftContract.methods.royaltyInfo(1, 10_000).call();
  assert.equal(BigInt(royalty[1]), 250n, 'royaltyInfo is 2.5%');
  assert.equal(String(royalty[0]).toLowerCase(), splitterAddress.toLowerCase(), 'royalty is paid to the splitter');
  console.log('   royaltyInfo(1, 10000) = 250 -> splitter');

  // The QRL pool forwards its value to the collection, so the minter holds nothing.
  assert.equal(BigInt(await web3.qrl.getBalance(minterAddress)), 0n, 'the minter forwards every payment');
  const held = BigInt(await web3.qrl.getBalance(nftAddress));
  assert.equal(held, PRICE * 4n + FUSION_FEE, 'four QRL-pool mints and one fusion fee');
  console.log(`   collection holds ${held} wei`);
  await step('sweep', sendRaw(web3, account, { to: splitterAddress, data: splitterContract.methods.sweep().encodeABI(), gas: 500_000 }));
  assert.equal(BigInt(await web3.qrl.getBalance(nftAddress)), 0n);
  const creatorOwed = BigInt(await splitterContract.methods.creatorOwed().call());
  const cushionOwed = BigInt(await splitterContract.methods.cushionOwed().call());
  const treasuryOwed = BigInt(await splitterContract.methods.treasuryPrimaryOwed().call());
  assert.equal(creatorOwed, (held * 1000n) / 10000n, 'creator 10%');
  assert.equal(cushionOwed, (held * 3500n) / 10000n, 'cushion 35%');
  assert.equal(creatorOwed + cushionOwed + treasuryOwed, held, 'the ledgers add up to what was swept');
  console.log(`   10 / 35 / 55 of ${held}: ${creatorOwed} / ${cushionOwed} / ${treasuryOwed}`);

  const fee = 10n ** 15n;
  await step('secondary fee', sendRaw(web3, account, { to: splitterAddress, value: fee, data: '0x', gas: 300_000 }));
  assert.equal(BigInt(await splitterContract.methods.creatorOwed().call()), creatorOwed + fee / 10n, 'a plain transfer is a fee: 10% to the creator');
  assert.equal(BigInt(await splitterContract.methods.treasurySecondaryOwed().call()), fee - fee / 10n, 'and 90% to the treasury');
  console.log('   a plain transfer to the splitter is booked as a secondary fee (10 / 90)');

  await step('claimCreator', sendRaw(web3, account, { to: splitterAddress, data: splitterContract.methods.claimCreator().encodeABI(), gas: 300_000 }));
  assert.equal(BigInt(await splitterContract.methods.creatorOwed().call()), 0n);
  console.log('   the creator line was paid out');

  console.log('\nlive gas');
  for (const [label, used] of Object.entries(gas)) console.log(`   ${label.padEnd(24)} ${used}`);
  console.log('\ninteract ok');
  console.log(`  toHex(deployer) = ${toHex(from)}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
