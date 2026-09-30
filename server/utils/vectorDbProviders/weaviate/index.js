const crypto = require("crypto");
const weaviate = require("weaviate-client");
const { TextSplitter } = require("../../TextSplitter");
const { SystemSettings } = require("../../../models/systemSettings");
const { storeVectorResult, cachedVectorInformation } = require("../../files");
const { v4: uuidv4 } = require("uuid");
const { toChunks, getEmbeddingEngineSelection } = require("../../helpers");
const { camelCase } = require("../../helpers/camelcase");
const { sourceIdentifier } = require("../../chats");
const { VectorDatabase } = require("../base");
const { version: ANYTHINGLLM_VERSION } = require("../../../package.json");

// Oldest Weaviate server we support. From 1.29 every call this provider makes
// (including aggregations) runs over gRPC/REST, with no GraphQL.
const MIN_WEAVIATE_VERSION = { major: 1, minor: 29, patch: 0 };
const DEFAULT_GRPC_PORT = 50051;
// Max objects per insertMany and max ids per deleteMany call.
const BATCH_SIZE = 500;
// Weaviate Cloud clusters derive their gRPC host from the REST host.
const WEAVIATE_CLOUD_DOMAINS = [".weaviate.cloud", ".weaviate.network"];
// WEAVIATE_QUANTIZATION: vector compression for new collections, with the
// oldest server supporting it (older ones ignore or reject the setting).
const QUANTIZATION_OPTIONS = {
  "rq-8": {
    config: { rq: { enabled: true, bits: 8 } },
    minVersion: [1, 32, 0],
  },
  "rq-1": {
    config: { rq: { enabled: true, bits: 1 } },
    minVersion: [1, 33, 0],
  },
  bq: { config: { bq: { enabled: true } }, minVersion: [1, 29, 0] },
  sq: { config: { sq: { enabled: true } }, minVersion: [1, 29, 0] },
  pq: { config: { pq: { enabled: true } }, minVersion: [1, 29, 0] },
};
// WEAVIATE_MULTI_TENANCY: every workspace is a tenant of this collection.
const SHARED_COLLECTION = "AnythingLLM";
const TENANT_NAME = /^[A-Za-z0-9_-]{1,64}$/;

// A gRPC channel is expensive to open, so the client is shared by every
// Weaviate instance in this process and only rebuilt when the settings change.
let cachedConnection = null; // { key: string, promise: Promise<WeaviateClient> }

class Weaviate extends VectorDatabase {
  constructor() {
    super();
  }

  get name() {
    return "Weaviate";
  }

  /**
   * Builds the weaviate-client connection options from the ENV settings.
   * - Weaviate Cloud hosts use `connectToWeaviateCloud`, which derives the gRPC host.
   * - Everything else uses `connectToCustom`. The gRPC endpoint is taken from
   *   WEAVIATE_GRPC_ENDPOINT, or defaults to the REST host on port 50051.
   * @returns {{method: "cloud"|"custom", url?: string, options: object}}
   */
  connectionConfig() {
    const restUrl = new URL(process.env.WEAVIATE_ENDPOINT);
    const grpcEndpoint = process.env.WEAVIATE_GRPC_ENDPOINT?.trim() || null;
    const apiKey = process.env.WEAVIATE_API_KEY?.trim() || null;
    const sharedOptions = {
      headers: {
        "X-Weaviate-Client-Integration": `anything-llm/${ANYTHINGLLM_VERSION}`,
      },
      ...(apiKey ? { authCredentials: new weaviate.ApiKey(apiKey) } : {}),
    };

    const isWeaviateCloud = WEAVIATE_CLOUD_DOMAINS.some((domain) =>
      restUrl.hostname.endsWith(domain)
    );
    if (isWeaviateCloud && !grpcEndpoint) {
      return {
        method: "cloud",
        url: restUrl.origin,
        options: sharedOptions,
      };
    }

    const httpSecure = restUrl.protocol === "https:";
    const grpcUrl = grpcEndpoint
      ? new URL(
          /^[a-z]+:\/\//i.test(grpcEndpoint)
            ? grpcEndpoint
            : `${httpSecure ? "https" : "http"}://${grpcEndpoint}`
        )
      : null;
    const grpcSecure = grpcUrl ? grpcUrl.protocol === "https:" : httpSecure;
    const httpPath = restUrl.pathname.replace(/\/+$/, "");

    return {
      method: "custom",
      options: {
        ...sharedOptions,
        httpHost: restUrl.hostname,
        httpPort: Number(restUrl.port) || (httpSecure ? 443 : 80),
        httpSecure,
        ...(httpPath ? { httpPath } : {}),
        grpcHost: grpcUrl?.hostname || restUrl.hostname,
        grpcPort: grpcUrl
          ? Number(grpcUrl.port) || (grpcSecure ? 443 : DEFAULT_GRPC_PORT)
          : DEFAULT_GRPC_PORT,
        grpcSecure,
      },
    };
  }

  /**
   * Opens a client and rejects servers older than MIN_WEAVIATE_VERSION.
   * @returns {Promise<import("weaviate-client").WeaviateClient>}
   */
  async createClient() {
    const { method, url, options } = this.connectionConfig();
    let client;
    try {
      client =
        method === "cloud"
          ? await weaviate.connectToWeaviateCloud(url, options)
          : await weaviate.connectToCustom(options);
    } catch (e) {
      throw new Error(
        `Weaviate::Could not connect - is the service online and are the REST and gRPC endpoints reachable? ${e.message}`
      );
    }

    const version = await client.getWeaviateVersion();
    const { major, minor, patch } = MIN_WEAVIATE_VERSION;
    if (!version.isAtLeast(major, minor, patch)) {
      await client.close();
      throw new Error(
        `Weaviate::Server version ${version.show()} is not supported. AnythingLLM requires Weaviate ${major}.${minor}.${patch} or later - please upgrade your Weaviate instance.`
      );
    }
    return client;
  }

  async connect() {
    if (process.env.VECTOR_DB !== "weaviate")
      throw new Error("Weaviate::Invalid ENV settings");

    const key = [
      process.env.WEAVIATE_ENDPOINT,
      process.env.WEAVIATE_GRPC_ENDPOINT,
      process.env.WEAVIATE_API_KEY,
    ].join("|");

    if (cachedConnection?.key !== key) {
      const previous = cachedConnection;
      const promise = this.createClient();
      cachedConnection = { key, promise };
      // Forget a failed connection so the next call retries.
      promise.catch(() => {
        if (cachedConnection?.promise === promise) cachedConnection = null;
      });
      previous?.promise.then((client) => client.close()).catch(() => {});
    }

    return { client: await cachedConnection.promise };
  }

  /**
   * Closes the shared client, if any. Settings changes are handled by
   * `connect()` itself; this is for tests and explicit shutdowns.
   */
  static async disconnect() {
    const previous = cachedConnection;
    cachedConnection = null;
    await previous?.promise.then((client) => client.close()).catch(() => {});
  }

  /**
   * Converts a cosine distance ([0, 2]: 0 identical, 1 orthogonal, 2 opposite)
   * to a similarity score in [0, 1]. Distances at or past orthogonal floor at 0
   * so unrelated chunks can never clear a similarity threshold.
   * Weaviate's own `certainty` is 1 - distance / 2, which puts an orthogonal
   * chunk at 0.5, so it is not comparable with the other providers' scores.
   * @see https://docs.weaviate.io/weaviate/config-refs/distances
   * @param {number|null} distance - Cosine distance from the vector search.
   * @returns {number} Similarity score in [0, 1].
   */
  distanceToSimilarity(distance = null) {
    if (distance === null || typeof distance !== "number") return 0.0;
    if (distance >= 1.0) return 0;
    if (distance < 0) return 1 - Math.abs(distance);
    return 1 - distance;
  }

  async heartbeat() {
    const { client } = await this.connect();
    if (!(await client.isLive()))
      throw new Error(
        "Weaviate::Invalid Alive signal received - is the service online?"
      );
    return { heartbeat: Number(new Date()) };
  }

  async totalVectors() {
    const { client } = await this.connect();
    const collectionNames = await this.allNamespaces(client);
    var totalVectors = 0;
    for (const name of collectionNames) {
      totalVectors += await this.namespaceCountWithClient(client, name);
    }
    return totalVectors;
  }

  async namespaceCountWithClient(client, namespace) {
    try {
      const { totalCount } = await this.collectionFor(
        client,
        namespace
      ).aggregate.overAll();
      return totalCount || 0;
    } catch (e) {
      this.logger(`namespaceCountWithClient`, e.message);
      return 0;
    }
  }

  async namespaceCount(namespace = null) {
    try {
      const { client } = await this.connect();
      return await this.namespaceCountWithClient(client, namespace);
    } catch (e) {
      this.logger(`namespaceCount`, e.message);
      return 0;
    }
  }

  async similarityResponse({
    client,
    namespace,
    queryVector,
    query = null,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
  }) {
    const result = {
      contextTexts: [],
      sourceDocuments: [],
      scores: [],
    };

    const collection = this.collectionFor(client, namespace);
    const alpha = this.hybridAlpha();
    const hybrid = alpha !== null && !!query?.trim();
    const { objects = [] } = hybrid
      ? await collection.query.hybrid(query, {
          vector: queryVector,
          alpha,
          queryProperties: ["text"],
          limit: topN,
          returnMetadata: ["score"],
        })
      : await collection.query.nearVector(queryVector, {
          limit: topN,
          returnMetadata: ["distance"],
        });

    // Hybrid scores are relative to the result set, so they are scaled to
    // best = 1 and the similarity threshold is not applied: it would drop
    // exact keyword matches, which is what hybrid search is for.
    const bestScore = Math.max(
      0,
      ...objects.map((o) => o.metadata?.score ?? 0)
    );
    objects.forEach(({ uuid: id, properties = {}, metadata = {} }) => {
      const score = hybrid
        ? bestScore > 0
          ? (metadata?.score ?? 0) / bestScore
          : 0
        : this.distanceToSimilarity(metadata?.distance);
      if (!hybrid && score < similarityThreshold) return;
      if (filterIdentifiers.includes(sourceIdentifier(properties))) {
        this.logger(
          "A source was filtered from context as it's parent document is pinned."
        );
        return;
      }
      result.contextTexts.push(properties.text);
      result.sourceDocuments.push({ ...properties, id, score });
      result.scores.push(score);
    });

    return result;
  }

  async allNamespaces(client) {
    try {
      if (this.isMultiTenant()) {
        const shared = client.collections.get(SHARED_COLLECTION);
        if (!(await shared.exists())) return [];
        return Object.keys(await shared.tenants.get());
      }
      // The shared collection of multi-tenant mode is not a workspace.
      const collections = await client.collections.listAll();
      return (collections ?? [])
        .filter((collection) => !collection.multiTenancy?.enabled)
        .map((collection) => collection.name);
    } catch (e) {
      this.logger("AllNamespace", e);
      return [];
    }
  }

  async namespace(client, namespace = null) {
    if (!namespace) throw new Error("No namespace value provided.");
    if (!(await this.namespaceExists(client, namespace))) return null;

    const config = await client.collections
      .get(this.isMultiTenant() ? SHARED_COLLECTION : camelCase(namespace))
      .config.get();

    return {
      ...config,
      vectorCount: await this.namespaceCountWithClient(client, namespace),
    };
  }

  /**
   * Creates the collection for a namespace if it does not exist yet. Uses the
   * same raw schema as the legacy client did, so collections created before
   * and after the v3 client migration are identical.
   */
  async ensureCollection(client, namespace) {
    if (await this.namespaceExists(client, namespace)) return;
    const vectorIndexConfig = await this.quantizationConfig(client);
    if (!this.isMultiTenant()) {
      await client.collections.createFromSchema({
        class: camelCase(namespace),
        description: `Class created by AnythingLLM named ${camelCase(namespace)}`,
        vectorizer: "none",
        ...(vectorIndexConfig ? { vectorIndexConfig } : {}),
      });
      return;
    }

    // Another process (e.g. an embedding worker) may create the shared
    // collection or the tenant at the same time; that is fine.
    if (!(await client.collections.exists(SHARED_COLLECTION))) {
      try {
        await client.collections.createFromSchema({
          class: SHARED_COLLECTION,
          description:
            "Collection created by AnythingLLM. Each tenant is a workspace.",
          vectorizer: "none",
          multiTenancyConfig: {
            enabled: true,
            autoTenantCreation: true,
            autoTenantActivation: true,
          },
          ...(vectorIndexConfig ? { vectorIndexConfig } : {}),
        });
      } catch (e) {
        if (!(await client.collections.exists(SHARED_COLLECTION))) throw e;
      }
    }
    const shared = client.collections.get(SHARED_COLLECTION);
    const tenant = this.tenantName(namespace);
    try {
      await shared.tenants.create([{ name: tenant }]);
    } catch (e) {
      if (!(await shared.tenants.getByName(tenant))) throw e;
    }
  }

  /**
   * Whether workspaces are tenants of one shared collection
   * (WEAVIATE_MULTI_TENANCY) instead of one collection each.
   */
  isMultiTenant() {
    return process.env.WEAVIATE_MULTI_TENANCY?.trim().toLowerCase() === "true";
  }

  /**
   * The tenant for a workspace slug. Slugs that are not valid tenant names
   * (too long, other characters) get a stable hashed name.
   */
  tenantName(namespace) {
    if (TENANT_NAME.test(namespace)) return namespace;
    const hash = crypto.createHash("sha256").update(namespace).digest("hex");
    return `ws-${hash.slice(0, 32)}`;
  }

  /** The workspace's own collection, or its tenant of the shared collection. */
  collectionFor(client, namespace) {
    if (!this.isMultiTenant())
      return client.collections.get(camelCase(namespace));
    return client.collections
      .get(SHARED_COLLECTION)
      .withTenant(this.tenantName(namespace));
  }

  /**
   * The vectorIndexConfig for WEAVIATE_QUANTIZATION, or null to use the
   * server default.
   * @throws if the value is unknown or the server is too old for it
   */
  async quantizationConfig(client) {
    const value = process.env.WEAVIATE_QUANTIZATION?.trim().toLowerCase();
    if (!value) return null;
    const option = QUANTIZATION_OPTIONS[value];
    if (!option)
      throw new Error(`Weaviate::Invalid WEAVIATE_QUANTIZATION "${value}".`);
    const version = await client.getWeaviateVersion();
    if (!version.isAtLeast(...option.minVersion))
      throw new Error(
        `Weaviate::Vector compression "${value}" requires Weaviate ${option.minVersion.join(".")} or later (server is ${version.show()}).`
      );
    return option.config;
  }

  /**
   * WEAVIATE_HYBRID_ALPHA: when set (0 = keyword only, 1 = vector only),
   * searches combine BM25 on the chunk text with vector search. Unset or
   * invalid means vector search only.
   * @returns {number|null}
   */
  hybridAlpha() {
    const raw = process.env.WEAVIATE_HYBRID_ALPHA?.trim();
    if (!raw) return null;
    const alpha = Number(raw);
    return Number.isFinite(alpha) && alpha >= 0 && alpha <= 1 ? alpha : null;
  }

  /**
   * Inserts vector records in batches of BATCH_SIZE.
   * @param {object} client - weaviate-client instance
   * @param {{id: string, vector: number[], properties: object}[]} vectors
   * @param {string} namespace
   * @returns {Promise<{success: boolean, errors: (string|null)[]}>}
   */
  async addVectors(client, vectors = [], namespace) {
    const response = { success: true, errors: new Set([]) };
    const collection = this.collectionFor(client, namespace);
    for (const batch of toChunks(vectors, BATCH_SIZE)) {
      const result = await collection.data.insertMany(
        batch.map(({ id, vector, properties }) => ({
          id,
          properties,
          vectors: vector,
        }))
      );
      if (!result.hasErrors) continue;
      response.success = false;
      for (const error of Object.values(result.errors))
        response.errors.add(error?.message || null);
    }

    response.errors = [...response.errors];
    return response;
  }

  async hasNamespace(namespace = null) {
    if (!namespace) return false;
    const { client } = await this.connect();
    return await this.namespaceExists(client, namespace);
  }

  async namespaceExists(client, namespace = null) {
    if (!namespace) throw new Error("No namespace value provided.");
    if (!this.isMultiTenant())
      return await client.collections.exists(camelCase(namespace));
    const shared = client.collections.get(SHARED_COLLECTION);
    if (!(await shared.exists())) return false;
    return (
      (await shared.tenants.getByName(this.tenantName(namespace))) !== null
    );
  }

  async deleteVectorsInNamespace(client, namespace = null) {
    if (!this.isMultiTenant()) {
      await client.collections.delete(camelCase(namespace));
      return true;
    }
    if (await client.collections.exists(SHARED_COLLECTION))
      await client.collections
        .get(SHARED_COLLECTION)
        .tenants.remove([this.tenantName(namespace)]);
    return true;
  }

  async addDocumentToNamespace(
    namespace,
    documentData = {},
    fullFilePath = null,
    skipCache = false
  ) {
    const { DocumentVectors } = require("../../../models/vectors");
    try {
      const {
        pageContent,
        docId,
        id: _id, // Weaviate will abort if `id` is present in properties
        ...metadata
      } = documentData;
      if (!pageContent || pageContent.length == 0) return false;

      this.logger("Adding new vectorized document into namespace", namespace);
      if (!skipCache) {
        const cacheResult = await cachedVectorInformation(fullFilePath);
        if (cacheResult.exists) {
          const { client } = await this.connect();
          await this.ensureCollection(client, namespace);

          const { chunks } = cacheResult;
          const documentVectors = [];

          for (const chunk of chunks) {
            // Before sending to Weaviate and saving the records to our db
            // we need to assign the id of each chunk that is stored in the cached file.
            const vectors = chunk.map((chunk) => {
              const id = uuidv4();
              const flattenedMetadata = this.flattenObjectForWeaviate(
                chunk.properties ?? chunk.metadata
              );
              documentVectors.push({ docId, vectorId: id });
              return {
                id,
                class: camelCase(namespace),
                vector: chunk.vector || chunk.values || [],
                properties: { ...flattenedMetadata },
              };
            });

            const { success: additionResult, errors = [] } =
              await this.addVectors(client, vectors, namespace);
            if (!additionResult) {
              this.logger("addVectors failed to insert", errors);
              throw new Error("Error embedding into Weaviate");
            }
          }

          await DocumentVectors.bulkInsert(documentVectors);
          return { vectorized: true, error: null };
        }
      }

      // If we are here then we are going to embed and store a novel document.
      // We have to do this manually as opposed to using LangChains `Chroma.fromDocuments`
      // because we then cannot atomically control our namespace to granularly find/remove documents
      // from vectordb.
      const EmbedderEngine = getEmbeddingEngineSelection();
      const textSplitter = new TextSplitter({
        chunkSize: TextSplitter.determineMaxChunkSize(
          await SystemSettings.getValueOrFallback({
            label: "text_splitter_chunk_size",
          }),
          EmbedderEngine?.embeddingMaxChunkLength
        ),
        chunkOverlap: await SystemSettings.getValueOrFallback(
          { label: "text_splitter_chunk_overlap" },
          20
        ),
        chunkHeaderMeta: TextSplitter.buildHeaderMeta(metadata),
        chunkPrefix: EmbedderEngine?.embeddingPrefix,
      });
      const textChunks = await textSplitter.splitText(pageContent);

      this.logger("Snippets created from document:", textChunks.length);
      const documentVectors = [];
      const vectors = [];
      const vectorValues = await EmbedderEngine.embedChunks(textChunks);

      if (!!vectorValues && vectorValues.length > 0) {
        for (const [i, vector] of vectorValues.entries()) {
          const flattenedMetadata = this.flattenObjectForWeaviate(metadata);
          const vectorRecord = {
            class: camelCase(namespace),
            id: uuidv4(),
            vector: vector,
            // [DO NOT REMOVE]
            // LangChain will be unable to find your text if you embed manually and dont include the `text` key.
            // https://github.com/hwchase17/langchainjs/blob/5485c4af50c063e257ad54f4393fa79e0aff6462/langchain/src/vectorstores/weaviate.ts#L133
            properties: { ...flattenedMetadata, text: textChunks[i] },
          };

          vectors.push(vectorRecord);
          documentVectors.push({ docId, vectorId: vectorRecord.id });
        }
      } else {
        throw new Error(
          "Could not embed document chunks! This document will not be recorded."
        );
      }

      const { client } = await this.connect();
      await this.ensureCollection(client, namespace);

      if (vectors.length > 0) {
        const chunks = toChunks(vectors, BATCH_SIZE);

        this.logger("Inserting vectorized chunks into Weaviate collection.");
        const { success: additionResult, errors = [] } = await this.addVectors(
          client,
          vectors,
          namespace
        );
        if (!additionResult) {
          this.logger("addVectors failed to insert", errors);
          throw new Error("Error embedding into Weaviate");
        }
        await storeVectorResult(chunks, fullFilePath);
      }

      await DocumentVectors.bulkInsert(documentVectors);
      return { vectorized: true, error: null };
    } catch (e) {
      this.logger("addDocumentToNamespace", e.message);
      return { vectorized: false, error: e.message };
    }
  }

  async deleteDocumentFromNamespace(namespace, docId) {
    const { DocumentVectors } = require("../../../models/vectors");
    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace))) return;

    const knownDocuments = await DocumentVectors.where({ docId });
    if (knownDocuments.length === 0) return;

    const collection = this.collectionFor(client, namespace);
    const vectorIds = knownDocuments.map((doc) => doc.vectorId);
    for (const ids of toChunks(vectorIds, BATCH_SIZE)) {
      const { failed = 0 } = await collection.data.deleteMany(
        collection.filter.byId().containsAny(ids)
      );
      if (failed > 0)
        throw new Error(
          `Weaviate::Failed to delete ${failed} vectors of document ${docId}`
        );
    }

    const indexes = knownDocuments.map((doc) => doc.id);
    await DocumentVectors.deleteIds(indexes);
    return true;
  }

  async performSimilaritySearch({
    namespace = null,
    input = "",
    LLMConnector = null,
    similarityThreshold = 0.25,
    topN = 4,
    filterIdentifiers = [],
  }) {
    if (!namespace || !input || !LLMConnector)
      throw new Error("Invalid request to performSimilaritySearch.");

    const { client } = await this.connect();
    if (!(await this.namespaceExists(client, namespace))) {
      return {
        contextTexts: [],
        sources: [],
        message: "Invalid query - no documents found for workspace!",
      };
    }

    const queryVector = await LLMConnector.embedTextInput(input);
    const { contextTexts, sourceDocuments } = await this.similarityResponse({
      client,
      namespace,
      queryVector,
      query: input,
      similarityThreshold,
      topN,
      filterIdentifiers,
    });

    const sources = sourceDocuments.map((metadata, i) => {
      return { ...metadata, text: contextTexts[i] };
    });
    return {
      contextTexts,
      sources: this.curateSources(sources),
      message: false,
    };
  }

  async "namespace-stats"(reqBody = {}) {
    const { namespace = null } = reqBody;
    if (!namespace) throw new Error("namespace required");
    const { client } = await this.connect();
    const stats = await this.namespace(client, namespace);
    return stats
      ? stats
      : { message: "No stats were able to be fetched from DB for namespace" };
  }

  async "delete-namespace"(reqBody = {}) {
    const { namespace = null } = reqBody;
    const { client } = await this.connect();
    const details = await this.namespace(client, namespace);
    await this.deleteVectorsInNamespace(client, namespace);
    return {
      message: `Namespace ${camelCase(namespace)} was deleted along with ${
        details?.vectorCount
      } vectors.`,
    };
  }

  async reset() {
    const { client } = await this.connect();
    if (this.isMultiTenant()) {
      if (await client.collections.exists(SHARED_COLLECTION))
        await client.collections.delete(SHARED_COLLECTION);
      return { reset: true };
    }
    for (const name of await this.allNamespaces(client))
      await client.collections.delete(name);
    return { reset: true };
  }

  curateSources(sources = []) {
    const documents = [];
    for (const source of sources) {
      if (Object.keys(source).length > 0) {
        const metadata = source.hasOwnProperty("metadata")
          ? source.metadata
          : source;
        documents.push({ ...metadata });
      }
    }

    return documents;
  }

  flattenObjectForWeaviate(obj = {}) {
    // Note this function is not generic, it is designed specifically for Weaviate
    // https://weaviate.io/developers/weaviate/config-refs/datatypes#introduction
    // Credit to LangchainJS
    // https://github.com/hwchase17/langchainjs/blob/5485c4af50c063e257ad54f4393fa79e0aff6462/langchain/src/vectorstores/weaviate.ts#L11C1-L50C3
    const flattenedObject = {};

    for (const key in obj) {
      if (!Object.hasOwn(obj, key) || key === "id") {
        continue;
      }
      const value = obj[key];
      if (typeof obj[key] === "object" && !Array.isArray(value)) {
        const recursiveResult = this.flattenObjectForWeaviate(value);

        for (const deepKey in recursiveResult) {
          if (Object.hasOwn(obj, key)) {
            flattenedObject[`${key}_${deepKey}`] = recursiveResult[deepKey];
          }
        }
      } else if (Array.isArray(value)) {
        if (
          value.length > 0 &&
          typeof value[0] !== "object" &&
          value.every((el) => typeof el === typeof value[0])
        ) {
          // Weaviate only supports arrays of primitive types,
          // where all elements are of the same type
          flattenedObject[key] = value;
        }
      } else {
        flattenedObject[key] = value;
      }
    }

    return flattenedObject;
  }
}

module.exports.Weaviate = Weaviate;
