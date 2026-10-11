/**
 * Moves every administrative right off the deployer, leaving it the reveal.
 *
 * After this script the deployer holds exactly one role:
 *
 *   QurrlTraitRegistry   CURATOR_ROLE            commit and reveal season seeds
 *
 * QurrlPhaseMinter holds the two it runs the phases with, and nobody else holds
 * SEASON_ADMIN_ROLE (the minter reads the phase from the season count, so a second
 * season admin could desynchronise it):
 *
 *   QurrlNFT             MINTER_ROLE, SEASON_ADMIN_ROLE   -> QurrlPhaseMinter only
 *
 * and GOVERNANCE_ADDRESS (a multisig, or the ArkTimelock) holds the rest:
 *
 *   QurrlNFT             DEFAULT_ADMIN, PAUSER
 *   QurrlTraitRegistry   DEFAULT_ADMIN
 *   QurrlMetadata        DEFAULT_ADMIN
 *
 * QurrlNFT's TREASURER_ROLE already belongs to QurrlRevenueSplitter, so the
 * deployer's own copy is simply renounced. The minter's own governance, owner
 * and Acorn oracle were fixed at deploy (GOVERNANCE_ADDRESS, MINTER_OWNER_ADDRESS,
 * ACORN_ORACLE_ADDRESS) and are only listed here.
 *
 * Do this last. Seal the palette, set the renderer and the royalty, and set the
 * genesis list (`setGenesis`, deployer only) before the handover.
 *
 * Each role is granted first, other season admins are revoked while the deployer
 * is still admin, the deployer renounces last, and the run verifies the result
 * with `hasRole` before reporting success, so a half-finished handover is visible
 * rather than assumed. Role holders cannot be enumerated on chain (no
 * AccessControlEnumerable); the run checks every RoleGranted it can read plus every
 * address this repository knows about.
 *
 * Usage:
 *   npm run handover              print the plan, send nothing
 *   npm run handover -- --execute
 *   npm run handover -- --record <name>   act on deployments/<name>.json instead of the main record
 */
const assert = require('node:assert/strict');
const { keccak256, toUtf8Bytes } = require('ethers');
const { connect, contractAt, sendRaw, loadDeployment } = require('./qrl');

const role = (n) => keccak256(toUtf8Bytes(n));
const ADMIN = '0x' + '00'.repeat(32);
const hash = (r) => (r === 'DEFAULT_ADMIN_ROLE' ? ADMIN : role(r));
const bare = (a) => String(a).replace(/^(0x|Q)/i, '').toLowerCase();
const same = (a, b) => bare(a) === bare(b);

/** Every address that may hold `roleName` on `contract`: logged grants plus known addresses. */
async function candidates(contract, roleName, known) {
  const out = new Map(known.filter(Boolean).map((a) => [bare(a), a]));
  try {
    const events = await contract.getPastEvents('RoleGranted', { fromBlock: 0, toBlock: 'latest' });
    for (const e of events) {
      if (bare(e.returnValues.role) === bare(hash(roleName))) out.set(bare(e.returnValues.account), e.returnValues.account);
    }
  } catch (e) {
    console.log(`   (RoleGranted logs unreadable here, checking known addresses only: ${e.message})`);
  }
  return [...out.values()];
}

async function holders(contract, roleName, known) {
  const out = [];
  for (const a of await candidates(contract, roleName, known)) {
    if (await contract.methods.hasRole(hash(roleName), a).call()) out.push(a);
  }
  return out;
}

async function main() {
  const execute = process.argv.includes('--execute');
  const { web3, account, env } = connect();
  const recordFlag = process.argv.indexOf('--record');
  const deployment = loadDeployment(recordFlag === -1 ? 'private' : process.argv[recordFlag + 1]);
  const governance = env.GOVERNANCE_ADDRESS;

  if (!governance) throw new Error('GOVERNANCE_ADDRESS missing from .env');
  if (same(governance, account.address)) {
    throw new Error('GOVERNANCE_ADDRESS is the deployer; a handover to yourself changes nothing');
  }

  const c = deployment.contracts;
  const minterAddress = c.QurrlPhaseMinter;
  if (!minterAddress) throw new Error('this deployment has no QurrlPhaseMinter; redeploy with: npm run deploy');

  const plan = [
    { name: 'QurrlNFT', address: c.QurrlNFT, grant: ['DEFAULT_ADMIN_ROLE', 'PAUSER_ROLE'], renounce: ['DEFAULT_ADMIN_ROLE', 'SEASON_ADMIN_ROLE', 'PAUSER_ROLE', 'TREASURER_ROLE'] },
    { name: 'QurrlTraitRegistry', address: c.QurrlTraitRegistry, grant: ['DEFAULT_ADMIN_ROLE'], renounce: ['DEFAULT_ADMIN_ROLE'] },
    { name: 'QurrlMetadata', address: c.QurrlMetadata, grant: ['DEFAULT_ADMIN_ROLE'], renounce: ['DEFAULT_ADMIN_ROLE'] },
  ];

  console.log(`network     ${env.QRL_RPC_URL}`);
  console.log(`deployer    ${account.address}`);
  console.log(`governance  ${governance}`);
  console.log(`minter      ${minterAddress}\n`);

  const registry = contractAt(web3, 'QurrlTraitRegistry', c.QurrlTraitRegistry);
  if (!(await registry.methods.paletteFrozen().call())) {
    throw new Error('the palette is not sealed yet; after the handover nobody could seal it');
  }

  const nft = contractAt(web3, 'QurrlNFT', c.QurrlNFT);
  for (const r of ['MINTER_ROLE', 'SEASON_ADMIN_ROLE']) {
    if (!(await nft.methods.hasRole(hash(r), minterAddress).call())) {
      throw new Error(`QurrlPhaseMinter lacks ${r} on QurrlNFT; it could not open a phase`);
    }
  }

  const minter = contractAt(web3, 'QurrlPhaseMinter', minterAddress);
  const [minterGov, minterOwner, oracle, genesisRoot] = await Promise.all([
    minter.methods.governance().call(),
    minter.methods.owner().call(),
    minter.methods.acornOracle().call(),
    minter.methods.genesisRoot().call(),
  ]);
  if (/^0x0+$/.test(genesisRoot)) console.log('WARNING: setGenesis has not run; only this deployer can run it (the handover does not touch it)\n');

  const known = [
    account.address,
    governance,
    minterAddress,
    env.SEASON_ADMIN_ADDRESS,
    env.CURATOR_ADDRESS,
    env.TREASURER_ADDRESS,
    c.QurrlRevenueSplitter,
    ...Object.values(deployment.roles || {}),
  ];
  // Anyone but the minter holding a season or minter role, the deployer excepted (it renounces below).
  const strays = [];
  for (const r of ['SEASON_ADMIN_ROLE', 'MINTER_ROLE']) {
    for (const a of await holders(nft, r, known)) {
      if (!same(a, minterAddress) && !same(a, account.address)) strays.push({ role: r, account: a });
    }
  }

  for (const step of plan) {
    console.log(step.name);
    for (const r of step.grant) console.log(`   grant    ${r.padEnd(20)} -> governance`);
    if (step.name === 'QurrlNFT') for (const s of strays) console.log(`   revoke   ${s.role.padEnd(20)} (${s.account})`);
    for (const r of step.renounce) console.log(`   renounce ${r.padEnd(20)} (deployer)`);
  }
  console.log('\nthe deployer keeps: QurrlTraitRegistry CURATOR_ROLE');
  console.log('the minter keeps:   QurrlNFT MINTER_ROLE, SEASON_ADMIN_ROLE (sole holder)');
  console.log(`QurrlPhaseMinter:   governance ${minterGov}  owner ${minterOwner}  acornOracle ${oracle}`);

  if (!execute) {
    console.log('\nplan only; re-run with --execute');
    return;
  }

  for (const step of plan) {
    const contract = contractAt(web3, step.name, step.address);
    for (const r of step.grant) {
      await sendRaw(web3, account, { to: step.address, data: contract.methods.grantRole(hash(r), governance).encodeABI(), gas: 200_000 });
    }
  }
  for (const s of strays) {
    await sendRaw(web3, account, { to: c.QurrlNFT, data: nft.methods.revokeRole(hash(s.role), s.account).encodeABI(), gas: 200_000 });
  }
  for (const step of plan) {
    const contract = contractAt(web3, step.name, step.address);
    for (const r of step.renounce) {
      if (!(await contract.methods.hasRole(hash(r), account.address).call())) continue;
      await sendRaw(web3, account, { to: step.address, data: contract.methods.renounceRole(hash(r), account.address).encodeABI(), gas: 200_000 });
    }
  }

  for (const step of plan) {
    const contract = contractAt(web3, step.name, step.address);
    for (const r of step.grant) {
      assert.equal(await contract.methods.hasRole(hash(r), governance).call(), true, `${step.name} ${r}: governance missing`);
    }
    for (const r of step.renounce) {
      assert.equal(await contract.methods.hasRole(hash(r), account.address).call(), false, `${step.name} ${r}: deployer still holds it`);
    }
  }
  assert.equal(await registry.methods.hasRole(role('CURATOR_ROLE'), account.address).call(), true, 'the deployer lost the reveal');
  for (const r of ['SEASON_ADMIN_ROLE', 'MINTER_ROLE']) {
    const now = await holders(nft, r, known);
    assert.deepEqual(now.map(bare), [bare(minterAddress)], `QurrlNFT ${r}: held by ${now.join(', ') || 'nobody'}, not the minter alone`);
    console.log(`QurrlNFT ${r.padEnd(18)} ${now.join(', ')}`);
  }

  console.log('\nhandover verified: the deployer holds only CURATOR_ROLE on the registry; the minter is the only season admin');
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
