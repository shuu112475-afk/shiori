export type MemberRole = "admin" | "member";
export type DocStatus = "pending" | "processing" | "ready" | "failed";
export type MessageRole = "user" | "assistant";
export type FeedbackVerdict = "good" | "bad";

export type Profile = {
  id: string;
  org_id: string;
  display_name: string | null;
  department: string;
  role: MemberRole;
  created_at: string;
};

export type Organization = {
  id: string;
  name: string;
  email_domain: string | null;
  created_at: string;
};

export type DocumentRow = {
  id: string;
  org_id: string;
  title: string;
  file_path: string;
  mime_type: string;
  byte_size: number | null;
  status: DocStatus;
  page_count: number | null;
  chunk_count: number;
  allowed_departments: string[] | null;
  error_message: string | null;
  uploaded_by: string | null;
  created_at: string;
  indexed_at: string | null;
};

export type ChunkRow = {
  id: number;
  document_id: string;
  org_id: string;
  chunk_index: number;
  content: string;
  heading_path: string | null;
  page_no: number | null;
  token_count: number | null;
};

export type Conversation = {
  id: string;
  org_id: string;
  user_id: string;
  title: string;
  created_at: string;
};

export type MessageRow = {
  id: string;
  conversation_id: string;
  org_id: string;
  role: MessageRole;
  content: string;
  top_score: number | null;
  answered: boolean | null;
  latency_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  created_at: string;
};

export type FaqOverride = {
  id: string;
  org_id: string;
  question: string;
  answer: string;
  enabled: boolean;
  hit_count: number;
  created_by: string | null;
  created_at: string;
};

export type Unanswered = {
  id: string;
  org_id: string;
  query: string;
  top_score: number | null;
  asked_by: string | null;
  message_id: string | null;
  resolved: boolean;
  faq_override_id: string | null;
  created_at: string;
};

/** hybrid_search() の返り値 */
export type SearchHit = {
  chunk_id: number;
  document_id: string;
  document_title: string;
  content: string;
  heading_path: string | null;
  page_no: number | null;
  /** RRF統合スコア。順位のみに基づくので並べ替え専用。関連度の絶対評価には使えない */
  score: number;
  /** cosine類似度。未回答判定はこちらを使う */
  vector_similarity: number;
  lexical_similarity: number;
  vector_rank: number | null;
  lexical_rank: number | null;
};

/** チャット応答で UI に返す出典 */
export type Citation = {
  rank: number;
  chunk_id: number;
  document_id: string;
  document_title: string;
  heading_path: string | null;
  page_no: number | null;
  excerpt: string;
  score: number;
};
