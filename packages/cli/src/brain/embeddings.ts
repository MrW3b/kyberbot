/**
 * KyberBot — Embeddings Indexer
 *
 * Manages vector embeddings using ChromaDB for semantic search.
 * Uses OpenAI text-embedding-3-small for generating embeddings.
 *
 * ChromaDB must be running: docker-compose up -d
 */

import { ChromaClient, Collection, type IEmbeddingFunction } from 'chromadb';
import OpenAI from 'openai';
import { createLogger } from '../logger.js';
import { getIdentity, getIdentityForRoot } from '../config.js';

const logger = createLogger('embeddings');

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════

export interface DocumentMetadata {
  type: 'conversation' | 'idea' | 'file' | 'transcript' | 'note';
  source_path: string;
  title?: string;
  timestamp: string;
  entities?: string[];
  topics?: string[];
  summary?: string;
  // ── ARP unification (Phase A) — agent-resource metadata ─────────────
  // Mirrors the canonical AgentResourceMetadata vocabulary from
  // @kybernesis/arp-spec. Lets typed /api/arp/*.search and .query
  // handlers filter ChromaDB results at the metadata layer (fast,
  // pre-LLM) instead of post-filtering. ChromaDB metadata values are
  // scalars; tags_csv stores tags as a comma-separated string for
  // `where: { tags_csv: { $like: '%marketing%' } }` style queries.
  project_id?: string;
  tags_csv?: string;
  classification?: 'public' | 'internal' | 'confidential' | 'pii';
  connection_id?: string;
  source_did?: string;
}

export interface SearchResult {
  id: string;
  content: string;
  metadata: DocumentMetadata;
  distance: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Derive a per-agent ChromaDB collection name.
 * If root is given, uses getIdentityForRoot (multi-agent safe).
 * Falls back to getIdentity() or 'kyberbot_data'.
 */
function getCollectionNameForRoot(root?: string): string {
  try {
    const identity = root ? getIdentityForRoot(root) : getIdentity();
    if (identity.agent_name) {
      const sanitized = identity.agent_name
        .toLowerCase()
        .replace(/[^a-z0-9_-]/g, '_')
        .replace(/^[^a-z0-9]+/, '')
        .replace(/[^a-z0-9]+$/, '');
      if (sanitized.length >= 1) {
        return `kyberbot_${sanitized}`;
      }
    }
  } catch {
    // identity.yaml not available — use default
  }
  return 'kyberbot_data';
}

const CONFIG = {
  CHUNK_SIZE: 300,
  CHUNK_OVERLAP: 75,
  MAX_RESULTS: 20,
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || 'text-embedding-3-large',
  // A large document can now legitimately produce 1000+ chunks since the
  // SF-030 chunker fix bounds every individual chunk to CHUNK_SIZE — but
  // sending all of them in one embeddings.create() + collection.upsert()
  // call hits a request-payload-size ceiling somewhere in the OpenAI/Chroma
  // chain ("Payload too large", a plain-text body the client fails to parse
  // as JSON — surfaced 2026-07-31 re-indexing a 330KB/~1,470-chunk file).
  // Batching sidesteps whichever layer enforces it without needing to know
  // which one does.
  EMBED_BATCH_SIZE: 100,
};

// ═══════════════════════════════════════════════════════════════════════════════
// CLIENTS (Lazy initialization)
// ═══════════════════════════════════════════════════════════════════════════════

// Shared clients (one connection regardless of how many agents)
let chromaClient: ChromaClient | null = null;
let openaiClient: OpenAI | null = null;
let chromaInitialized = false;
let chromaAvailable = false;

// Per-agent collections
const collections = new Map<string, Collection>();

function getOpenAIClient(): OpenAI {
  if (!openaiClient) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY not set');
    }
    openaiClient = new OpenAI({ apiKey });
  }
  return openaiClient;
}

async function generateEmbedding(text: string): Promise<number[]> {
  const client = getOpenAIClient();
  const response = await client.embeddings.create({
    model: CONFIG.EMBEDDING_MODEL,
    input: text,
  });
  return response.data[0].embedding;
}

async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  const client = getOpenAIClient();
  const response = await client.embeddings.create({
    model: CONFIG.EMBEDDING_MODEL,
    input: texts,
  });
  return response.data.map((d) => d.embedding);
}

export async function initializeEmbeddings(root?: string): Promise<boolean> {
  // If ChromaDB client not yet initialized, set it up
  if (!chromaInitialized) {
    chromaInitialized = true;

    const openaiKey = process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      logger.warn('OPENAI_API_KEY not set - embeddings disabled');
      return false;
    }

    logger.info('Initializing ChromaDB...');

    try {
      const chromaUrl = process.env.CHROMA_URL || 'http://localhost:8001';
      chromaClient = new ChromaClient({ path: chromaUrl });
      await chromaClient.heartbeat();
      chromaAvailable = true;
      logger.info(`ChromaDB client connected`, { url: chromaUrl });
    } catch {
      logger.warn('ChromaDB not available - run: docker-compose up -d');
      chromaAvailable = false;
      return false;
    }
  }

  if (!chromaAvailable || !chromaClient) return false;

  // Initialize per-agent collection if root is given and not yet loaded
  if (root && !collections.has(root)) {
    try {
      const openaiEmbedder: IEmbeddingFunction = {
        generate: async (texts: string[]): Promise<number[][]> => {
          return generateEmbeddings(texts);
        },
      };

      const collectionName = getCollectionNameForRoot(root);
      const col = await chromaClient.getOrCreateCollection({
        name: collectionName,
        embeddingFunction: openaiEmbedder,
        metadata: {
          description: 'KyberBot semantic search index',
          'hnsw:space': 'cosine',
        },
      });

      const count = await col.count();
      logger.info(`ChromaDB collection ready`, { collection: collectionName, documents: count });
      collections.set(root, col);
    } catch (error) {
      logger.error('Failed to initialize collection', { error: String(error) });
    }
  } else if (!root && collections.size === 0) {
    // Backward compat: no root given, use legacy getCollectionName
    try {
      const openaiEmbedder: IEmbeddingFunction = {
        generate: async (texts: string[]): Promise<number[][]> => {
          return generateEmbeddings(texts);
        },
      };

      const collectionName = getCollectionNameForRoot();
      const col = await chromaClient.getOrCreateCollection({
        name: collectionName,
        embeddingFunction: openaiEmbedder,
        metadata: {
          description: 'KyberBot semantic search index',
          'hnsw:space': 'cosine',
        },
      });

      const count = await col.count();
      logger.info(`ChromaDB connected`, { collection: collectionName, documents: count });
      collections.set('__default__', col);
    } catch (error) {
      logger.error('Failed to initialize default collection', { error: String(error) });
    }
  }

  return true;
}

export function isChromaAvailable(): boolean {
  return chromaAvailable;
}

/**
 * Reset the embeddings singleton state so the next call to initializeEmbeddings()
 * will re-establish connections. Used by the benchmark harness to reset between
 * conversations after deleting the ChromaDB collection.
 */
export function resetEmbeddings(root?: string): void {
  if (root) {
    collections.delete(root);
  } else {
    chromaClient = null;
    openaiClient = null;
    collections.clear();
    chromaInitialized = false;
    chromaAvailable = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// TEXT CHUNKING
// ═══════════════════════════════════════════════════════════════════════════════

interface TextChunk {
  text: string;
  index: number;
}

/**
 * Force-split a single oversized segment (a "sentence" per chunkText's own
 * punctuation-based split, that is itself larger than a full chunk) into
 * pieces no longer than maxLen. Packs whole words greedily; a single word
 * longer than maxLen on its own (a URL, a base64 blob, run-on captions with
 * no spaces) gets hard-sliced so nothing downstream can ever exceed maxLen
 * regardless of source punctuation or whitespace.
 *
 * This is the fix for SF-030 (see custodian-craft.md, 2026-07-31 /
 * finding-chromadb-chunker-silent-embed-failure-jul28.md): unpunctuated
 * transcript text produced a single "sentence" tens of thousands of
 * characters long, which chunkText previously passed through untouched —
 * either rejected outright by the embedding API's 8192-token ceiling, or
 * accepted as one enormous, useless chunk that matches everything weakly.
 */
function splitOversizedSegment(segment: string, maxLen: number): string[] {
  const pieces: string[] = [];
  const words = segment.split(/\s+/).filter(Boolean);
  let current = '';

  for (const rawWord of words) {
    let word = rawWord;
    while (word.length > maxLen) {
      if (current) {
        pieces.push(current);
        current = '';
      }
      pieces.push(word.slice(0, maxLen));
      word = word.slice(maxLen);
    }
    if (current.length + word.length + 1 > maxLen && current.length > 0) {
      pieces.push(current);
      current = word;
    } else {
      current += (current ? ' ' : '') + word;
    }
  }
  if (current) pieces.push(current);

  return pieces;
}

function chunkText(text: string): TextChunk[] {
  const chunks: TextChunk[] = [];
  const sentences = text.split(/(?<=[.!?])\s+/);
  let currentChunk = '';
  let chunkIndex = 0;

  for (const sentence of sentences) {
    if (sentence.length > CONFIG.CHUNK_SIZE) {
      // A single punctuation-delimited "sentence" that's itself bigger than
      // a whole chunk — flush whatever's pending, then hard-split this
      // segment on its own. See splitOversizedSegment() doc comment.
      if (currentChunk.trim()) {
        chunks.push({ text: currentChunk.trim(), index: chunkIndex++ });
        currentChunk = '';
      }
      for (const piece of splitOversizedSegment(sentence, CONFIG.CHUNK_SIZE)) {
        chunks.push({ text: piece, index: chunkIndex++ });
      }
      continue;
    }

    if (currentChunk.length + sentence.length > CONFIG.CHUNK_SIZE && currentChunk.length > 0) {
      chunks.push({ text: currentChunk.trim(), index: chunkIndex++ });

      // Keep overlap
      const words = currentChunk.split(' ');
      const overlapWords = words.slice(-Math.floor(CONFIG.CHUNK_OVERLAP / 5));
      currentChunk = overlapWords.join(' ') + ' ' + sentence;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + sentence;
    }
  }

  if (currentChunk.trim()) {
    chunks.push({ text: currentChunk.trim(), index: chunkIndex });
  }

  return chunks;
}

// ═══════════════════════════════════════════════════════════════════════════════
// INDEXING
// ═══════════════════════════════════════════════════════════════════════════════

export async function indexDocument(
  root: string,
  id: string,
  content: string,
  metadata: DocumentMetadata
): Promise<number> {
  if (!chromaInitialized) {
    await initializeEmbeddings(root);
  }

  const collection = collections.get(root) || collections.get('__default__');
  if (!chromaAvailable || !collection) {
    logger.debug(`Skipping indexing (ChromaDB not available): ${id}`);
    return 0;
  }

  if (!content || content.trim().length < 10) {
    logger.debug(`Skipping empty document: ${id}`);
    return 0;
  }

  const chunks = chunkText(content);
  logger.info(`Indexing document: ${id} (${chunks.length} chunks)`);

  const arpMeta: Record<string, string | number> = {};
  if (metadata.project_id) arpMeta['project_id'] = metadata.project_id;
  if (metadata.tags_csv) arpMeta['tags_csv'] = metadata.tags_csv;
  if (metadata.classification) arpMeta['classification'] = metadata.classification;
  if (metadata.connection_id) arpMeta['connection_id'] = metadata.connection_id;
  if (metadata.source_did) arpMeta['source_did'] = metadata.source_did;

  try {
    // Process in fixed-size batches — a single embeddings.create() /
    // collection.upsert() call covering every chunk of a large document
    // can exceed a request-payload-size limit even though no individual
    // chunk does (see EMBED_BATCH_SIZE comment above).
    for (let start = 0; start < chunks.length; start += CONFIG.EMBED_BATCH_SIZE) {
      const batch = chunks.slice(start, start + CONFIG.EMBED_BATCH_SIZE);
      const embeddings = await generateEmbeddings(batch.map((c) => c.text));

      const ids: string[] = [];
      const documents: string[] = [];
      const metadatas: Record<string, string | number>[] = [];

      for (const chunk of batch) {
        ids.push(`${id}_chunk_${chunk.index}`);
        documents.push(chunk.text);
        // ── ARP unification (Phase A) — pass through agent-resource ────
        // metadata fields when the producer set them. Empty string is the
        // ChromaDB-friendly null (avoids `undefined` filter issues) but
        // typed handlers SHOULD use `where: {project_id: 'alpha'}` not
        // `where: {project_id: ''}` for the unscoped lookup.
        metadatas.push({
          type: metadata.type,
          source_path: metadata.source_path,
          title: metadata.title || '',
          timestamp: metadata.timestamp,
          chunk_index: chunk.index,
          parent_id: id,
          entities: metadata.entities?.join(',') || '',
          topics: metadata.topics?.join(',') || '',
          summary: metadata.summary || '',
          ...arpMeta,
        });
      }

      await collection.upsert({ ids, documents, embeddings, metadatas });
    }

    logger.info(`Indexed: ${id} (${chunks.length} chunks)`);
    return chunks.length;
  } catch (error) {
    // Do NOT swallow this into a `return 0` — that's what let a 400 from
    // the embeddings API (oversized input, rate limit, bad key, etc.) print
    // as "Indexed ... - 0 chunk(s) created" in green with exit code 0. Every
    // caller either treats indexDocument as best-effort with its own
    // try/catch (store-conversation.ts's two call sites) or needs the
    // failure to be loud (commands/brain.ts's `add`, which has no catch of
    // its own around this call and relies on this throw reaching its outer
    // try/catch to print red + exit(1)). See SF-030 / custodian-log 2026-07-31.
    logger.error(`Failed to index ${id}`, { error: String(error) });
    throw error;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════════════════════════════════════════════

export async function semanticSearch(
  root: string,
  query: string,
  options: {
    limit?: number;
    type?: DocumentMetadata['type'];
    // ── ARP unification (Phase A/B) — metadata filters ────────────
    // Applied at the ChromaDB `where:` layer so out-of-scope chunks
    // are excluded BEFORE the result set leaves the vector store.
    // Defense in depth: cloud PDP gates whether the query happens;
    // these filters guarantee the result set stays scoped.
    project_id?: string;
    classification?: DocumentMetadata['classification'];
    connection_id?: string;
  } = {}
): Promise<SearchResult[]> {
  if (!chromaInitialized) {
    await initializeEmbeddings(root);
  }

  const collection = collections.get(root) || collections.get('__default__');
  if (!chromaAvailable || !collection) {
    logger.warn('Semantic search not available - ChromaDB not connected');
    return [];
  }

  const limit = options.limit || CONFIG.MAX_RESULTS;
  logger.info(`Searching: "${query}" (limit: ${limit})`);

  try {
    // Generate embedding for query
    const queryEmbedding = await generateEmbedding(query);

    // Build where filter — combine type + ARP metadata filters into a
    // single $and clause when more than one is set. ChromaDB requires
    // the $and operator for multi-condition filters.
    const conditions: Array<Record<string, unknown>> = [];
    if (options.type) conditions.push({ type: options.type });
    if (options.project_id) conditions.push({ project_id: options.project_id });
    if (options.classification) conditions.push({ classification: options.classification });
    if (options.connection_id) conditions.push({ connection_id: options.connection_id });
    const whereFilter =
      conditions.length === 0
        ? undefined
        : conditions.length === 1
          ? (conditions[0] as Record<string, string>)
          : { $and: conditions } as unknown as Record<string, string>;

    const results = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: limit,
      where: whereFilter,
    });

    const searchResults: SearchResult[] = [];

    if (results.ids[0]) {
      for (let i = 0; i < results.ids[0].length; i++) {
        const id = results.ids[0][i];
        const document = results.documents?.[0]?.[i];
        const metadata = results.metadatas?.[0]?.[i] as Record<string, unknown> | undefined;
        const distance = results.distances?.[0]?.[i];

        if (document && metadata) {
          const parentId = (metadata.parent_id as string) || id;
          searchResults.push({
            id: parentId,
            content: document,
            metadata: {
              type: metadata.type as DocumentMetadata['type'],
              source_path: metadata.source_path as string,
              title: metadata.title as string,
              timestamp: metadata.timestamp as string,
              entities: metadata.entities ? (metadata.entities as string).split(',').filter(Boolean) : undefined,
              topics: metadata.topics ? (metadata.topics as string).split(',').filter(Boolean) : undefined,
            },
            distance: distance || 0,
          });
        }
      }
    }

    logger.info(`Found ${searchResults.length} results for "${query}"`);
    return searchResults;
  } catch (error) {
    logger.error('Search failed', { error: String(error) });
    return [];
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATS
// ═══════════════════════════════════════════════════════════════════════════════

export async function getIndexStats(root?: string): Promise<{
  totalChunks: number;
  available: boolean;
}> {
  if (!chromaInitialized) {
    await initializeEmbeddings(root);
  }

  const collection = root ? collections.get(root) : (collections.get('__default__') || collections.values().next().value);
  if (!chromaAvailable || !collection) {
    return { totalChunks: 0, available: false };
  }

  const count = await collection.count();
  return { totalChunks: count, available: true };
}
