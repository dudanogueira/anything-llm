const INPUT_CLASS =
  "border-none bg-theme-settings-input-bg text-white placeholder:text-theme-settings-input-placeholder text-sm rounded-lg focus:outline-primary-button active:outline-primary-button outline-none block w-full p-2.5";
const SELECT_CLASS =
  "border-none bg-theme-settings-input-bg border-gray-500 text-white text-sm rounded-lg block w-full p-2.5";

function DocLink({ href, children }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline text-white"
    >
      {children}
    </a>
  );
}

export default function WeaviateDBOptions({ settings }) {
  return (
    <div className="w-full flex flex-col gap-y-7">
      <div className="w-full flex items-center gap-[36px] mt-1.5">
        <div className="flex flex-col w-60">
          <label className="text-white text-sm font-semibold block mb-3">
            Weaviate Endpoint
          </label>
          <input
            type="url"
            name="WeaviateEndpoint"
            className={INPUT_CLASS}
            placeholder="http://localhost:8080"
            defaultValue={settings?.WeaviateEndpoint}
            required={true}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="flex flex-col w-60">
          <label className="text-white text-sm font-semibold block mb-3">
            API Key
          </label>
          <input
            type="password"
            name="WeaviateApiKey"
            className={INPUT_CLASS}
            placeholder="sk-123Abcweaviate"
            defaultValue={settings?.WeaviateApiKey ? "*".repeat(20) : ""}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        <div className="flex flex-col w-60">
          <label className="text-white text-sm font-semibold block mb-3">
            gRPC Endpoint (optional)
          </label>
          <input
            type="url"
            name="WeaviateGrpcEndpoint"
            className={INPUT_CLASS}
            placeholder="http://localhost:50051"
            defaultValue={settings?.WeaviateGrpcEndpoint}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
      </div>

      <div className="w-full flex items-start gap-[36px]">
        <div className="flex flex-col w-60">
          <label className="text-white text-sm font-semibold block mb-3">
            Vector compression
          </label>
          <select
            name="WeaviateQuantization"
            defaultValue={settings?.WeaviateQuantization || ""}
            className={SELECT_CLASS}
          >
            <option value="">Server default</option>
            <option value="rq-8">RQ 8-bit (Weaviate 1.32+)</option>
            <option value="rq-1">RQ 1-bit (Weaviate 1.33+)</option>
            <option value="bq">Binary (BQ)</option>
            <option value="sq">Scalar (SQ)</option>
            <option value="pq">Product (PQ)</option>
          </select>
          <p className="text-theme-text-secondary text-xs mt-2">
            Applies to new collections.{" "}
            <DocLink href="https://docs.weaviate.io/weaviate/concepts/vector-quantization">
              Learn more
            </DocLink>
          </p>
        </div>

        <div className="flex flex-col w-60">
          <label className="text-white text-sm font-semibold block mb-3">
            Workspace storage
          </label>
          <select
            name="WeaviateMultiTenancy"
            defaultValue={
              settings?.WeaviateMultiTenancy === "true" ? "true" : "false"
            }
            className={SELECT_CLASS}
          >
            <option value="false">One collection per workspace</option>
            <option value="true">Multi-tenant (one shared collection)</option>
          </select>
          <p className="text-theme-text-secondary text-xs mt-2">
            Changing this deletes existing embeddings; documents must be
            embedded again.{" "}
            <DocLink href="https://docs.weaviate.io/weaviate/manage-collections/multi-tenancy">
              Learn more
            </DocLink>
          </p>
        </div>

        <div className="flex flex-col w-60">
          <label className="text-white text-sm font-semibold block mb-3">
            Hybrid search alpha (optional)
          </label>
          <input
            type="number"
            name="WeaviateHybridAlpha"
            min={0}
            max={1}
            step="0.05"
            className={INPUT_CLASS}
            placeholder="Empty = vector search only"
            defaultValue={settings?.WeaviateHybridAlpha}
            autoComplete="off"
          />
          <p className="text-theme-text-secondary text-xs mt-2">
            Combines keyword and vector search: 0 = keyword only, 1 = vector
            only.{" "}
            <DocLink href="https://docs.weaviate.io/weaviate/search/hybrid">
              Learn more
            </DocLink>
          </p>
        </div>
      </div>
    </div>
  );
}
