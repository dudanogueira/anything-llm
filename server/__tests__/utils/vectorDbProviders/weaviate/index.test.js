/* eslint-env jest */
/**
 * Weaviate provider tests, run against an in-memory fake of the parts of the
 * weaviate-client v3 API the provider uses.
 */

function fakeVersion(version) {
  const [major, minor, patch] = version.split(".").map(Number);
  return {
    show: () => version,
    isAtLeast: (ma, mi, pa) =>
      major !== ma ? major > ma : minor !== mi ? minor > mi : patch >= pa,
  };
}

function cosineDistance(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// collections: name -> Map(uuid -> object); shared: name -> Map(tenant -> Map)
function createFakeClient({ version = "1.36.0" } = {}) {
  const collections = new Map();
  const shared = new Map();
  const cap = (name) => name.charAt(0).toUpperCase() + name.slice(1);

  const handle = (name, tenant = null) => {
    const objects = () => {
      if (tenant) {
        const tenants = shared.get(name);
        if (!tenants?.has(tenant)) throw new Error(`no tenant ${tenant}`);
        return tenants.get(tenant);
      }
      if (!collections.has(name)) throw new Error(`no collection ${name}`);
      return collections.get(name);
    };
    const ranked = (vector) =>
      [...objects().entries()].map(([uuid, o]) => ({
        uuid,
        properties: o.properties,
        distance: cosineDistance(vector, o.vector),
      }));
    return {
      exists: jest.fn(async () => collections.has(name) || shared.has(name)),
      aggregate: {
        overAll: jest.fn(async () => ({ totalCount: objects().size })),
      },
      query: {
        nearVector: jest.fn(async (vector, { limit }) => ({
          objects: ranked(vector)
            .sort((a, b) => a.distance - b.distance)
            .slice(0, limit)
            .map(({ distance, ...o }) => ({ ...o, metadata: { distance } })),
        })),
        // Fake fusion: vector similarity, plus a bonus for a keyword match.
        hybrid: jest.fn(async (query, { vector, limit }) => ({
          objects: ranked(vector)
            .map((o) => ({
              ...o,
              score:
                (1 - o.distance) / 100 +
                (String(o.properties.text).includes(query) ? 0.01 : 0),
            }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit)
            .map(({ distance, score, ...o }) => ({
              ...o,
              metadata: { score },
            })),
        })),
      },
      data: {
        insertMany: jest.fn(async (batch) => {
          for (const o of batch)
            objects().set(o.id, {
              vector: o.vectors,
              properties: o.properties,
            });
          return { hasErrors: false, errors: {} };
        }),
        deleteMany: jest.fn(async ({ ids }) => {
          let successful = 0;
          for (const id of ids) if (objects().delete(id)) successful++;
          return { failed: 0, successful };
        }),
      },
      filter: { byId: () => ({ containsAny: (ids) => ({ ids }) }) },
      config: { get: jest.fn(async () => ({ name })) },
      tenants: {
        get: jest.fn(async () =>
          Object.fromEntries(
            [...(shared.get(name)?.keys() ?? [])].map((t) => [t, {}])
          )
        ),
        getByName: jest.fn(async (t) =>
          shared.get(name)?.has(t) ? { name: t } : null
        ),
        create: jest.fn(async (list) => {
          for (const { name: t } of list) {
            if (shared.get(name).has(t))
              throw new Error(`tenant ${t} already exists`);
            shared.get(name).set(t, new Map());
          }
        }),
        remove: jest.fn(async (list) => {
          for (const t of list) shared.get(name).delete(t);
        }),
      },
      withTenant: (t) => handleFor(name, t),
    };
  };
  const handles = new Map();
  const handleFor = (rawName, tenant = null) => {
    const name = cap(rawName);
    const key = `${name}|${tenant ?? ""}`;
    if (!handles.has(key)) handles.set(key, handle(name, tenant));
    return handles.get(key);
  };

  return {
    collectionsStore: collections,
    sharedStore: shared,
    handleFor,
    getWeaviateVersion: jest.fn(async () => fakeVersion(version)),
    isLive: jest.fn(async () => true),
    close: jest.fn(async () => {}),
    collections: {
      listAll: jest.fn(async () => [
        ...[...collections.keys()].map((name) => ({ name })),
        ...[...shared.keys()].map((name) => ({
          name,
          multiTenancy: { enabled: true },
        })),
      ]),
      exists: jest.fn(
        async (name) => collections.has(cap(name)) || shared.has(cap(name))
      ),
      createFromSchema: jest.fn(async (schema) => {
        const name = cap(schema.class);
        if (collections.has(name) || shared.has(name))
          throw new Error(`class ${name} already exists`);
        if (schema.multiTenancyConfig?.enabled) shared.set(name, new Map());
        else collections.set(name, new Map());
      }),
      delete: jest.fn(async (name) => {
        collections.delete(cap(name));
        shared.delete(cap(name));
      }),
      get: jest.fn((name) => handleFor(name)),
    },
  };
}

jest.mock("weaviate-client", () => ({
  connectToCustom: jest.fn(),
  connectToWeaviateCloud: jest.fn(),
  ApiKey: class ApiKey {
    constructor(apiKey) {
      this.apiKey = apiKey;
    }
  },
}));

const mockDocumentVectors = {
  rows: [],
  bulkInsert: jest.fn(async (records = []) => {
    for (const r of records)
      mockDocumentVectors.rows.push({
        id: mockDocumentVectors.rows.length + 1,
        ...r,
      });
  }),
  where: jest.fn(async ({ docId }) =>
    mockDocumentVectors.rows.filter((r) => r.docId === docId)
  ),
  deleteIds: jest.fn(async (ids = []) => {
    mockDocumentVectors.rows = mockDocumentVectors.rows.filter(
      (r) => !ids.includes(r.id)
    );
  }),
};
jest.mock("../../../../models/vectors", () => ({
  DocumentVectors: mockDocumentVectors,
}));
jest.mock("../../../../models/systemSettings", () => ({
  SystemSettings: {
    getValueOrFallback: jest.fn(async ({ label }, fallback = null) =>
      label === "text_splitter_chunk_size"
        ? 40
        : label === "text_splitter_chunk_overlap"
          ? 0
          : fallback
    ),
  },
}));
const mockVectorCache = new Map();
jest.mock("../../../../utils/files", () => ({
  cachedVectorInformation: jest.fn(async (file) =>
    mockVectorCache.has(file)
      ? { exists: true, chunks: mockVectorCache.get(file) }
      : { exists: false, chunks: [] }
  ),
  storeVectorResult: jest.fn(async (chunks, file) => {
    if (file) mockVectorCache.set(file, chunks);
  }),
}));
// Deterministic "embedder": a bag of words hashed into 8 dimensions.
const embed = (text) => {
  const vector = new Array(8).fill(0.001);
  for (const word of String(text).toLowerCase().split(/\W+/).filter(Boolean))
    vector[[...word].reduce((a, c) => a + c.charCodeAt(0), 0) % 8] += 1;
  return vector;
};
const mockEmbedder = {
  embeddingMaxChunkLength: 1000,
  embedChunks: jest.fn(async (chunks) => chunks.map(embed)),
  embedTextInput: jest.fn(async (text) => embed(text)),
};
jest.mock("../../../../utils/helpers", () => ({
  ...jest.requireActual("../../../../utils/helpers"),
  getEmbeddingEngineSelection: () => mockEmbedder,
}));

const weaviate = require("weaviate-client");
const { Weaviate } = require("../../../../utils/vectorDbProviders/weaviate");
const { version: APP_VERSION } = require("../../../../package.json");

const ENV_KEYS = [
  "VECTOR_DB",
  "WEAVIATE_ENDPOINT",
  "WEAVIATE_GRPC_ENDPOINT",
  "WEAVIATE_API_KEY",
  "WEAVIATE_QUANTIZATION",
  "WEAVIATE_MULTI_TENANCY",
  "WEAVIATE_HYBRID_ALPHA",
];
const originalEnv = Object.fromEntries(
  ENV_KEYS.map((k) => [k, process.env[k]])
);
function setEnv(overrides = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(
    process.env,
    { VECTOR_DB: "weaviate", WEAVIATE_ENDPOINT: "http://localhost:8080" },
    overrides
  );
}

let client;
function useClient(options) {
  client = createFakeClient(options);
  weaviate.connectToCustom.mockResolvedValue(client);
  weaviate.connectToWeaviateCloud.mockResolvedValue(client);
  return client;
}

const doc = (overrides = {}) => ({
  docId: "doc-1",
  id: "must-not-be-stored",
  title: "fruits.txt",
  published: "1/1/2026",
  pageContent:
    "Apples are red and crunchy. Bananas are yellow and soft. Cherries are small and sweet.",
  ...overrides,
});
const search = (w, input, extra = {}) =>
  w.performSimilaritySearch({
    namespace: "ws",
    input,
    LLMConnector: mockEmbedder,
    similarityThreshold: 0,
    topN: 10,
    ...extra,
  });

beforeEach(async () => {
  await Weaviate.disconnect();
  jest.clearAllMocks();
  mockDocumentVectors.rows = [];
  mockVectorCache.clear();
  setEnv();
  useClient();
});

afterAll(async () => {
  await Weaviate.disconnect();
  for (const [k, v] of Object.entries(originalEnv))
    v === undefined ? delete process.env[k] : (process.env[k] = v);
});

describe("connection", () => {
  const header = {
    "X-Weaviate-Client-Integration": `anything-llm/${APP_VERSION}`,
  };

  it.each([
    [
      { WEAVIATE_ENDPOINT: "http://localhost:8080" },
      {
        httpHost: "localhost",
        httpPort: 8080,
        httpSecure: false,
        grpcHost: "localhost",
        grpcPort: 50051,
        grpcSecure: false,
      },
    ],
    [
      { WEAVIATE_ENDPOINT: "https://vectors.example.com/weaviate/" },
      {
        httpHost: "vectors.example.com",
        httpPort: 443,
        httpSecure: true,
        httpPath: "/weaviate",
        grpcHost: "vectors.example.com",
        grpcPort: 50051,
        grpcSecure: true,
      },
    ],
    [
      {
        WEAVIATE_ENDPOINT: "http://rest:8080",
        WEAVIATE_GRPC_ENDPOINT: "http://grpc:50052",
      },
      {
        httpHost: "rest",
        httpPort: 8080,
        httpSecure: false,
        grpcHost: "grpc",
        grpcPort: 50052,
        grpcSecure: false,
      },
    ],
    [
      {
        WEAVIATE_ENDPOINT: "http://rest:8080",
        WEAVIATE_GRPC_ENDPOINT: "grpc-host",
      },
      {
        httpHost: "rest",
        httpPort: 8080,
        httpSecure: false,
        grpcHost: "grpc-host",
        grpcPort: 50051,
        grpcSecure: false,
      },
    ],
  ])("custom deployment %p", (env, expected) => {
    setEnv(env);
    expect(new Weaviate().connectionConfig()).toEqual({
      method: "custom",
      options: { headers: header, ...expected },
    });
  });

  it("uses the Weaviate Cloud helper for cloud clusters, with the API key", () => {
    setEnv({
      WEAVIATE_ENDPOINT: "https://abc.c0.europe-west3.gcp.weaviate.cloud",
      WEAVIATE_API_KEY: "key",
    });
    expect(new Weaviate().connectionConfig()).toEqual({
      method: "cloud",
      url: "https://abc.c0.europe-west3.gcp.weaviate.cloud",
      options: {
        headers: header,
        authCredentials: expect.objectContaining({ apiKey: "key" }),
      },
    });
  });

  it.each([
    ["1.28.9", false],
    ["1.29.0", true],
    ["1.39.7", true],
  ])("Weaviate %s supported: %p", async (version, supported) => {
    useClient({ version });
    const connecting = new Weaviate().connect();
    if (supported) await expect(connecting).resolves.toEqual({ client });
    else await expect(connecting).rejects.toThrow("requires Weaviate 1.29.0");
  });

  it("shares one client and rebuilds it when the settings change", async () => {
    const first = client;
    await new Weaviate().connect();
    await new Weaviate().connect();
    expect(weaviate.connectToCustom).toHaveBeenCalledTimes(1);
    useClient();
    process.env.WEAVIATE_API_KEY = "rotated";
    expect((await new Weaviate().connect()).client).toBe(client);
    await new Promise((r) => setImmediate(r));
    expect(first.close).toHaveBeenCalled();
  });
});

describe("documents and search", () => {
  it("stores chunks in a collection created like the legacy client did", async () => {
    const w = new Weaviate();
    expect(await w.addDocumentToNamespace("my ws", doc(), "f.json")).toEqual({
      vectorized: true,
      error: null,
    });
    expect(client.collections.createFromSchema).toHaveBeenCalledWith({
      class: "MyWs",
      description: "Class created by AnythingLLM named MyWs",
      vectorizer: "none",
    });
    const stored = [...client.collectionsStore.get("MyWs").values()];
    expect(stored.length).toBe(mockDocumentVectors.rows.length);
    expect(stored.length).toBeGreaterThan(1);
    expect(stored[0].properties).not.toHaveProperty("id");
  });

  it("inserts each cached chunk exactly once", async () => {
    const cached = Array.from({ length: 1203 }, (_, i) => ({
      vector: [1, i],
      properties: { text: `chunk ${i}` },
    }));
    mockVectorCache.set("big.json", [
      cached.slice(0, 500),
      cached.slice(500, 1000),
      cached.slice(1000),
    ]);
    await new Weaviate().addDocumentToNamespace("ws", doc(), "big.json");
    const inserted = client.collections
      .get("Ws")
      .data.insertMany.mock.calls.flatMap(([batch]) => batch);
    expect(inserted).toHaveLength(1203); // the old code sent 500 + 1000 + 1203
    expect(client.collectionsStore.get("Ws").size).toBe(1203);
  });

  it("vector search applies the threshold and returns the legacy shape", async () => {
    const w = new Weaviate();
    await w.addDocumentToNamespace("ws", doc());
    // Querying with a stored chunk's own text must rank that chunk first.
    const bananas = [...client.collectionsStore.get("Ws").values()].find((o) =>
      o.properties.text.includes("Bananas")
    ).properties.text;
    const all = await search(w, bananas);
    expect(all.contextTexts[0]).toBe(bananas);
    expect(all.sources[0]).toEqual(
      expect.objectContaining({
        title: "fruits.txt",
        id: expect.any(String),
        score: expect.any(Number),
      })
    );
    const scores = all.sources.map((s) => s.score);
    const threshold = (Math.max(...scores) + Math.min(...scores)) / 2;
    const strict = await search(w, bananas, {
      similarityThreshold: threshold,
    });
    expect(strict.sources.length).toBeGreaterThan(0);
    expect(strict.sources.length).toBeLessThan(all.sources.length);
    expect(strict.sources.every((s) => s.score >= threshold)).toBe(true);
    expect(client.collections.get("Ws").query.hybrid).not.toHaveBeenCalled();
  });

  it("deletes a document's vectors in batches", async () => {
    const w = new Weaviate();
    await w.addDocumentToNamespace("ws", doc());
    await mockDocumentVectors.bulkInsert(
      Array.from({ length: 600 }, (_, i) => ({
        docId: "doc-1",
        vectorId: `x-${i}`,
      }))
    );
    await w.deleteDocumentFromNamespace("ws", "doc-1");
    expect(client.collections.get("Ws").data.deleteMany).toHaveBeenCalledTimes(
      2
    );
    expect(client.collectionsStore.get("Ws").size).toBe(0);
    expect(mockDocumentVectors.rows).toEqual([]);
  });
});

describe("vector compression (WEAVIATE_QUANTIZATION)", () => {
  it.each([
    ["rq-8", { rq: { enabled: true, bits: 8 } }],
    ["rq-1", { rq: { enabled: true, bits: 1 } }],
    ["bq", { bq: { enabled: true } }],
    ["sq", { sq: { enabled: true } }],
    ["pq", { pq: { enabled: true } }],
  ])("%s", async (value, vectorIndexConfig) => {
    setEnv({ WEAVIATE_QUANTIZATION: value });
    await new Weaviate().addDocumentToNamespace("ws", doc());
    expect(client.collections.createFromSchema).toHaveBeenCalledWith(
      expect.objectContaining({ vectorIndexConfig })
    );
  });

  it.each([
    ["rq-8", "1.31.0"],
    ["rq-1", "1.32.9"],
  ])("refuses %s on Weaviate %s", async (value, version) => {
    useClient({ version });
    setEnv({ WEAVIATE_QUANTIZATION: value });
    const result = await new Weaviate().addDocumentToNamespace("ws", doc());
    expect(result.error).toMatch(`"${value}" requires Weaviate`);
    expect(client.collections.createFromSchema).not.toHaveBeenCalled();
  });
});

describe("multi-tenancy (WEAVIATE_MULTI_TENANCY)", () => {
  beforeEach(() => setEnv({ WEAVIATE_MULTI_TENANCY: "true" }));
  const tenant = (name) => client.sharedStore.get("AnythingLLM")?.get(name);

  it("stores each workspace as a tenant of one shared collection", async () => {
    setEnv({ WEAVIATE_MULTI_TENANCY: "true", WEAVIATE_QUANTIZATION: "rq-8" });
    const w = new Weaviate();
    await w.addDocumentToNamespace("alpha", doc());
    await w.addDocumentToNamespace("beta", doc({ docId: "b" }));
    expect(client.collections.createFromSchema).toHaveBeenCalledTimes(1);
    expect(client.collections.createFromSchema).toHaveBeenCalledWith(
      expect.objectContaining({
        class: "AnythingLLM",
        multiTenancyConfig: expect.objectContaining({ enabled: true }),
        vectorIndexConfig: { rq: { enabled: true, bits: 8 } },
      })
    );
    expect(client.collectionsStore.size).toBe(0);
    expect(await w.namespaceCount("alpha")).toBe(tenant("alpha").size);
    expect((await w.allNamespaces(client)).sort()).toEqual(["alpha", "beta"]);
    expect(await w.totalVectors()).toBe(
      tenant("alpha").size + tenant("beta").size
    );
  });

  it("tolerates the collection and tenant being created by another process", async () => {
    const w = new Weaviate();
    const { client: c } = await w.connect();
    c.collections.createFromSchema.mockImplementationOnce(async () => {
      c.sharedStore.set("AnythingLLM", new Map([["ws", new Map()]]));
      throw new Error("class AnythingLLM already exists");
    });
    // ensureCollection sees no shared collection yet; the re-check after the
    // failed create then finds the one the other process made.
    c.collections.exists.mockResolvedValueOnce(false);
    expect(await w.addDocumentToNamespace("ws", doc())).toEqual({
      vectorized: true,
      error: null,
    });
    expect(tenant("ws").size).toBeGreaterThan(0);
  });

  it("keeps workspaces isolated", async () => {
    const w = new Weaviate();
    await w.addDocumentToNamespace(
      "ws",
      doc({ pageContent: "zebras everywhere" })
    );
    await w.addDocumentToNamespace(
      "other",
      doc({ docId: "o", pageContent: "volcanoes" })
    );
    expect((await search(w, "zebras")).contextTexts.join(" ")).toMatch(
      /zebras/
    );
    expect(
      (await search(w, "zebras", { namespace: "other" })).contextTexts.join(" ")
    ).not.toMatch(/zebras/);
  });

  it("deletes a workspace's tenant, and reset drops the shared collection", async () => {
    const w = new Weaviate();
    await w.addDocumentToNamespace("alpha", doc());
    await w.addDocumentToNamespace("beta", doc({ docId: "b" }));
    await w["delete-namespace"]({ namespace: "alpha" });
    expect(tenant("alpha")).toBeUndefined();
    expect(tenant("beta").size).toBeGreaterThan(0);
    await w.reset();
    expect(client.sharedStore.has("AnythingLLM")).toBe(false);
  });

  it("uses a stable hashed tenant name for slugs that are not valid tenant names", () => {
    const w = new Weaviate();
    expect(w.tenantName("my-workspace")).toBe("my-workspace");
    expect(w.tenantName("x".repeat(80))).toMatch(/^ws-[0-9a-f]{32}$/);
    expect(w.tenantName("x".repeat(80))).toBe(w.tenantName("x".repeat(80)));
  });

  it("per-collection mode does not count the shared collection as a workspace", async () => {
    const w = new Weaviate();
    await w.addDocumentToNamespace("alpha", doc());
    setEnv();
    await w.addDocumentToNamespace("beta", doc({ docId: "b" }));
    expect(await w.allNamespaces(client)).toEqual(["Beta"]);
  });
});

describe("hybrid search (WEAVIATE_HYBRID_ALPHA)", () => {
  async function seed() {
    const w = new Weaviate();
    await w.addDocumentToNamespace(
      "ws",
      doc({ pageContent: "Order part XJ9000 for the left bracket." })
    );
    await w.addDocumentToNamespace(
      "ws",
      doc({ docId: "d2", pageContent: "Bananas are yellow and soft." })
    );
    return w;
  }

  it("uses the query text, AnythingLLM's vector and the alpha", async () => {
    setEnv({ WEAVIATE_HYBRID_ALPHA: "0.3" });
    const w = await seed();
    const result = await search(w, "XJ9000", {
      similarityThreshold: 0.99,
      topN: 3,
    });
    expect(client.collections.get("Ws").query.hybrid).toHaveBeenCalledWith(
      "XJ9000",
      {
        vector: embed("XJ9000"),
        alpha: 0.3,
        queryProperties: ["text"],
        limit: 3,
        returnMetadata: ["score"],
      }
    );
    expect(result.contextTexts[0]).toMatch(/XJ9000/);
    expect(result.sources[0].score).toBe(1); // scaled so the best match is 1
    expect(result.contextTexts.length).toBeGreaterThan(1); // threshold not applied
  });

  it.each([[undefined], [""], ["1.5"], ["abc"]])(
    "uses vector search when the alpha is %p",
    async (alpha) => {
      setEnv(alpha === undefined ? {} : { WEAVIATE_HYBRID_ALPHA: alpha });
      const w = await seed();
      await search(w, "XJ9000");
      expect(client.collections.get("Ws").query.hybrid).not.toHaveBeenCalled();
      expect(client.collections.get("Ws").query.nearVector).toHaveBeenCalled();
    }
  );

  it("works inside a tenant", async () => {
    setEnv({ WEAVIATE_HYBRID_ALPHA: "0", WEAVIATE_MULTI_TENANCY: "true" });
    const w = await seed();
    expect((await search(w, "XJ9000")).contextTexts[0]).toMatch(/XJ9000/);
  });
});

describe("switching multi-tenancy resets the embeddings", () => {
  const mockReset = jest.fn();
  let updateENV;
  beforeAll(() => {
    jest.isolateModules(() => {
      jest.doMock("../../../../utils/vectorStore/resetAllVectorStores", () => ({
        resetAllVectorStores: (...args) => mockReset(...args),
      }));
      ({ updateENV } = require("../../../../utils/helpers/updateENV"));
    });
  });
  beforeEach(() => mockReset.mockReset());

  it("deletes the workspaces from the layout they were stored in", async () => {
    setEnv({ WEAVIATE_MULTI_TENANCY: "false" });
    let layoutDuringReset;
    mockReset.mockImplementation(async ({ vectorDbKey }) => {
      layoutDuringReset = [vectorDbKey, process.env.WEAVIATE_MULTI_TENANCY];
      return true;
    });
    await updateENV({ WeaviateMultiTenancy: "true" });
    expect(layoutDuringReset).toEqual(["weaviate", "false"]); // previous layout
    expect(process.env.WEAVIATE_MULTI_TENANCY).toBe("true");
  });

  it.each([
    [undefined, "false"],
    ["", "false"],
    ["true", "true"],
  ])(
    "does not reset for %p -> %p (no actual switch)",
    async (before, after) => {
      setEnv(before === undefined ? {} : { WEAVIATE_MULTI_TENANCY: before });
      await updateENV({ WeaviateMultiTenancy: after });
      expect(mockReset).not.toHaveBeenCalled();
    }
  );

  it("does not reset when Weaviate is not the vector database", async () => {
    setEnv({ VECTOR_DB: "lancedb", WEAVIATE_MULTI_TENANCY: "false" });
    await updateENV({ WeaviateMultiTenancy: "true" });
    expect(mockReset).not.toHaveBeenCalled();
  });
});
