-- Portal da Logística — schema do D1 (banco `portal-logistica`).
-- Rodar no console do D1 (uma instrução por vez, se o console reclamar).
--
-- Primeira instalação: rode os CREATE abaixo.
-- Se você já criou a tabela `usuarios` sem a coluna de senha, rode só:
--   ALTER TABLE usuarios ADD COLUMN senha TEXT;
-- e depois o CREATE TABLE de `tentativas`.

CREATE TABLE IF NOT EXISTS usuarios (
  email TEXT PRIMARY KEY,
  perfil TEXT NOT NULL,              -- nome de um perfil da tabela `perfis`
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

-- Perfis = o que cada um PODE FAZER (26/10). Ferramentas que a pessoa abre continuam por pessoa (usuarios.ferramentas).
-- Só v.tozeti cria/altera/apaga perfis pela tela Usuários. `ti` sempre pode tudo; perfis de sistema não se apagam.
CREATE TABLE IF NOT EXISTS perfis (
  nome TEXT PRIMARY KEY,
  rotulo TEXT NOT NULL,
  editar_nfs INTEGER NOT NULL DEFAULT 0,   -- ignorar/reativar NF no Monitor
  admin INTEGER NOT NULL DEFAULT 0,        -- tela Usuários e log das ações
  sistema INTEGER NOT NULL DEFAULT 0,
  permissoes TEXT                          -- JSON, UMA POR FERRAMENTA (27/10): ["nf_ignorar","nf_ver_ocultas","admin"]; manda sobre as 2 colunas acima
);
-- Se a tabela `perfis` JÁ existia (migração de 26/10), rode só esta linha e as duas UPDATE abaixo:
--   ALTER TABLE perfis ADD COLUMN permissoes TEXT;
INSERT OR IGNORE INTO perfis (nome, rotulo, editar_nfs, admin, sistema) VALUES
  ('ti', 'TI', 1, 1, 1), ('logistica', 'Logística', 1, 0, 1), ('leitor', 'Somente leitura', 0, 0, 1),
  ('faturamento', 'Faturamento', 0, 0, 0);
UPDATE perfis SET permissoes = '["nf_ignorar","nf_ver_ocultas","nf_ignorar_robo"]' WHERE nome = 'logistica' AND permissoes IS NULL;
-- 27/10 (Ignorar no robô): se a Logística já tinha a lista antiga, rode também:
--   UPDATE perfis SET permissoes = '["nf_ignorar","nf_ver_ocultas","nf_ignorar_robo"]' WHERE nome = 'logistica';
UPDATE perfis SET permissoes = '[]' WHERE nome IN ('leitor', 'faturamento') AND permissoes IS NULL;

-- MIGRAÇÃO (banco que já existe, criado com o CHECK antigo em usuarios.perfil): rode UMA vez, nesta ordem, depois do
-- CREATE TABLE perfis acima. Confira que os dois SELECT COUNT dão o mesmo número antes do DROP.
--   CREATE TABLE usuarios_novo (email TEXT PRIMARY KEY, perfil TEXT NOT NULL, ferramentas TEXT,
--     acesso_custo INTEGER NOT NULL DEFAULT 0, ultimo_acesso INTEGER, senha TEXT);
--   INSERT INTO usuarios_novo SELECT email, perfil, ferramentas, acesso_custo, ultimo_acesso, senha FROM usuarios;
--   SELECT COUNT(*) FROM usuarios;  SELECT COUNT(*) FROM usuarios_novo;
--   DROP TABLE usuarios;
--   ALTER TABLE usuarios_novo RENAME TO usuarios;

CREATE TABLE IF NOT EXISTS tentativas (
  chave TEXT PRIMARY KEY,
  n INTEGER NOT NULL DEFAULT 0,
  ate INTEGER NOT NULL DEFAULT 0
);
