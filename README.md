# kudo-indexer

A subgraph for Kudo covenants on Robinhood Chain, deployed on
[Goldsky](https://goldsky.com). It turns the Kudo contracts' events into
covenants, agent records and an event history, and serves them over GraphQL.
kudo-client, the SDK (`listOpenAsks`, `getAgentRecord`, `watchSettlement`),
the job board and the agent directory can all read this one endpoint instead
of calling RPC log reads on every request.

The earlier Envio HyperIndex version of the same indexer is on the `envio`
branch. This one has the same entities, the same rules and the same results.

## What it indexes

| Data source | Address | Status enum |
| --- | --- | --- |
| `Kudo` (current) | `0x1930D0FEaB14b024353bF22adE03Db989aD640C7` | MINTED, ONGOING, COMPLETED, FAILED |
| `KudoLegacy` (covenants 0–9) | `0xc269c6176f3418A84FCdA5911723B0d358971351` | ONGOING, COMPLETED, FAILED |

Both run abi v5 and share one mapping. They number the status `uint8`
differently, and `src/contracts.ts` decodes it for each address. Each data
source starts at its contract's first log. The network is `robinhood-mainnet`.

Events: `CovenantMinted`, `AskSettlementSet`, `PromiseSettlementSet`,
`CovenantPromiseSet` (status) and `Transfer` (ownership and burns).

`CovenantMinted` leaves out the agent's ERC-8004 id, and most mints arrive
through an ERC-4337 smart account, so the id can't be read from the
transaction either. At each mint, the mapping calls `getCovenant(nftId)` and
the Identity Registry's `getMetadata(agentId, "name")`, both at the mint
block.

## Entities

- **Covenant**: one per NFT, keyed `"<contract lowercased>:<nftId>"`, the
  same key as kudo-client's `covenantKey`.
  - `recordedStatus` is what the contract says.
  - `status` is what the UI shows, following the client's `presentedStatus`:
    a covenant with both proofs written reads Completed.
  - `askOpen` means the ask is still waiting to be met.
  - `burned` is set once the NFT goes to the zero address, which Kudo does
    when a covenant settles. `owner` keeps the last holder.
  - `hidden` marks ids on the client's blacklist (legacy 0, 7 and 8). These
    are indexed but left out of every count.
- **Agent**: keyed by wallet (lowercased), like the client's `AgentSummary`.
  It holds counts per status, `openAsks` and `completionRate`, which is
  completed / (completed + failed).
- **CovenantEvent**: every event that touched a covenant, for the activity
  feed and the proof trail.
- **Stats** (`id: "global"`): chain-wide totals for the metrics row.

The counts are updated incrementally by `src/state.ts`. Every covenant write
goes through that file, so the rollups stay in step with the rows they
summarize.

## Build and deploy

```bash
pnpm install
pnpm codegen
pnpm build

npm i -g @goldskycom/cli
goldsky login            # paste your Goldsky API key
pnpm run deploy          # goldsky subgraph deploy kudo-indexer/<package version> --path .
```

To ship a change, bump `version` in `package.json` and deploy again. Then
move the `prod` tag so consumers keep one URL:

```bash
goldsky subgraph tag create kudo-indexer/<version> --tag prod
```

## Reading it

`client/index.ts` is a typed GraphQL client with no dependencies:

```ts
import { createKudoIndexerClient } from "./client";

const kudo = createKudoIndexerClient({
  url: "https://api.goldsky.com/api/public/<project>/subgraphs/kudo-indexer/prod/gn",
});

await kudo.listOpenAsks({ limit: 20 });
await kudo.getAgentRecord("0x06ab15b10f47a6eda0b493202cd23794b7557957");
await kudo.getCovenant("0x1930d0feab14b024353bf22ade03db989ad640c7", 0n); // with event history
await kudo.listAgents();
await kudo.listActivity();
await kudo.getStats();
```

Or query GraphQL directly:

```graphql
{
  covenants(
    where: { askOpen: true, hidden: false }
    orderBy: mintedAt
    orderDirection: desc
  ) {
    id agentName ask promise owner mintedAt
  }
}
```

## Settlement webhooks

A subgraph can't make HTTP calls, so webhooks come from Goldsky instead. It
posts every change to an entity's rows. Point it at `CovenantEvent` (run
`goldsky subgraph webhook list-entities kudo-indexer/<version>` for the exact
entity name):

```bash
goldsky subgraph webhook create kudo-indexer/<version> \
  --name covenant-events \
  --entity covenant_event \
  --url https://kudo.example/api/indexer/webhook \
  --secret "$WEBHOOK_SECRET"
```

Each delivery carries a `goldsky-webhook-secret` header, so check it on
receipt. `kind` on the row is one of `Minted`, `AskSettled`, `PromiseSettled`,
`StatusSet`, `Transferred` and `Burned`.

Deliveries can repeat, so dedupe on the row `id`. A reorg can cause a row to
be sent again or reverted.

## Testing

`graph build` compiles the mapping, and that check runs in CI.

To check against real chain data, run a local Graph Node (Docker: graph-node,
IPFS and Postgres) with an archive RPC for `robinhood-mainnet`, then
`graph create` and `graph deploy` to it. The public RPC
(`rpc.mainnet.chain.robinhood.com`) keeps only about the last 6,000 blocks of
state. It can sync the events, but it can't answer the mint-time contract
calls for older blocks, so local runs against it need those calls stubbed.

With the calls stubbed, a full-history local run produced exactly the same
results as the Envio indexer on the `envio` branch: 123 covenants, 16 agents,
646 events, with no row different.

## Known limits

- `agentName` is the name as of the mint block. A later rename shows up on the
  agent's next covenant.
- `askSettledBy` and `promiseSettledBy` record the transaction sender. For a
  write from a smart account, that is the bundler. kudo-client resolves the
  real actor from the tx (`soleActor`), and `askSettledTx` is there so it can
  keep doing that.
- Contract addresses are copied from kudo-client's
  `src/lib/chain-list-fallback.ts`. A redeploy needs a new data source in
  `subgraph.yaml` and an entry in `src/contracts.ts`.
