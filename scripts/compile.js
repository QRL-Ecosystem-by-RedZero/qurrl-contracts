/**
 * Compiles contracts/(**)/*.hyp with the Hyperion compiler (@theqrl/hypc) and
 * writes artifacts (abi + bytecode) to build/, ABIs to abi/.
 *
 * Differences from a Solidity/solc setup worth knowing:
 *  - `language` must be "Hyperion"; hypc rejects "Solidity" outright.
 *  - Output lives under `zvm` (Zond Virtual Machine), not `evm`; the QIP-55 line renamed it `qrvm`.
 *  - The version pragma is `pragma hyperion >=0.0.1;`.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * TWO COMPILER LINES (mirrors contracts/core/scripts/compile.js)
 * The npm module is hypc 0.0.2, the v2 line, and is what the local test
 * harness runs. The QRL private testnet is QIP-55 (v3: 64-byte addresses,
 * 512-bit QRVM) and needs the hyperion main compiler: set HYPC_BIN or
 * HYPC_DOCKER_IMAGE (e.g. hypc:local) AND ARK_QRVM=1 (or --qrvm). That build
 * lands in build-qrvm/ and abi-qrvm/, never over build/.
 */
function makeCompiler() {
  const bin = process.env.HYPC_BIN;
  const image = process.env.HYPC_DOCKER_IMAGE;
  const cli = (cmd, args, label) => ({
    label,
    compile(input) {
      const run = spawnSync(cmd, [...args, '--standard-json'], { input, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (run.error) throw run.error;
      if (run.status !== 0) throw new Error(`${label} exited ${run.status}: ${run.stderr}`);
      return run.stdout;
    },
    version() {
      const run = spawnSync(cmd, [...args, '--version'], { encoding: 'utf8' });
      const m = (run.stdout || '').match(/Version:\s*(\S+)/);
      return m ? m[1] : (run.stdout || '').trim().split('\n').pop();
    },
  });
  if (bin) return cli(bin, [], `hypc (${bin})`);
  if (image) return cli('docker', ['run', '--rm', '-i', image], `hypc (docker ${image})`);
  const npm = require('@theqrl/hypc');
  return { label: 'hypc (npm)', compile: (input) => npm.compile(input), version: () => npm.version() };
}

const QRVM = process.env.ARK_QRVM === '1' || process.argv.includes('--qrvm');
if (QRVM && !process.env.HYPC_BIN && !process.env.HYPC_DOCKER_IMAGE) {
  console.error('ARK_QRVM=1 needs HYPC_BIN or HYPC_DOCKER_IMAGE: npm @theqrl/hypc 0.0.2 predates QRVM 512-bit codegen');
  process.exit(1);
}
const hypc = makeCompiler();

/**
 * BUILD PROFILES
 * `--profile devnet` shortens ONE constant, the curator's reveal window
 * (QurrlTraitRegistry.REVEAL_WINDOW, 14 days -> 14 minutes), so a throwaway chain can
 * exercise "the curator missed the window" in minutes instead of weeks. Nothing else
 * changes. The artifacts go to build<-qrvm>-devnet/, never over a spec build, carry
 * `profile: 'devnet'`, and no ABI is written (a profile changes a duration, not an
 * interface). A deployment to anything but a private network must use the spec build.
 */
const profileFlag = process.argv.indexOf('--profile');
const PROFILE = profileFlag === -1 ? 'spec' : process.argv[profileFlag + 1];
if (!['spec', 'devnet'].includes(PROFILE)) {
  console.error(`unknown profile "${PROFILE}"; expected spec or devnet`);
  process.exit(1);
}

const ROOT = path.join(__dirname, '..');
const CONTRACTS = path.join(ROOT, 'contracts');
const SUFFIX = PROFILE === 'spec' ? '' : `-${PROFILE}`;
const OUT = path.join(ROOT, `${QRVM ? 'build-qrvm' : 'build'}${SUFFIX}`);
const ABI_DIR = PROFILE === 'spec' ? path.join(ROOT, QRVM ? 'abi-qrvm' : 'abi') : null;

/** Our own contracts, as opposed to vendored OpenZeppelin. */
const OWN = ['QurrlTraitRegistry', 'QurrlNFT', 'QurrlLens', 'QurrlMetadata', 'QurrlRevenueSplitter', 'QurrlPhaseMinter'];

const EIP170_LIMIT = 24576;

/**
 * Largest creation payload the QRL RPC proxy accepts in one request: the body
 * cap is 50KB and an ML-DSA-87 signature plus public key adds ~7.2KB to every
 * transaction, on top of hex encoding. Anything larger needs a ChunkedDeployer.
 */
const DIRECT_DEPLOY_LIMIT = 18000;

function collectSources(dir, base = '') {
  const sources = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(sources, collectSources(path.join(dir, entry.name), rel));
    else if (entry.name.endsWith('.hyp')) {
      sources[rel] = { content: fs.readFileSync(path.join(dir, entry.name), 'utf8') };
    }
  }
  return sources;
}

function main() {
  const sources = collectSources(CONTRACTS);
  if (PROFILE === 'devnet') {
    const file = 'QurrlTraitRegistry.hyp';
    const from = 'uint64 public constant REVEAL_WINDOW = 14 days;';
    if (sources[file].content.split(from).length !== 2) throw new Error(`${file}: expected exactly one "${from}"`);
    sources[file].content = sources[file].content.replace(from, 'uint64 public constant REVEAL_WINDOW = 14 minutes;');
    console.log('profile devnet: REVEAL_WINDOW is 14 minutes');
  }
  console.log(`hypc ${hypc.version()}`);
  console.log(`compiling ${Object.keys(sources).length} Hyperion sources...\n`);

  const input = {
    language: 'Hyperion',
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      outputSelection: {
        '*': { '*': ['abi', 'zvm.bytecode.object', 'zvm.deployedBytecode.object', 'qrvm.bytecode.object', 'qrvm.deployedBytecode.object'] },
      },
    },
  };

  const output = JSON.parse(hypc.compile(JSON.stringify(input)));

  let fatal = false;
  let warnings = 0;
  for (const err of output.errors || []) {
    if (err.severity === 'error') {
      fatal = true;
      console.error(err.formattedMessage);
    } else if (!/SPDX/.test(err.formattedMessage)) {
      warnings++;
      console.warn('warn:', err.formattedMessage.split('\n')[0]);
    }
  }
  if (fatal) process.exit(1);

  fs.mkdirSync(OUT, { recursive: true });
  if (ABI_DIR) fs.mkdirSync(ABI_DIR, { recursive: true });

  const sizes = {};
  for (const [file, contracts] of Object.entries(output.contracts || {})) {
    for (const [name, c] of Object.entries(contracts)) {
      const vm = c.qrvm || c.zvm;
      const bytecode = vm && vm.bytecode && vm.bytecode.object;
      if (!bytecode) continue; // interface or abstract contract
      fs.writeFileSync(
        path.join(OUT, `${name}.json`),
        JSON.stringify(
          {
            contractName: name,
            sourceName: file,
            compiler: { name: 'hypc', version: hypc.version() },
            profile: PROFILE,
            abi: c.abi,
            bytecode: '0x' + bytecode,
            deployedBytecode: '0x' + vm.deployedBytecode.object,
          },
          null,
          2,
        ),
      );
      if (ABI_DIR) fs.writeFileSync(path.join(ABI_DIR, `${name}.json`), JSON.stringify(c.abi, null, 2));
      sizes[name] = {
        init: bytecode.length / 2,
        runtime: vm.deployedBytecode.object.length / 2,
      };
    }
  }

  console.log('\n%s %s %s', 'contract'.padEnd(22), 'init'.padStart(8), 'runtime'.padStart(8));
  let over = false;
  for (const n of OWN) {
    if (!sizes[n]) {
      console.log('%s %s', n.padEnd(22), '   MISSING');
      over = true;
      continue;
    }
    const flags = [];
    if (sizes[n].runtime > EIP170_LIMIT) flags.push(`EXCEEDS EIP-170 ${EIP170_LIMIT}`);
    if (sizes[n].init > DIRECT_DEPLOY_LIMIT) flags.push('needs chunked deploy');
    if (sizes[n].runtime > EIP170_LIMIT) over = true;
    console.log(
      '%s %s %s%s',
      n.padEnd(22),
      String(sizes[n].init).padStart(8),
      String(sizes[n].runtime).padStart(8),
      flags.length ? '  << ' + flags.join(', ') : '',
    );
  }
  if (over) process.exit(1);

  console.log(`\n${warnings} warning(s). artifacts -> ${path.basename(OUT)}/${ABI_DIR ? `, ABIs -> ${path.basename(ABI_DIR)}/` : ''}`);
}

main();
