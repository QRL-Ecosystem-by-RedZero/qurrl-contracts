# Qurrl

The QRL mascot NFT collection — Hyperion contracts for QRL Zond.

Qurrl is to QRL what Hypurr is to Hyperliquid: a native squirrel identity minted
on the chain it represents. 10,500 lifetime issuance, seasonal drops, and a
fusion mechanic that burns two tokens to lock the trait set of one.

Read [CLAUDE.md](CLAUDE.md) before changing anything. Section 3 is the mint
specification.

## Quick start

```bash
npm install
npm run build      # vendor OpenZeppelin, compile with hypc
npm test           # the suite on the local QRVM harness
npm run gas        # gas profile
```

## Deploying to the private network

Requires a private QRL network (the Kurtosis scripts in `scripts/`) and an
ML-DSA-87 deployer funded at genesis.

```bash
npm run gen:deployer          # writes DEPLOYER_MNEMONIC + SEASON_SEED_SECRET to .env
# point QRL_RPC_URL at the enclave's mapped EL port
npm run deploy
npm run seasons -- --open 1
npm run smoke
```

`SEASON_SEED_SECRET` is not recoverable. A season whose seed is lost can never
be revealed.

## Contracts

| Contract | Purpose |
| --- | --- |
| `QurrlTraitRegistry` | Six-slot trait palette, per-season seed commit–reveal, deterministic trait derivation |
| `QurrlNFT` | ERC721, seasons, primary mint, fusion, supply accounting |
| `QurrlLens` | Stateless read aggregator for the frontend |
| `QurrlPhaseMinter` | Primary issuance per ecosystem phase: the Phase 0 list (three baskets, one wallet one token; `scripts/phase0/select-phase0.js`), the Acorn pool and the QRL pool |
| `QurrlMetadata` | Token metadata |
| `QurrlRevenueSplitter` | Divides mint, fusion and secondary revenue between creator, cushion and treasury; each line is pulled by its own claim |
| `QurrlBudget` | Receives Qurrl's budget from the ecosystem treasury router; pays out only by governance (`payBudget`) |

## Status

Deployed to a private QRL devnet only; no mint has opened. Traits are sealed
until each season's reveal, and no trait names are published.

## License

[MIT](LICENSE)
