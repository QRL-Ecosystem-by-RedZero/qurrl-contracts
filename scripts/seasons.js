/**
 * Phase and season operations against a deployed collection.
 *
 * One ecosystem phase is one season (season id = phase + 1). `QurrlPhaseMinter`
 * configures and activates each season from the row it was deployed with, so the
 * only steps left to people are the seed, the genesis list and the trigger:
 *
 *   setGenesis (once, phase 0)  ->  commit seed  ->  openPhase  ->  (mint window)
 *     ->  reveal  ->  (fusion window)  ->  next phase
 *
 * The order is enforced on chain: `openPhase` refuses until the ecosystem's
 * ArkPhase has reached the phase, the previous season's last window is over and
 * this season's seed is committed with a reveal still in the future. The mint
 * window runs from the opening for the row's `mintDuration`, cut short at the
 * committed `revealNotBefore`; the fusion window opens at that reveal. Commit the
 * seed `--lead` seconds ahead of the reveal you want if the phase will not be
 * opened straight away, or the mint window shrinks by the gap.
 *
 * Usage:
 *   npm run seasons -- --genesis <root> <perWallet>   deployer, once, before phase 0 opens
 *   npm run seasons -- --commit <phase> [--lead <seconds>]
 *   npm run seasons -- --open
 *   npm run seasons -- --reveal <seasonId>
 *   npm run seasons -- --default <seasonId>
 *   npm run seasons -- --set-phase <n>                ArkPhaseDouble stand-in only
 *   npm run seasons -- --status
 */
const { connect, contractAt, sendRaw, loadDeployment } = require('./qrl');
const { PHASES, seedFor, commitmentFor } = require('./collection');

function flag(name, fallback = null, count = 1) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  if (count === 1) return process.argv[i + 1] ?? true;
  return process.argv.slice(i + 1, i + 1 + count);
}

function requireSecret(env) {
  if (!env.SEASON_SEED_SECRET) {
    throw new Error('SEASON_SEED_SECRET missing from .env - run: npm run gen:deployer');
  }
  return env.SEASON_SEED_SECRET;
}

function requireMinter(deployment) {
  if (!deployment.contracts.QurrlPhaseMinter) {
    throw new Error('this deployment has no QurrlPhaseMinter; redeploy with: npm run deploy');
  }
  return deployment.contracts.QurrlPhaseMinter;
}

const iso = (t) => (Number(t) ? new Date(Number(t) * 1000).toISOString() : '-');

async function status(web3, deployment) {
  const nft = contractAt(web3, 'QurrlNFT', deployment.contracts.QurrlNFT);
  const lens = contractAt(web3, 'QurrlLens', deployment.contracts.QurrlLens);

  const collection = await lens.methods.collectionView().call();
  console.log(
    `issued ${collection.totalMinted}/${collection.maxSupply}  burned ${collection.totalBurned}  ` +
      `circulating ${collection.circulating}  allocated ${collection.allocated}  active season ${collection.activeSeason}`,
  );

  if (!deployment.contracts.QurrlPhaseMinter) {
    console.log('no QurrlPhaseMinter in this deployment record');
    return;
  }
  const minter = contractAt(web3, 'QurrlPhaseMinter', deployment.contracts.QurrlPhaseMinter);
  const arkPhase = contractAt(web3, 'ArkPhaseDouble', deployment.contracts.ArkPhase);
  const [current, ecosystem, genesisRoot, genesisPerWallet, acornEpoch, acornRoot] = await Promise.all([
    minter.methods.currentPhase().call(),
    arkPhase.methods.phase().call(),
    minter.methods.genesisRoot().call(),
    minter.methods.genesisPerWallet().call(),
    minter.methods.acornEpoch().call(),
    minter.methods.acornRoot().call(),
  ]);
  const opened = current.opened ?? current[0];
  const phaseNow = current.phase ?? current[1];
  console.log(
    `ecosystem phase ${ecosystem}${deployment.arkPhaseStandIn ? ' (stand-in)' : ''}  ` +
      `collection phase ${opened ? phaseNow : 'none opened'}`,
  );
  console.log(`genesis root ${genesisRoot}  per wallet ${genesisPerWallet}`);
  console.log(`acorn root   ${acornRoot}  epoch ${acornEpoch}`);

  const count = Number(await nft.methods.seasonCount().call());
  for (const spec of PHASES) {
    const seasonId = spec.phase + 1;
    const row = await minter.methods.rowOf(spec.phase).call();
    const pools = await minter.methods.poolMinted(spec.phase).call();
    const acorn = pools.acorn ?? pools[0];
    const qrl = pools.qrl ?? pools[1];
    let line =
      `  phase ${spec.phase} ${spec.codename.padEnd(18)} season ${seasonId}` +
      `  acorn ${acorn}/${row.acornCap}  qrl ${qrl}/${row.qrlCap}` +
      `  reqPts ${row.reqPts}  mintFee ${row.mintFee}`;
    if (seasonId <= count) {
      const [season, committed, revealed] = Object.values(await lens.methods.seasonView(seasonId).call());
      line +=
        `\n      fusion ${season.fusionMinted}/${season.config.fusionCap}` +
        `  mint ${iso(season.config.opensAt)} .. ${iso(season.config.closesAt)}` +
        `  fusion ${iso(season.config.fusionOpensAt)} .. ${iso(season.config.fusionClosesAt)}` +
        `  seed ${revealed ? 'revealed' : committed ? 'committed' : 'absent'}`;
    } else {
      line += '  (not opened)';
    }
    console.log(line);
  }
}

async function setGenesis(web3, account, deployment, [root, perWallet]) {
  if (!/^0x[0-9a-fA-F]{64}$/.test(String(root))) throw new Error('--genesis needs a 32-byte root, then the per-wallet allowance');
  if (!(Number(perWallet) > 0)) throw new Error('--genesis needs a per-wallet allowance above 0');
  const minterAddress = requireMinter(deployment);
  const minter = contractAt(web3, 'QurrlPhaseMinter', minterAddress);
  await sendRaw(web3, account, {
    to: minterAddress,
    data: minter.methods.setGenesis(root, Number(perWallet)).encodeABI(),
    gas: 200_000,
  });
  console.log(`genesis set: root ${root}, ${perWallet} per wallet (write-once)`);
}

async function commit(web3, account, env, deployment, phase) {
  const spec = PHASES.find((p) => p.phase === Number(phase));
  if (!spec) throw new Error(`phase ${phase} is not in the shipped schedule`);
  const seasonId = spec.phase + 1;
  const seed = seedFor(requireSecret(env), seasonId);
  const commitment = commitmentFor(seasonId, seed);

  const registryAddress = deployment.contracts.QurrlTraitRegistry;
  const registry = contractAt(web3, 'QurrlTraitRegistry', registryAddress);
  const nft = contractAt(web3, 'QurrlNFT', deployment.contracts.QurrlNFT);
  if (await registry.methods.hasCommitment(seasonId).call()) {
    console.log(`season ${seasonId} already has a commitment; leaving it alone`);
    return;
  }

  // The row on chain is what openPhase uses; governance may have amended the duration.
  const minter = contractAt(web3, 'QurrlPhaseMinter', requireMinter(deployment));
  const row = await minter.methods.rowOf(spec.phase).call();
  const now = Math.floor(Date.now() / 1000);
  const lead = Number(flag('lead', 0));
  const revealNotBefore = now + lead + Number(row.mintDuration);

  // openPhase waits for the previous season's last window; a reveal before then strands the season.
  const count = Number(await nft.methods.seasonCount().call());
  if (spec.phase > 0 && count >= spec.phase) {
    const prev = (await nft.methods.seasonView(spec.phase).call()).config;
    const endsAt = Number(prev.fusionCap) ? Number(prev.fusionClosesAt) : Number(prev.closesAt);
    if (revealNotBefore <= endsAt) {
      throw new Error(`season ${spec.phase} runs until ${iso(endsAt)}; a reveal at ${iso(revealNotBefore)} could never open. Raise --lead.`);
    }
    if (revealNotBefore - endsAt < Number(row.mintDuration)) {
      console.log(`warning: the mint window will be cut to ${revealNotBefore - Math.max(now, endsAt)}s by the reveal`);
    }
  }

  await sendRaw(web3, account, {
    to: registryAddress,
    data: registry.methods.commitSeed(seasonId, commitment, revealNotBefore).encodeABI(),
    gas: 150_000,
  });
  console.log(`committed seed for phase ${spec.phase} "${spec.codename}" (season ${seasonId}): ${commitment}`);
  console.log(`   reveal not before ${iso(revealNotBefore)}; open the phase before then (npm run seasons -- --open)`);
}

async function open(web3, account, deployment) {
  const minterAddress = requireMinter(deployment);
  const minter = contractAt(web3, 'QurrlPhaseMinter', minterAddress);
  await sendRaw(web3, account, { to: minterAddress, data: minter.methods.openPhase().encodeABI(), gas: 600_000 });
  const current = await minter.methods.currentPhase().call();
  const phase = Number(current.phase ?? current[1]);
  console.log(`opened phase ${phase} "${PHASES[phase].codename}" as season ${phase + 1}`);
}

async function reveal(web3, account, env, deployment, id) {
  const registryAddress = deployment.contracts.QurrlTraitRegistry;
  const registry = contractAt(web3, 'QurrlTraitRegistry', registryAddress);
  const seed = seedFor(requireSecret(env), Number(id));

  await sendRaw(web3, account, {
    to: registryAddress,
    data: registry.methods.revealSeed(Number(id), seed).encodeABI(),
    gas: 200_000,
  });
  console.log(`revealed season ${id}; effective seed ${await registry.methods.seedOf(Number(id)).call()}`);
}

/** Permissionless once the curator has missed the 14-day window. */
async function defaultReveal(web3, account, deployment, id) {
  const registryAddress = deployment.contracts.QurrlTraitRegistry;
  const registry = contractAt(web3, 'QurrlTraitRegistry', registryAddress);
  await sendRaw(web3, account, {
    to: registryAddress,
    data: registry.methods.revealDefault(Number(id)).encodeABI(),
    gas: 200_000,
  });
  console.log(`season ${id} revealed by default; effective seed ${await registry.methods.seedOf(Number(id)).call()}`);
}

/** STAND-IN ONLY: the real ArkPhase moves by ArkTimelock vote, never from this script. */
async function setStandInPhase(web3, account, deployment, phase) {
  if (!deployment.arkPhaseStandIn) {
    throw new Error('ArkPhase is the real contract (ARK_PHASE_ADDRESS); its phase moves by governance, not from here');
  }
  const address = deployment.contracts.ArkPhase;
  const double = contractAt(web3, 'ArkPhaseDouble', address);
  await sendRaw(web3, account, { to: address, data: double.methods.set(Number(phase)).encodeABI(), gas: 100_000 });
  console.log(`ArkPhaseDouble (stand-in) set to phase ${phase}`);
}

async function main() {
  const { web3, account, env } = connect();
  const deployment = loadDeployment();

  const genesis = flag('genesis', null, 2);
  const toStandIn = flag('set-phase');
  const toCommit = flag('commit');
  const toReveal = flag('reveal');
  const toDefault = flag('default');

  if (genesis) await setGenesis(web3, account, deployment, genesis);
  if (toStandIn !== null) await setStandInPhase(web3, account, deployment, toStandIn);
  if (toCommit !== null) await commit(web3, account, env, deployment, toCommit);
  if (process.argv.includes('--open')) await open(web3, account, deployment);
  if (toReveal) await reveal(web3, account, env, deployment, toReveal);
  if (toDefault) await defaultReveal(web3, account, deployment, toDefault);

  await status(web3, deployment);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
