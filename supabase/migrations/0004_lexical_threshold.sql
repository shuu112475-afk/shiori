-- 0004: キーワード検索側が一度も発火していなかった問題の修正
--
-- 症状
--   デモ文書6本・評価質問30問で `npm run eval` を回したところ、
--   「ベクトル検索のみ」と「ハイブリッド+RRF」の数字が完全に一致した
--   （Hit@1 88.9% / MRR 0.944、順位が変わった質問は0問）。
--   個別に hybrid_search の戻り値を見ると、全件が
--   lexical_rank = null / lexical_similarity = 0 だった。
--   つまり RRF は常にベクトル側の順位だけを足しており、
--   ハイブリッド検索は事実上ベクトル検索だった。
--
-- 原因
--   `query_text %> c.search_text` は pg_trgm.word_similarity_threshold を
--   見る。既定値は 0.6。
--
--   pg_trgm は英数字以外を語の区切りとして扱うため、分かち書きしない
--   日本語では質問文がまるごと1語になる。n文字の語のトライグラム数は
--   n+1 個で、word_similarity は「一致したトライグラム数 ÷ 質問側の
--   トライグラム数」に概ね等しい。
--   例:「有休っていつまで持ち越せる？」は13文字＝14トライグラム。
--   0.6 を超えるには14個中9個、つまり質問文がほぼそのまま本文に
--   書かれている必要がある。実際の質問では起こりえない。
--
--   英語なら語ごとに区切られるので既定値 0.6 で妥当に働く。
--   日本語では効かない、という pg_trgm 側の前提の違いが原因。
--
-- 対処
--   `%>` を使うのをやめ、word_similarity を直接しきい値と比較する。
--
--   最初は関数定義に `set pg_trgm.word_similarity_threshold = '0.2'` を
--   付ける方法を試したが、Supabase では通らなかった。
--     ERROR: 42501: permission denied to set parameter
--            "pg_trgm.word_similarity_threshold"
--   ダッシュボードの postgres ロールは superuser ではないため、
--   拡張が予約しているGUCを関数に紐づけられない。
--   セッション単位の set_word_similarity_threshold() も、
--   コネクションプール越しでは次のクエリが同じセッションに来る保証がなく、
--   stable な SQL 関数の中からは呼べない（volatile なため）。
--   結局、関数の中で完結する書き方はこれしかない。
--
--   しきい値は 0.3。最初 0.2 で入れたが、実測したら副作用が出たので上げた。
--   経緯は下の「しきい値を 0.2 から 0.3 に上げた理由」に書く。
--
-- しきい値を 0.2 から 0.3 に上げた理由
--   0.2 で適用した直後、A-13「インシデントの影響度レベル3aとは」が
--   回答から拒否に転落した。答えが載っている
--   「4. 患者影響度分類」（cosine 0.489・ベクトル3位）が融合5位から
--   7位に落ち、代わりにベクトル上位20件にすら入っていない
--   「1. 基本理念と目的」（cosine 0.000）がキーワード1位として
--   6位に入り込んでいた。
--
--   評価30問 × 全チャンクで word_similarity を実測した分布:
--     A-11 0.407 / A-03 0.357 / A-14 0.300 / A-02 0.269 / A-13 0.241
--     B-01〜B-08 は 0.059〜0.143（全滅）
--   A-13 は最大でも 0.241 なのに 0.2 以上が7件ある。
--   つまり弱い一致が横一線に並んだ「ノイズの平地」で、
--   その中の1位は実質ランダムに決まる。
--   0.241 以下（ノイズ）と 0.300 以上（本物の一致）の間が空いているので、
--   その谷に 0.3 を置いた。
--
--   ここで最初に書いていた
--   「RRFは順位しか使わないので、しきい値を下げても上位に食い込まない限り
--     影響しない」という理屈は誤りだった。
--   全部がノイズのときはノイズが1位になり、RRF は1位に
--   1/(60+1) をそのまま与える。本物の1位と同じ重みである。
--   弱い一致を混ぜること自体が危険で、混ぜるなら谷の上に線を引くしかない。
--
-- 分かったこと: キーワード側は言い換えには効かない
--   B（表記ゆれ・言い換え）が 0.059〜0.143 と全カテゴリで最低だった。
--   pg_trgm が見ているのは文字面の重なりで、言い換えは文字面が
--   最も重ならない場合だからである。
--   B-01 は「有休…持ち越せる」、規程側は「年次有給休暇…繰り越し」で、
--   共通するトライグラムが無い。しきい値をいくら下げても拾えない。
--   同義語はベクトル側の担当であり、トライグラム側の担当ではない。
--
--   逆にキーワード側が本来効くのは、埋め込みが潰しがちな
--   「そのままの珍しい文字列」（型番・薬剤名・第22条のような条番号・ID）で、
--   いまの評価セットにはそれがほとんど無い。
--   だから今のデモ規模では、キーワード側は保険として積んである状態に近い。
--
-- 代償
--   `%>` は GIN インデックス（chunks_search_text_trgm）を使えるが、
--   関数呼び出しの比較に変えたので、キーワード側は組織内のチャンクを
--   全件走査して word_similarity を計算する。
--   RLS が効くので走査範囲は自組織のチャンクに限られ、
--   デモ規模（180チャンク）では体感差は無い。
--   数万チャンク規模になったら
--   `alter database ... set pg_trgm.word_similarity_threshold = 0.3` を
--   管理者権限で設定し、`%>` に戻すのが筋。
--
-- 検証
--   適用後に `npm run eval` と `npm run eval:refusal` を回し、
--   ・lexical_rank が付く質問が0問でないこと
--   ・Hit@1 / MRR が悪化しないこと
--   ・誤答が 0/3 のままで、誤拒否が増えていないこと
--   を確認すること。数字は README に記載している。

create or replace function public.hybrid_search(
  query_embedding extensions.vector(1536),
  query_text      text,
  match_count     int  default 5,
  pool_size       int  default 20,
  rrf_k           int  default 60
)
returns table (
  chunk_id     bigint,
  document_id  uuid,
  document_title text,
  content      text,
  heading_path text,
  page_no      int,
  score        double precision,
  vector_similarity  double precision,
  lexical_similarity double precision,
  vector_rank  int,
  lexical_rank int
)
language sql stable security invoker
set search_path = public, extensions
as $$
  with vector_hits as (
    select c.id,
           1 - (c.embedding <=> query_embedding) as similarity,
           row_number() over (order by c.embedding <=> query_embedding) as rank
    from public.chunks c
    where c.embedding is not null
    order by c.embedding <=> query_embedding
    limit pool_size
  ),
  lexical_hits as (
    select c.id,
           extensions.word_similarity(query_text, c.search_text) as similarity,
           row_number() over (
             order by extensions.word_similarity(query_text, c.search_text) desc
           ) as rank
    from public.chunks c
    where extensions.word_similarity(query_text, c.search_text) >= 0.3
    order by extensions.word_similarity(query_text, c.search_text) desc
    limit pool_size
  ),
  fused as (
    select coalesce(v.id, l.id) as id,
           coalesce(1.0 / (rrf_k + v.rank), 0.0)
         + coalesce(1.0 / (rrf_k + l.rank), 0.0) as score,
           coalesce(v.similarity, 0.0) as vector_similarity,
           coalesce(l.similarity, 0.0) as lexical_similarity,
           v.rank as vrank,
           l.rank as lrank
    from vector_hits v
    full outer join lexical_hits l on l.id = v.id
  )
  select c.id,
         c.document_id,
         d.title,
         c.content,
         c.heading_path,
         c.page_no,
         f.score,
         f.vector_similarity,
         f.lexical_similarity,
         f.vrank::int,
         f.lrank::int
  from fused f
  join public.chunks c    on c.id = f.id
  join public.documents d on d.id = c.document_id
  order by f.score desc
  limit match_count;
$$;

comment on function public.hybrid_search is
  'RRF統合スコア(score)は順位のみに基づくため、関連度の絶対評価には使えない。
   「答えられるか」の判定には必ず vector_similarity（cosine類似度）を使うこと。
   キーワード側のしきい値は日本語向けに word_similarity >= 0.2 を直書きしている（0004参照）。';
