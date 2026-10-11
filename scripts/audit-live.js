/**
 * On-chain audit of the claims the design makes, on a throwaway collection.
 *
 * Each check states the property, performs the action that would violate it, and
 * asserts the chain refused. What it proves, in order:
 *
 *   1. ordering: a season seed cannot be committed before the trait manifest, nor a
 *      reveal scheduled more than 400 days out; a season cannot be configured with a
 *      window that closes after its reveal or a fusion window that opens before it;
 *      a phase cannot open before the genesis list, before the ecosystem reaches it,
 *      or while the previous season runs; nobody mints around QurrlPhaseMinter;
 *   2. the handover: after `handover.js --execute` the deployer can still commit and
 *      reveal seeds and can do nothing else (no season, no pause, no royalty, no
 *      renderer, no role grants), governance can do the admin part, and only the
 *      minter can configure or activate a season;
 *   3. money: the splitter's wiring belongs to governance and not to the deployer; the
 *      treasury and cushion lines reach real ArkFlowReceiver contracts through
 *      ArkFlowSend (64-byte addresses, struct returns, try/catch), once each;
 *   4. the creator line is a constant 10% and cannot be raised by governance;
 *   5. on QIP-55, QurrlNFT deployed through ChunkedDeployer works (the public path).
 *
 *   6. the reveal window: the curator cannot reveal once it has closed, anyone can default
 *      the season, and the defaulted traits are a real function of the effective seed. This
 *      needs the devnet build profile (14-minute window); a spec build skips it.
 *
 * The ecosystem phase is a fresh ArkPhaseDouble (stand-in for contracts/core ArkPhase).
 * The minter's phase 0 row is the shipped one except that 20 of its 105 go to a QRL pool
 * (throwaway), so money flows without waiting out a phase.
 *
 *   ARK_QRVM=1 node scripts/audit-live.js
 */
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { keccak256, toUtf8Bytes } = require('ethers');
const q = require('./qrl');
const { PALETTE, PHASE_ROWS, phaseRowTuple, manifestHash, seedFor, commitmentFor, genesisLeaf, ZERO32, DAY } = require('./collection');

const V3 = process.env.ARK_QRVM === '1';
const role = (n) => keccak256(toUtf8Bytes(n));
const ZERO = V3 ? 'Q' + '00'.repeat(64) : '0x' + '00'.repeat(20);
const results = [];

const PRICE = 10n ** 16n;
const ROWS = PHASE_ROWS.map((r, p) =>
  p === 0 ? { ...r, acornCap: r.acornCap - 20, qrlCap: 20, mintFee: PRICE, mintFeeMin: PRICE, mintFeeMax: PRICE } : r,
);

/** `IQurrlNFT.SeasonConfig`, for the direct configureSeason checks. */
const seasonConfig = (opensAt, closesAt, fusionCap = 0, fusionOpensAt = 0, fusionClosesAt = 0) => ({
  primaryCap: 20,
  fusionCap,
  opensAt,
  closesAt,
  fusionOpensAt,
  fusionClosesAt,
  fusionFee: '0',
  lockBaseFee: '0',
});

async function refuses(label, promise) {
  try {
    await promise;
  } catch {
    results.push(label);
    console.log(`   refused: ${label}`);
    return;
  }
  throw new Error(`AUDIT FAILURE: "${label}" was supposed to be refused and went through`);
}

function allows(label) {
  results.push(label);
  console.log(`   allowed: ${label}`);
}

async function main() {
  const { web3, account, env } = q.connect();
  const from = account.address;
  const send = (acct, to, data, gas = 500_000, value = 0n) => q.sendRaw(web3, acct, { to, data, gas, value });
  const now = async () => Number((await web3.qrl.getBlock('latest')).timestamp);

  /* A second account that plays governance. It receives roles; it needs a key to prove it can use them. */
  const lib = V3 ? require('@theqrl/wallet.js-v6') : require('@theqrl/wallet.js');
  const govWallet = lib.MLDSA87.newWallet();
  const gov = web3.qrl.accounts.seedToAccount(govWallet.getHexExtendedSeed());
  web3.qrl.accounts.wallet.add(gov);
  console.log(`deployer    ${from}`);
  console.log(`governance  ${gov.address}  (throwaway)\n`);
  await send(account, gov.address, '0x', 100_000, 3n * 10n ** 18n);

  console.log('deploying the collection');
  const registry = await q.deploy(web3, account, 'QurrlTraitRegistry', [from]);
  const R = registry.options.address;
  const registryC = contractAt('QurrlTraitRegistry', R);
  function contractAt(name, address) {
    return q.contractAt(web3, name, address);
  }
  for (const [slot, entry] of PALETTE.entries()) {
    await send(account, R, registryC.methods.setCategory(slot, entry.weights).encodeABI(), 600_000);
  }
  await send(account, R, registryC.methods.sealPalette().encodeABI(), 200_000);

  const nft = await q.deploy(web3, account, 'QurrlNFT', ['Qurrl Audit', 'QURRLA', from, R]);
  const N = nft.options.address;
  const nftC = contractAt('QurrlNFT', N);
  const meta = await q.deploy(web3, account, 'QurrlMetadata', [N, from]);
  const M = meta.options.address;
  const splitter = await q.deploy(web3, account, 'QurrlRevenueSplitter', [N, from, gov.address, ZERO, 3500]);
  const S = splitter.options.address;
  const splitterC = contractAt('QurrlRevenueSplitter', S);
  const sink = await q.deploy(web3, account, 'SplitterSink');
  const sink2 = await q.deploy(web3, account, 'SplitterSink');
  const arkPhase = await q.deploy(web3, account, 'ArkPhaseDouble', []);
  const A = arkPhase.options.address;
  const minter = await q.deploy(web3, account, 'QurrlPhaseMinter', [N, R, A, gov.address, from, from, ROWS.map(phaseRowTuple)]);
  const P = minter.options.address;
  const minterC = contractAt('QurrlPhaseMinter', P);
  console.log(`   ArkPhase ${A}  (stand-in, contracts/core ArkPhase not deployed)`);
  console.log(`   QurrlPhaseMinter ${P}`);

  await send(account, N, nftC.methods.setRenderer(M).encodeABI(), 200_000);
  await send(account, N, nftC.methods.grantRole(role('TREASURER_ROLE'), S).encodeABI(), 200_000);
  await send(account, N, nftC.methods.setRoyalty(S, 250).encodeABI(), 200_000);
  await send(account, N, nftC.methods.grantRole(role('MINTER_ROLE'), P).encodeABI(), 200_000);
  await send(account, N, nftC.methods.grantRole(role('SEASON_ADMIN_ROLE'), P).encodeABI(), 200_000);

  const revealWindow = Number(await registryC.methods.REVEAL_WINDOW().call());
  const shortWindow = revealWindow < DAY; // the devnet build profile
  console.log(`\nreveal window ${revealWindow} s${shortWindow ? ' (devnet profile)' : ' (spec)'}`);

  /* 1. Ordering. */
  console.log('\n1. ordering');
  const t0 = await now();
  const commitment = commitmentFor(1, seedFor('audit-live', 1));
  await refuses('commitSeed before the trait manifest is committed', send(account, R, registryC.methods.commitSeed(1, commitment, t0 + 3600).encodeABI(), 300_000));
  await send(account, R, registryC.methods.commitManifest(manifestHash(env)).encodeABI(), 200_000);
  await refuses('a second manifest commitment', send(account, R, registryC.methods.commitManifest(keccak256(toUtf8Bytes('other'))).encodeABI(), 200_000));
  await refuses('a reveal scheduled 401 days out', send(account, R, registryC.methods.commitSeed(1, commitment, t0 + 401 * DAY).encodeABI(), 300_000));
  await refuses('a reveal scheduled in the past', send(account, R, registryC.methods.commitSeed(1, commitment, t0 - 10).encodeABI(), 300_000));

  // With the devnet profile the season closes in 15 minutes so that the reveal window can be
  // watched closing at the end of this script; otherwise an hour is ample. openPhase cuts the
  // mint window at this reveal, so it is also the season's close.
  const closesAt = t0 + (shortWindow ? 900 : 3600);
  await send(account, R, registryC.methods.commitSeed(1, commitment, closesAt).encodeABI(), 300_000);
  await refuses(
    'a season whose window closes after its reveal moment',
    send(account, N, nftC.methods.configureSeason(1, seasonConfig(t0 - 60, closesAt + 100)).encodeABI(), 600_000),
  );
  await refuses(
    'a fusion window that opens before the reveal',
    send(account, N, nftC.methods.configureSeason(1, seasonConfig(t0 - 60, closesAt, 2, closesAt - 1, closesAt + 3600)).encodeABI(), 600_000),
  );
  await refuses(
    'a season window that is already over',
    send(account, N, nftC.methods.configureSeason(1, seasonConfig(t0 - 7200, t0 - 3600)).encodeABI(), 600_000),
  );

  await refuses('openPhase before the genesis list is set', send(account, P, minterC.methods.openPhase().encodeABI(), 600_000));
  await refuses('setGenesis by anyone but the deploying account', send(gov, P, minterC.methods.setGenesis(genesisLeaf(gov.address), 1).encodeABI(), 200_000));
  await send(account, P, minterC.methods.setGenesis(genesisLeaf(from), 1).encodeABI(), 200_000);
  await refuses('a second setGenesis', send(account, P, minterC.methods.setGenesis(genesisLeaf(gov.address), 1).encodeABI(), 200_000));
  await send(account, P, minterC.methods.openPhase().encodeABI(), 600_000);
  const s1 = (await nftC.methods.seasonView(1).call()).config;
  assert.equal(Number(s1.closesAt), closesAt, 'the mint window is cut at the reveal');
  allows('openPhase (permissionless) configures season 1 from the row and closes it at the reveal');
  await refuses('opening phase 1 before the ecosystem reaches it', send(gov, P, minterC.methods.openPhase().encodeABI(), 600_000));
  await send(account, A, contractAt('ArkPhaseDouble', A).methods.set(1).encodeABI(), 100_000);
  await refuses('opening phase 1 while season 1 runs', send(gov, P, minterC.methods.openPhase().encodeABI(), 600_000));
  await send(account, A, contractAt('ArkPhaseDouble', A).methods.set(0).encodeABI(), 100_000);

  await refuses('mintTo around the minter', send(account, N, nftC.methods.mintTo(from, 1).encodeABI(), 600_000));
  await refuses('reveal before the window has closed', send(account, R, registryC.methods.revealSeed(1, seedFor('audit-live', 1)).encodeABI(), 300_000));
  await refuses('revealDefault long before its window', send(account, R, registryC.methods.revealDefault(1).encodeABI(), 300_000));
  await refuses('mintGenesis by an address not on the list', send(gov, P, minterC.methods.mintGenesis(1, []).encodeABI(), 600_000));
  await send(account, P, minterC.methods.mintGenesis(1, []).encodeABI(), 600_000);
  await refuses('mintGenesis past the per-wallet allowance', send(account, P, minterC.methods.mintGenesis(1, []).encodeABI(), 600_000));
  await refuses('mintQrl with the wrong value', send(account, P, minterC.methods.mintQrl(1).encodeABI(), 600_000, PRICE - 1n));
  await send(account, P, minterC.methods.mintQrl(6).encodeABI(), 1_400_000, PRICE * 6n);
  allows('genesis and QRL pool mints through the minter');

  /* 2. Handover. */
  console.log('\n2. handover');
  const rec = q.saveDeployment('audit-live', {
    network: env.QRL_RPC_URL,
    deployer: from,
    contracts: { QurrlNFT: N, QurrlTraitRegistry: R, QurrlMetadata: M, QurrlRevenueSplitter: S, QurrlPhaseMinter: P, ArkPhase: A },
    arkPhaseStandIn: true,
    scratch: true,
  });
  const run = spawnSync(process.execPath, [path.join(__dirname, 'handover.js'), '--execute', '--record', 'audit-live'], {
    env: { ...process.env, GOVERNANCE_ADDRESS: gov.address },
    encoding: 'utf8',
  });
  console.log(run.stdout.split('\n').filter((l) => /verified|keeps|ROLE  |Error/i.test(l)).map((l) => `   ${l}`).join('\n'));
  assert.equal(run.status, 0, `handover failed: ${run.stderr || run.stdout}`);
  void rec;

  await refuses('deployer: pause', send(account, N, nftC.methods.pause().encodeABI(), 200_000));
  await refuses('deployer: setRoyalty', send(account, N, nftC.methods.setRoyalty(from, 100).encodeABI(), 200_000));
  await refuses('deployer: setRenderer', send(account, N, nftC.methods.setRenderer(M).encodeABI(), 200_000));
  await refuses('deployer: configureSeason', send(account, N, nftC.methods.configureSeason(2, seasonConfig(t0, closesAt + 7200)).encodeABI(), 600_000));
  await refuses('deployer: setActiveSeason', send(account, N, nftC.methods.setActiveSeason(1).encodeABI(), 200_000));
  await refuses('governance: configureSeason (the minter is the only season admin)', send(gov, N, nftC.methods.configureSeason(2, seasonConfig(t0, closesAt + 7200)).encodeABI(), 600_000));
  await refuses('deployer: grant itself a role back', send(account, N, nftC.methods.grantRole(role('SEASON_ADMIN_ROLE'), from).encodeABI(), 200_000));
  await refuses('deployer: withdraw from the collection', send(account, N, nftC.methods.withdraw(from).encodeABI(), 200_000));
  await refuses('deployer: change the renderer URIs', send(account, M, contractAt('QurrlMetadata', M).methods.setURIs('x', 'y').encodeABI(), 300_000));
  await refuses('deployer: seal or edit the palette', send(account, R, registryC.methods.setCategory(0, PALETTE[0].weights).encodeABI(), 600_000));
  await refuses('deployer: act as the minter governance (setOwner)', send(account, P, minterC.methods.setOwner(from).encodeABI(), 200_000));

  const t1 = await now();
  await send(account, R, registryC.methods.commitSeed(2, commitmentFor(2, seedFor('audit-live', 2)), t1 + 7200).encodeABI(), 300_000);
  allows('deployer: commit a season seed (its curator right)');

  await send(gov, N, nftC.methods.pause().encodeABI(), 200_000);
  await send(gov, N, nftC.methods.unpause().encodeABI(), 200_000);
  await send(gov, N, nftC.methods.setRoyalty(S, 300).encodeABI(), 200_000);
  allows('governance: pause, unpause, setRoyalty');
  await refuses('governance: royalty above the 5% ceiling', send(gov, N, nftC.methods.setRoyalty(S, 501).encodeABI(), 200_000));

  /* 3 and 4. Money. */
  console.log('\n3. money');
  await refuses('deployer: wire the treasury', send(account, S, splitterC.methods.setTreasury(sink.options.address).encodeABI(), 200_000));
  await send(gov, S, splitterC.methods.setTreasury(sink.options.address).encodeABI(), 200_000);
  await send(gov, S, splitterC.methods.setCushion(sink2.options.address).encodeABI(), 200_000);
  allows('governance: wire treasury and cushion');
  await refuses('governance: wire the treasury a second time', send(gov, S, splitterC.methods.setTreasury(sink2.options.address).encodeABI(), 200_000));

  assert.equal(BigInt(await web3.qrl.getBalance(P)), 0n, 'the minter forwards every payment to the collection');
  await send(account, S, splitterC.methods.sweep().encodeABI());
  const held = PRICE * 6n;
  assert.equal(BigInt(await splitterC.methods.creatorOwed().call()), (held * 1000n) / 10000n);
  assert.equal(BigInt(await splitterC.methods.cushionOwed().call()), (held * 3500n) / 10000n);
  allows('sweep books 10 / 35 / 55');

  const balance = async (a) => BigInt(await web3.qrl.getBalance(a));
  const before = [await balance(sink.options.address), await balance(sink2.options.address)];
  await send(account, S, splitterC.methods.claimTreasury().encodeABI(), 600_000);
  await send(account, S, splitterC.methods.claimCushion().encodeABI(), 600_000);
  assert.equal((await balance(sink.options.address)) - before[0], held - (held * 1000n) / 10000n - (held * 3500n) / 10000n);
  assert.equal((await balance(sink2.options.address)) - before[1], (held * 3500n) / 10000n);
  allows('treasury and cushion lines reach real ArkFlowReceiver contracts (ArkFlowSend on this chain)');
  await refuses('claiming the cushion line twice', send(account, S, splitterC.methods.claimCushion().encodeABI(), 400_000));

  console.log('\n4. the creator share');
  await refuses('anyone: change the creator', send(gov, S, splitterC.methods.proposeCreator(gov.address).encodeABI(), 200_000));
  assert.equal(await splitterC.methods.CREATOR_BPS().call().then(BigInt), 1000n);
  await send(gov, S, splitterC.methods.setCushionBps(4250).encodeABI(), 600_000);
  // 4,250 -> 3,400 is 8.5 points, one more than a step allows.
  await refuses('governance: move the cushion rate by more than 7.5 points', send(gov, S, splitterC.methods.setCushionBps(3400).encodeABI(), 600_000));
  allows('governance: move the cushion rate one step');

  /* 5. The public deployment path. */
  if (V3) {
    console.log('\n5. QurrlNFT through ChunkedDeployer');
    const chunked = await q.deploy(web3, account, 'ChunkedDeployer');
    const address = await q.deployChunked(
      web3,
      account,
      chunked.options.address,
      q.artifact('ChunkedDeployer'),
      q.artifact('QurrlNFT'),
      ['Qurrl Chunked', 'QURRLC', from, R],
      { log: (l) => console.log(l) },
    );
    const viaChunks = contractAt('QurrlNFT', address);
    assert.equal(Number(await viaChunks.methods.MAX_SUPPLY().call()), 10500);
    assert.equal(await viaChunks.methods.name().call(), 'Qurrl Chunked');
    allows('QurrlNFT deployed in pieces answers MAX_SUPPLY = 10500');
  }

  /* 6. The reveal window closing. Needs the devnet profile: a spec build waits 14 days. */
  console.log('\n6. the reveal window');
  if (!shortWindow) {
    console.log('   skipped: this build has the 14-day window; compile with --profile devnet to watch it close');
  } else {
    const closed = closesAt + revealWindow + 30;
    console.log(`   waiting for chain time ${closed} (the curator window ends)`);
    while ((await now()) < closed) await new Promise((r) => setTimeout(r, 10_000));

    await refuses('curator: reveal after the window has closed', send(account, R, registryC.methods.revealSeed(1, seedFor('audit-live', 1)).encodeABI(), 300_000));
    assert.equal(await registryC.methods.isRevealed(1).call(), false);

    await send(gov, R, registryC.methods.revealDefault(1).encodeABI(), 300_000);
    allows('anyone: revealDefault once the curator has missed the window');
    assert.equal(await registryC.methods.isRevealed(1).call(), true);
    const effective = await registryC.methods.seedOf(1).call();
    assert.notEqual(effective, ZERO32, 'a defaulted season gets a real seed');
    const { deriveTraits } = require('./collection');
    const onChain = Object.values(await nftC.methods.traitsOf(1).call())[0].map(Number);
    assert.deepEqual(onChain, deriveTraits(effective, 1), 'defaulted traits match the off-chain derivation');
    allows('defaulted traits are the same function of the effective seed');
    await refuses('a second reveal of a defaulted season', send(gov, R, registryC.methods.revealDefault(1).encodeABI(), 300_000));
    await refuses('the curator revealing a defaulted season', send(account, R, registryC.methods.revealSeed(1, seedFor('audit-live', 1)).encodeABI(), 300_000));
  }

  console.log(`\naudit-live ok: ${results.length} properties checked on ${V3 ? 'QIP-55' : 'the 20-byte line'}`);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
