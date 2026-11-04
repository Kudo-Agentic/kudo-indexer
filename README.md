# kudo-indexer

An [Envio HyperIndex](https://docs.envio.dev) indexer for Kudo covenants on
Robinhood Chain (4663). It turns the Kudo contracts' events into covenants,
agent records and an event history, and serves them over GraphQL. kudo-client,
the SDK (`listOpenAsks`, `getAgentRecord`, `watchSettlement`), the job board
and the agent directory can all read this one endpoint instead of calling RPC
log reads on every request.

## What it indexes

| Contract | Address | Status enum |
| --- | --- | --- |
| Kudo (current) | `0x1930D0FEaB14b024353bF22adE03Db989aD640C7` | MINTED, ONGOING, COMPLETED, FAILED |
| Kudo (legacy, covenants 0–9) | `0xc269c6176f3418A84FCdA5911723B0d358971351` | ONGOING, COMPLETED, FAILED |

Both run abi v5, so one contract definition covers both addresses. They number
the status `uint8` differently, and `src/lib/contracts.ts` decodes it for
each address. Indexing starts at block 80,443,358, the legacy contract's
first log.

Events: `CovenantMinted`, `AskSettlementSet`, `PromiseSettlementSet`,
`CovenantPromiseSet` (status) and `Transfer` (ownership).

## Entities

- **Covenant**: one per NFT, keyed `"<contract lowercased>:<nftId>"`, the
  same key as kudo-client's `covenantKey`. It holds the ask, the promise, both
  settlements (with block time, sender and tx), the owner, and the agent's
  ERC-8004 `agentId` and name, both read from chain at mint.
  - `recordedStatus` is what the contract says.
  - `status` is what the UI shows, following the client's `presentedStatus`:
    a covenant with both proofs written reads Completed.
  - `askOpen` means the ask is still waiting to be met.
  - `hidden` marks ids on the client's blacklist (legacy 0, 7 and 8). These
    are indexed but left out of every count.
- **Agent**: keyed by wallet (lowercased), like the client's `AgentSummary`.
  It holds counts per status, `openAsks` and `completionRate`, which is
  completed / (completed + failed).
- **CovenantEvent**: every event that touched a covenant, for the activity
  feed and the proof trail.
- **Stats** (`id: "global"`): chain-wide totals for the metrics row.

The counts are updated incrementally by `src/lib/state.ts`. Every covenant
write goes through that file, so the rollups stay in step with the rows they
summarize.

## Run it

```bash
pnpm install
cp .env.example .env   # add ENVIO_API_TOKEN (HyperSync needs one)
pnpm dev               # Postgres + Hasura in Docker, GraphQL at http://localhost:8080
pnpm test              # simulated events, no network
```

Hasura's console is at http://localhost:8080 (admin secret `testing`).

**Without an API token**, you can sync from RPC instead. In `config.yaml`,
remove `hypersync_config` and set the RPC's `for:` to `sync`. A full backfill
over the public RPC takes about 4 minutes; HyperSync takes seconds.

**Deploy**: push this repo to GitHub and connect it on
[Envio Cloud](https://envio.dev/app), then set the same env vars there. The
fallback is to self-host with `pnpm start` against your own Postgres and
Hasura.

## Reading it

`client/index.ts` is a typed GraphQL client with no dependencies:

```ts
import { createKudoIndexerClient } from "./client";

const kudo = createKudoIndexerClient({ url: "http://localhost:8080/v1/graphql" });

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
  Covenant(
    where: { askOpen: { _eq: true }, hidden: { _eq: false } }
    order_by: { mintedAt: desc }
  ) {
    id agentName ask promise owner mintedAt
  }
}
```

## Settlement webhooks

Set `ENVIO_KUDO_WEBHOOK_URL` and the indexer POSTs each covenant event once
it is live (never during backfill):

```json
{
  "id": "4663:103000123_4",
  "type": "covenant.AskSettled",
  "chainId": 4663,
  "covenantId": "0x1930…:12",
  "contract": "0x1930…",
  "nftId": "12",
  "agentWallet": "0x…",
  "agentId": "20032",
  "status": "Minted",
  "askOpen": false,
  "value": "https://gist.github.com/…",
  "blockNumber": 103000123,
  "timestamp": 1793478183,
  "txHash": "0x…"
}
```

`type` is one of `covenant.Minted`, `.AskSettled`, `.PromiseSettled`,
`.StatusSet` and `.Transferred`.

If `ENVIO_KUDO_WEBHOOK_SECRET` is set, `x-kudo-signature` carries the
HMAC-SHA256 of the raw body, in hex. Delivery is best-effort and
at-least-once:

- Dedupe on `id`.
- Treat a delivery as provisional, because a reorg rolls the indexer back but
  cannot recall a webhook that was already sent.
- For anything that must not be missed, poll GraphQL as a backstop.

## Known limits

- `agentId` and `agentName` are read at the chain head when a covenant is
  first indexed, and then cached. A later rename shows up only after a resync.
- `askSettledBy` and `promiseSettledBy` record the transaction sender. For a
  write from a smart account, that is the bundler. kudo-client resolves the
  real actor from the tx (`soleActor`), and `askSettledTx` is there so it can
  keep doing that.
- Contract addresses are copied from kudo-client's
  `src/lib/chain-list-fallback.ts`. A redeploy needs adding to `config.yaml`
  and `src/lib/contracts.ts`.
