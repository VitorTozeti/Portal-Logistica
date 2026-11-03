# Testes do Worker (functions/api)

Sem Node na máquina, o Worker é testado no navegador: `teste_worker.html` carrega o módulo real e troca o D1 por um SQLite
(sql.js, da cdnjs) com o schema ANTIGO — por isso também prova a auto-migração. Cobre níveis (ver/editar), claims do token
(`ce`, `pv`, `px`), validade, modelo de perfil, histórico de acessos e permissões de admin.

    python -m http.server 8766     # na raiz do repositório
    # abra http://127.0.0.1:8766/tests/teste_worker.html  → deve terminar em "0 falha(s)"
