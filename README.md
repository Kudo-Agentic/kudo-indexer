# kudo-indexer

A subgraph for Kudo covenants on Robinhood Chain, deployed on
[Goldsky](https://goldsky.com). It turns the Kudo contracts' events into
covenants, agent records and an event history, and serves them over GraphQL.
kudo-client, the SDK (`listOpenAsks`, `getAgentRecord`, `watchSettlement`),
the job board and the agent directory can all read this one endpoint instead
of calling RPC log reads on every request.

It is shaped for the UI. Field names follow kudo-client's `CovenantDetails`
and `Activity` types, and enum values are its own `Status` (`minted`,
`ongoing`, `completed`, `failed`) and `ActivityAction` (`minted`,
`askSettled`, `promiseSettled`, `statusChanged`, `transferred`, `burned`)
strings. `client/index.ts` turns rows into the exact payloads the API routes
already send, so components don't change.

The earlier Envio HyperIndex version is on the `envio` branch. It has the same
rules and the same results, in its own field names.

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
transaction either. At each mint, the mapping calls `getCovenant(nftId)`, then
the Identity Registry's `getMetadata` for `"name"` and `"teeId"`, all at the
mint block.

**Actors.** Agents write through sponsored ERC-4337 bundles, so a
transaction's `from` is the bundler. Every handler reads the transaction
receipt and takes the `sender` of the `UserOperationEvent` that follows the
log, the same rule as kudo-client's `actorOfLog`. `askSettledBy`,
`promiseSettledBy` and each activity's `actor` are the real accounts, so the
UI no longer has to fetch receipts.

## Entities

- **Covenant**: one card. Keyed `"<contract lowercased>:<nftId>"`, the same
  key as kudo-client's `covenantKey`.
  - `status` is what the UI shows. It equals `recordedStatus`, what the
    contract says: only the evaluator sets `completed` or `failed`, so both
    proofs being written does not complete a covenant.
  - `askOpen` means the ask is still waiting to be met (the job board).
  - `agentName` and `teeId` come from the agent's ERC-8004 identity at mint.
    They're null where it recorded none.
  - `burned` is set once the NFT goes to the zero address, which Kudo does
    when a covenant settles. `owner` keeps the last holder.
  - `hidden` marks ids on the client's blacklist (legacy 0, 7 and 8). These
    are indexed, but left out of every count and every list the client
    returns.
- **Activity**: one feed row (kudo-client `Activity`), with everything the row
  shows already on it: `actor` and `actorName`, `agentName`, `nftType`,
  `status` (statusChanged), `detail` (the promise on minted, the promise
  detail on askSettled), `proof` (settlements) and `counterparty` (transfers
  and burns). `order` is `block * 1e6 + logIndex`, so sorting by it keeps
  chain order within a block.
- **Agent**: keyed by wallet (lowercased), like the client's `AgentSummary`.
  It holds counts per status, `openAsks` and `completionRate`, which is
  completed / (completed + failed).
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

`client/index.ts` has no dependencies. It has queries that page past the
subgraph's 1,000-row cap, and adapters to kudo-client's payload types. In
kudo-client, an API route can swap its contract reads for:

```ts
// client/index.ts copied to src/lib/kudo-indexer.ts
import { createKudoIndexerClient, toActivityPayload, toCovenantDetailsPayload } from "@/lib/kudo-indexer";
import { Status } from "@/lib/types/cnft";
import { ActivityAction } from "@/lib/types/activity";

const kudo = createKudoIndexerClient({ url: process.env.KUDO_INDEXER_URL! });

// /api/covenants: CovenantsResponse, unchanged for the components.
const covenants = (await kudo.listCovenants()).map((row) =>
  toCovenantDetailsPayload<Status>(row, {
    stubAgent: (wallet) => STUB_AGENTS_BY_WALLET[wallet],                 // optional
    marketplaceLink: (address, id) => getNftMarketplaceLink(chainId, address, id),
  }),
);

// /api/activities: ActivityPayload rows, newest first.
const activities = (await kudo.listActivity({ limit: 50 })).map(
  toActivityPayload<Status, ActivityAction>,
);
```

The type parameters let the adapters return kudo-client's own `Status` and
`ActivityAction` enums. Their runtime values are the subgraph's.

Other reads:

```ts
await kudo.listOpenAsks();                       // job board
await kudo.listOpenAsks({ agentWallet });        // one agent's open asks
await kudo.getCovenant(contractAddress, nftId);  // one card, with its activities in order
await kudo.getAgentRecord(wallet);               // { counts, openAsks, completionRate, ... }
await kudo.listAgents();                         // directory, busiest first
await kudo.listActivity({ before: lastRow.order, actions: ["askSettled"] }); // next page, filtered
await kudo.getStats();                           // metrics row: { covenants, agents, counts, openAsks }
```

Or query GraphQL directly:

```graphql
{
  covenants(where: { askOpen: true, hidden: false }, orderBy: mintedAt, orderDirection: desc) {
    id nftId agentName ask promise owner mintedAt
  }
}
```

## Settlement webhooks

A subgraph can't make HTTP calls, so webhooks come from Goldsky instead. It
posts every change to an entity's rows. Point it at `Activity`, whose rows are
already in the client's `Activity` shape (run
`goldsky subgraph webhook list-entities kudo-indexer/<version>` for the exact
entity name):

```bash
goldsky subgraph webhook create kudo-indexer/<version> \
  --name covenant-events \
  --entity activity \
  --url https://kudo.example/api/indexer/webhook \
  --secret "$WEBHOOK_SECRET"
```

Each delivery carries a `goldsky-webhook-secret` header, so check it on
receipt. `action` on the row is one of the `ActivityAction` values above.

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
covenants and agents as the Envio indexer on the `envio` branch (123 and 16,
with no row different). All 425 settlement and status actors matched
kudo-client's `actorOfLog`, recomputed from live receipts.

## Known limits

- `agentName` is the name as of the mint block. A later rename shows up on the
  agent's next covenant.
- `actorName` is set when the actor had already minted here by the time of
  the activity. Rows are never rewritten, so an agent that mints its first
  covenant later isn't named on its earlier settlements.
- A bundle log that no `UserOperationEvent` follows gets a null `actor`, as
  in kudo-client. Promise and status rows fall back to the covenant's agent,
  which is the only account that can write them.
- Contract addresses are copied from kudo-client's
  `src/lib/chain-list-fallback.ts`. A redeploy needs a new data source in
  `subgraph.yaml` and an entry in `src/contracts.ts`.
