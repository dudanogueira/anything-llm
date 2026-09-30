# How to setup a local (or cloud) Weaviate Vector Database

[Get a Weaviate Cloud instance](https://docs.weaviate.io/weaviate/quickstart#create-an-instance).
[Set up Weaviate locally on Docker](https://docs.weaviate.io/deploy/installation-guides/docker-installation).

AnythingLLM requires **Weaviate 1.29 or later** and uses both its REST and gRPC endpoints. Weaviate Cloud needs no extra setup. For self-hosted Weaviate, gRPC defaults to the REST host on port `50051`, which the standard Docker setup exposes.

Fill out the variables in the "Vector Database" tab of settings. Select Weaviate as your provider and fill out the appropriate fields
with the information from either of the above steps.

### How to get started _Development mode only_

After setting up either the Weaviate cloud or local dockerized instance you just need to set these variable in `.env.development` or defined them at runtime via the UI.

```
VECTOR_DB="weaviate"
WEAVIATE_ENDPOINT='http://localhost:8080'
WEAVIATE_API_KEY= # Optional
WEAVIATE_GRPC_ENDPOINT= # Optional, e.g. 'http://localhost:50051'
WEAVIATE_QUANTIZATION= # Optional: rq-8 (1.32+), rq-1 (1.33+), bq, sq or pq, for new collections
WEAVIATE_MULTI_TENANCY= # Optional: "true" stores each workspace as a tenant of one "AnythingLLM" collection
WEAVIATE_HYBRID_ALPHA= # Optional, 0-1: enables hybrid (keyword + vector) search
```

- **Multi-tenancy:** changing it resets the Weaviate embeddings (like changing the embedder), so documents must be embedded again.
- **Hybrid search:** combines BM25 keyword matching on the chunk text with vector search. The document similarity threshold does not apply in hybrid mode, because it would drop exact keyword matches; the workspace's max context snippets limits the results instead.
