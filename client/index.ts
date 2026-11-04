/**
 * A dependency-free client for the indexer's GraphQL endpoint: what the SDK's
 * `listOpenAsks()` / `getAgentRecord()` and kudo-client's card grid, job
 * board and agent directory read.
 *
 * Copy this file into a consumer, or import it from this repo. It only needs
 * a global `fetch` (Node 18+, browsers, Next.js).
 */

export type CovenantStatus = "Minted" | "Ongoing" | "Completed" | "Failed";

// Hasura may return BigInt/numeric columns as strings or numbers depending on
// its settings, so they are read as either and normalized here.
type Numeric = string | number;

export type Covenant = {
  id: string;
  contract: string;
  nftId: string;
  isLegacy: boolean;
  agentWallet: string;
  agentId: string | null;
  agentName: string | null;
  owner: string;
  nftType: string;
  ask: string;
  promise: string;
  promiseDetail: string;
  askSettlement: string;
  askSettledAt: string | null;
  askSettledBy: string | null;
  askSettledTx: string | null;
  promiseSettlement: string;
  promiseSettledAt: string | null;
  promiseSettledBy: string | null;
  promiseSettledTx: string | null;
  recordedStatus: CovenantStatus;
  status: CovenantStatus;
  askOpen: boolean;
  mintedAt: string;
  mintedBlock: number;
  mintedTx: string;
};

export type AgentRecord = {
  wallet: string;
  agentId: string | null;
  name: string | null;
  total: number;
  minted: number;
  ongoing: number;
  completed: number;
  failed: number;
  openAsks: number;
  completionRate: number | null;
  firstCovenantAt: string;
  lastCovenantAt: string;
};

export type CovenantEvent = {
  id: string;
  covenant_id: string;
  kind: "Minted" | "AskSettled" | "PromiseSettled" | "StatusSet" | "Transferred";
  value: string;
  agentWallet: string;
  blockNumber: number;
  timestamp: string;
  txHash: string;
  txFrom: string;
};

export type Stats = {
  covenants: number;
  agents: number;
  minted: number;
  ongoing: number;
  completed: number;
  failed: number;
  openAsks: number;
};

const COVENANT_FIELDS = `
  id contract nftId isLegacy agentWallet agentId agentName owner nftType
  ask promise promiseDetail
  askSettlement askSettledAt askSettledBy askSettledTx
  promiseSettlement promiseSettledAt promiseSettledBy promiseSettledTx
  recordedStatus status askOpen mintedAt mintedBlock mintedTx
`;

const AGENT_FIELDS = `
  wallet agentId name total minted ongoing completed failed openAsks
  completionRate firstCovenantAt lastCovenantAt
`;

const NUMERIC_KEYS = new Set([
  "nftId",
  "agentId",
  "askSettledAt",
  "promiseSettledAt",
  "mintedAt",
  "firstCovenantAt",
  "lastCovenantAt",
  "timestamp",
]);

// Float columns Hasura serializes as strings.
const FLOAT_KEYS = new Set(["completionRate"]);

/** BigInt columns as decimal strings and floats as numbers, whichever way Hasura sent them. */
const normalize = <T>(value: unknown): T =>
  JSON.parse(JSON.stringify(value), (key, v: unknown) => {
    if (v === null || v === undefined) return v;
    if (NUMERIC_KEYS.has(key)) return String(v as Numeric);
    if (FLOAT_KEYS.has(key)) return Number(v);
    return v;
  }) as T;

export type KudoIndexerOptions = {
  /** The GraphQL endpoint, e.g. https://indexer.hyperindex.xyz/<id>/v1/graphql. */
  url: string;
  /** Chain to read. Rows are per chain; Robinhood Chain by default. */
  chainId?: number;
  fetch?: typeof fetch;
};

export const createKudoIndexerClient = ({
  url,
  chainId = 4663,
  fetch: fetchImpl = fetch,
}: KudoIndexerOptions) => {
  const query = async <T>(document: string, variables: Record<string, unknown> = {}) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: document, variables }),
    });
    if (!response.ok) throw new Error(`Indexer answered ${response.status}`);
    const { data, errors } = (await response.json()) as {
      data?: T;
      errors?: { message: string }[];
    };
    if (errors?.length) throw new Error(errors.map((e) => e.message).join("; "));
    return normalize<T>(data);
  };

  // Filters are built here rather than passed as nullable variables: how
  // Hasura reads `_eq: null` depends on server settings.
  const listWhere = async (where: Record<string, unknown>, limit: number, offset: number) =>
    (
      await query<{ Covenant: Covenant[] }>(
        `query Covenants($where: Covenant_bool_exp!, $limit: Int!, $offset: Int!) {
          Covenant(where: $where, order_by: { mintedAt: desc }, limit: $limit, offset: $offset) {
            ${COVENANT_FIELDS}
          }
        }`,
        {
          where: { ...where, chainId: { _eq: chainId }, hidden: { _eq: false } },
          limit,
          offset,
        },
      )
    ).Covenant;

  return {
    query,

    /** Covenants whose ask is still waiting to be met, newest first. */
    listOpenAsks: ({ limit = 50, offset = 0, agentWallet }: {
      limit?: number;
      offset?: number;
      agentWallet?: string;
    } = {}) =>
      listWhere(
        {
          askOpen: { _eq: true },
          ...(agentWallet ? { agentWallet: { _eq: agentWallet.toLowerCase() } } : {}),
        },
        limit,
        offset,
      ),

    /** Every visible covenant, newest first: the card grid. */
    listCovenants: ({ limit = 100, offset = 0, status }: {
      limit?: number;
      offset?: number;
      status?: CovenantStatus;
    } = {}) => listWhere(status ? { status: { _eq: status } } : {}, limit, offset),

    /** One covenant by contract and id, with its event history. */
    getCovenant: async (contract: string, nftId: bigint | number | string) => {
      const data = await query<{
        Covenant: (Covenant & { events: CovenantEvent[] })[];
      }>(
        `query Covenant($chainId: Int!, $id: String!) {
          Covenant(where: { chainId: { _eq: $chainId }, id: { _eq: $id } }) {
            ${COVENANT_FIELDS}
            events(order_by: { blockNumber: asc, logIndex: asc }) {
              id covenant_id kind value agentWallet blockNumber timestamp txHash txFrom
            }
          }
        }`,
        { chainId, id: `${contract.toLowerCase()}:${nftId.toString()}` },
      );
      return data.Covenant[0];
    },

    /** Kept vs broken for one agent, by wallet. */
    getAgentRecord: async (wallet: string) =>
      (
        await query<{ Agent: AgentRecord[] }>(
          `query Agent($chainId: Int!, $id: String!) {
            Agent(where: { chainId: { _eq: $chainId }, id: { _eq: $id } }) { ${AGENT_FIELDS} }
          }`,
          { chainId, id: wallet.toLowerCase() },
        )
      ).Agent[0],

    /** Every agent with a visible covenant, busiest first: the directory. */
    listAgents: async ({ limit = 100 }: { limit?: number } = {}) =>
      (
        await query<{ Agent: AgentRecord[] }>(
          `query Agents($chainId: Int!, $limit: Int!) {
            Agent(
              where: { chainId: { _eq: $chainId }, total: { _gt: 0 } }
              order_by: [{ total: desc }, { lastCovenantAt: desc }]
              limit: $limit
            ) { ${AGENT_FIELDS} }
          }`,
          { chainId, limit },
        )
      ).Agent,

    /** The newest covenant events across the chain: the activity feed. */
    listActivity: async ({ limit = 50 }: { limit?: number } = {}) =>
      (
        await query<{ CovenantEvent: CovenantEvent[] }>(
          `query Activity($chainId: Int!, $limit: Int!) {
            CovenantEvent(
              where: { chainId: { _eq: $chainId } }
              order_by: [{ blockNumber: desc }, { logIndex: desc }]
              limit: $limit
            ) { id covenant_id kind value agentWallet blockNumber timestamp txHash txFrom }
          }`,
          { chainId, limit },
        )
      ).CovenantEvent,

    /** Chain-wide totals: the metrics row. */
    getStats: async () =>
      (
        await query<{ Stats: Stats[] }>(
          `query Stats($chainId: Int!) {
            Stats(where: { chainId: { _eq: $chainId }, id: { _eq: "global" } }) {
              covenants agents minted ongoing completed failed openAsks
            }
          }`,
          { chainId },
        )
      ).Stats[0],
  };
};

export type KudoIndexerClient = ReturnType<typeof createKudoIndexerClient>;
