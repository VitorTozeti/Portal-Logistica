-- Portal da Logística — schema do D1 (banco `portal-logistica`).
-- Rodar no console do D1 (uma instrução por vez, se o console reclamar).
--
-- Primeira instalação: rode os CREATE abaixo.
-- Se você já criou a tabela `usuarios` sem a coluna de senha, rode só:
--   ALTER TABLE usuarios ADD COLUMN senha TEXT;
-- e depois o CREATE TABLE de `tentativas`.

CREATE TABLE IF NOT EXISTS usuarios (
  email TEXT PRIMARY KEY,
  perfil TEXT NOT NULL CHECK (perfil IN ('logistica','ti','leitor')),
  ferramentas TEXT,
  acesso_custo INTEGER NOT NULL DEFAULT 0,
  ultimo_acesso INTEGER,
  senha TEXT
);

CREATE TABLE IF NOT EXISTS acoes (
  id TEXT PRIMARY KEY,
  tipo TEXT NOT NULL,
  motivo TEXT,
  nf TEXT,
  filial TEXT,
  em INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS acoes_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nf_id TEXT NOT NULL,
  acao TEXT NOT NULL,
  tipo TEXT,
  motivo TEXT,
  por TEXT NOT NULL,
  em INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tentativas (
  chave TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0,
  ate INTEGER NOT NULL DEFAULT 0
);
