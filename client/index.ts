/**
 * A dependency-free client for the subgraph's GraphQL endpoint: what the
 * SDK's `listOpenAsks()` / `getAgentRecord()` and kudo-client's card grid,
 * job board and agent directory read.
 *
 * Copy this file into a consumer, or import it from this repo. It only needs
 * a global `fetch` (Node 18+, browsers, Next.js).
 */

export type CovenantStatus = "Minted" | "Ongoing" | "Completed" | "Failed";

export type CovenantEventKind =
  | "Minted"
  | "AskSettled"
  | "PromiseSettled"
  | "StatusSet"
  | "Transferred"
  | "Burned";

// Subgraphs return BigInt and BigDecimal as strings and Bytes as lowercase
// hex. BigInts are kept as decimal strings here; completionRate is a number.
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
  burned: boolean;
  burnedAt: string | null;
  mintedAt: string;
  mintedBlock: string;
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
  covenantId: string;
  kind: CovenantEventKind;
  value: string;
  agentWallet: string;
  blockNumber: string;
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
  recordedStatus status askOpen burned burnedAt mintedAt mintedBlock mintedTx
`;

const AGENT_FIELDS = `
  wallet agentId name total minted ongoing completed failed openAsks
  completionRate firstCovenantAt lastCovenantAt
`;

const EVENT_FIELDS = `
  id covenant { id } kind value agentWallet blockNumber timestamp txHash txFrom
`;

type RawEvent = Omit<CovenantEvent, "covenantId"> & { covenant: { id: string } };

const toEvent = ({ covenant, ...rest }: RawEvent): CovenantEvent => ({
  ...rest,
  covenantId: covenant.id,
});

type RawAgent = Omit<AgentRecord, "completionRate"> & { completionRate: string | null };

const toAgent = (agent: RawAgent): AgentRecord => ({
  ...agent,
  completionRate: agent.completionRate === null ? null : Number(agent.completionRate),
});

export type KudoIndexerOptions = {
  /**
   * The subgraph's GraphQL endpoint, e.g.
   * https://api.goldsky.com/api/public/<project>/subgraphs/kudo-indexer/<version>/gn
   */
  url: string;
  fetch?: typeof fetch;
};

export const createKudoIndexerClient = ({ url, fetch: fetchImpl = fetch }: KudoIndexerOptions) => {
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
    if (!data) throw new Error("Indexer answered without data");
    return data;
  };

  // Filters are built here rather than passed as nullable variables: a null
  // in a subgraph `where` filter means "equals null", not "no filter".
  const listWhere = async (where: Record<string, unknown>, first: number, skip: number) =>
    (
      await query<{ covenants: Covenant[] }>(
        `query Covenants($where: Covenant_filter!, $first: Int!, $skip: Int!) {
          covenants(where: $where, orderBy: mintedAt, orderDirection: desc, first: $first, skip: $skip) {
            ${COVENANT_FIELDS}
          }
        }`,
        { where: { ...where, hidden: false }, first, skip },
      )
    ).covenants;

  return {
    query,

    /** Covenants whose ask is still waiting to be met, newest first. */
    listOpenAsks: ({ limit = 50, offset = 0, agentWallet }: {
      limit?: number;
      offset?: number;
      agentWallet?: string;
    } = {}) =>
      listWhere(
        { askOpen: true, ...(agentWallet ? { agentWallet: agentWallet.toLowerCase() } : {}) },
        limit,
        offset,
      ),

    /** Every visible covenant, newest first: the card grid. */
    listCovenants: ({ limit = 100, offset = 0, status }: {
      limit?: number;
      offset?: number;
      status?: CovenantStatus;
    } = {}) => listWhere(status ? { status } : {}, limit, offset),

    /** One covenant by contract and id, with its event history. */
    getCovenant: async (contract: string, nftId: bigint | number | string) => {
      const data = await query<{
        covenant: (Covenant & { events: RawEvent[] }) | null;
      }>(
        `query Covenant($id: ID!) {
          covenant(id: $id) {
            ${COVENANT_FIELDS}
            events(orderBy: blockNumber, orderDirection: asc) { ${EVENT_FIELDS} }
          }
        }`,
        { id: `${contract.toLowerCase()}:${nftId.toString()}` },
      );
      return data.covenant && { ...data.covenant, events: data.covenant.events.map(toEvent) };
    },

    /** Kept vs broken for one agent, by wallet. */
    getAgentRecord: async (wallet: string) => {
      const { agent } = await query<{ agent: RawAgent | null }>(
        `query Agent($id: ID!) { agent(id: $id) { ${AGENT_FIELDS} } }`,
        { id: wallet.toLowerCase() },
      );
      return agent && toAgent(agent);
    },

    /** Every agent with a visible covenant, busiest first: the directory. */
    listAgents: async ({ limit = 100 }: { limit?: number } = {}) =>
      (
        await query<{ agents: RawAgent[] }>(
          `query Agents($first: Int!) {
            agents(where: { total_gt: 0 }, orderBy: total, orderDirection: desc, first: $first) {
              ${AGENT_FIELDS}
            }
          }`,
          { first: limit },
        )
      ).agents.map(toAgent),

    /** The newest covenant events across the chain: the activity feed. */
    listActivity: async ({ limit = 50 }: { limit?: number } = {}) =>
      (
        await query<{ covenantEvents: RawEvent[] }>(
          `query Activity($first: Int!) {
            covenantEvents(orderBy: blockNumber, orderDirection: desc, first: $first) {
              ${EVENT_FIELDS}
            }
          }`,
          { first: limit },
        )
      ).covenantEvents.map(toEvent),

    /** Chain-wide totals: the metrics row. */
    getStats: async () =>
      (
        await query<{ stats: Stats | null }>(
          `{ stats(id: "global") { covenants agents minted ongoing completed failed openAsks } }`,
        )
      ).stats,
  };
};

export type KudoIndexerClient = ReturnType<typeof createKudoIndexerClient>;
