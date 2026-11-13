"""Textos dos alertas do robô da Unilog para quem lê o Portal e o e-mail de pendências (a Logística, que não é técnica).

Um lugar só, usado pelo Portal (unilog_feed) e pelo e-mail (email_pendencias), para os dois dizerem a mesma coisa:
  - a CATEGORIA de cada tipo de alerta, pelo assunto e por quem age (Estoque, Cadastro, Faturamento...). Não existe mais
    a categoria "Unilog": desde 04/11/2026 tudo é Unilog, e o chip não dizia nada (pedido do Marcelo, 11/11);
  - uma frase do que aconteceu, um tópico por item quando o alerta traz dado útil (item, lote, quantidade, o que falta)
    e o que fazer, começando por quem faz.

O robô continua gravando o texto dele (`mensagem`) no estado e no log. Aqui ele só vira tópico quando é dado para a
Logística; o detalhe técnico (HTTP, requestId) aparece como "Para a TI". O tipo do alerta (problema_codigo UNILOG_<tipo>)
não muda: botões e filtros do Portal dependem dele.

Sem dependência do robô (o coletor do Portal também importa este arquivo).
"""
import re

# ------------------------------------------------------------------ categorias (Portal: problema_categoria)
ESTOQUE = "ESTOQUE"
CADASTRO = "CADASTRO"
FATURAMENTO = "FATURAMENTO"
FINANCEIRO = "FINANCEIRO"
CANCELAMENTO = "CANCELAMENTO"
ENTRADA = "TRANSFERENCIA"        # mesma chave do Portal para "Transferência atrasada" (sap_feed): entrada e transferência
EXPEDICAO = "EXPEDICAO"
CORREIOS = "CORREIOS"
INTEGRACAO = "INTEGRACAO"
# 12/11/2026 (Marcelo): pedido mais demorado que o normal na Unilog não é travada. "Precisamos tomar cuidado para não
# misturar coisas que exigem uma ação imediata e coisas que são só avisos ou pontos de atenção, senão começa a entrar em
# desuso." No Portal fica fora da lista e do contador de Travadas; no e-mail, numa seção própria no fim.
ATENCAO = "ATENCAO"
# Até quando o atraso é só para acompanhar: depois disso a Logística pergunta à Unilog. 7 dias = o limite que o Portal
# usava até 12/11/2026 para mostrar o pedido parado como travada (decisão do Marcelo: mudar aqui).
DIAS_PERGUNTAR_UNILOG = 7

ROTULOS = {
    ESTOQUE: "Estoque",
    CADASTRO: "Cadastro",
    FATURAMENTO: "Faturamento",
    FINANCEIRO: "Financeiro",
    CANCELAMENTO: "Cancelamento",
    ENTRADA: "Entrada e transferência",
    EXPEDICAO: "Separação e embarque",
    CORREIOS: "Correios",
    INTEGRACAO: "Integração",
    ATENCAO: "Pontos de atenção",
}


# A frase da seção/bloco de pontos de atenção: a mesma no e-mail (email_pendencias) e no Portal (nomes-alertas.js).
TEXTO_ATENCAO = (f"Não travou: pedidos mais demorados que o normal na Unilog. Ninguém precisa agir agora; se passar de "
                 f"{DIAS_PERGUNTAR_UNILOG} dias, a Logística pergunta à Unilog.")


def e_atencao(categoria) -> bool:
    """Só acompanhar (não travou)? O resto das categorias pede ação de alguém."""
    return categoria == ATENCAO

# nomes das classes de estoque da Unilog (kits.py: 00 avulso, 12 item de kit; 93 e A2 são bloqueadas)
CLASSES = {"00": "avulso", "12": "kit", "93": "falta", "A2": "avaria"}

# nome que a Logística entende para cada situação da Unilog (o mesmo do selo do Portal, unilog_feed)
NOME_SITUACAO = {
    "": "Enviada", "1": "Pendente", "2": "Integrada", "3": "Em conferência", "4": "Conferida",
    "5": "Erro na integração", "21": "Cancelada", "22": "Embarcada",
}


def nome_etapa(code) -> str:
    code = str(code or "")
    return NOME_SITUACAO.get(code, code)

_AVISAR = "Logística não precisa agir: avisar o Marcelo ou o Vitor (é erro do robô ou da API da Unilog)"
_DIVERGENTE = ("Logística: conferir com a Unilog a diferença ({o_que}) e avisar o Marcelo ou o Vitor; a entrada só é "
               "confirmada depois disso (não dá para desfazer)")
SOLUCAO_SO_BOLETO = ("Financeiro: salvar o boleto na pasta NF-SAP ou, se a nota não tem boleto, usar \"Ignorar boleto\" no "
                     "Portal. Depois o robô manda a fatura sozinho na rodada seguinte")

# Recusas da Unilog que já sabemos explicar (o código vem no JSON da resposta)
RECUSAS = {"BATCH_DIVERGENT_FOR_EAN": "o mesmo EAN aparece com mais de um lote na nota"}

# Modo do tópico: "msg" = o texto do robô já é o tópico (o "há N h" dele vai para o fim); "texto" = o texto inteiro;
# "horas" = sem tópico, só o "há N h" do texto; "ti" = vai como "Para a TI"; None = a frase basta. Os outros modos
# ("falta", "recusa", "dias", "divergencias", "depois_dos_dois_pontos") tiram o tópico do texto/detalhe do robô.
# tipo -> (categoria, o que aconteceu, o que fazer, tópico)
_TIPOS = {
    # --- estoque
    "SEM_SALDO": (ESTOQUE, "Falta estoque na Unilog para separar esta nota; o pedido não foi enviado.",
                  "Logística: perguntar à Unilog se esse lote está lá. Se estiver com outro lote ou classe, a Unilog corrige "
                  "e o robô envia sozinho; se não estiver, o Faturamento refaz a NF com um lote que exista na Unilog", "msg"),
    "PEDIDO_SEM_SALDO": (ESTOQUE, "A Unilog avisou que falta estoque para separar este pedido.",
                         "Logística: conferir com a Unilog o estoque e o lote do pedido; se o lote não existe lá, o "
                         "Faturamento refaz a NF com um lote que exista na Unilog", None),
    # --- cadastro
    "SEM_EAN": (CADASTRO, "Item sem código de barras (EAN) no SAP; o pedido não foi enviado.",
                "Cadastro: incluir o EAN do item no SAP. Depois o robô envia a NF sozinho na rodada seguinte", "msg"),
    "EAN_ALTERADO": (CADASTRO, "O código de barras (EAN) do item mudou no SAP.",
                     "Logística: conferir o código impresso na embalagem e pedir à Unilog o cadastro do código novo; se o "
                     "SAP estiver errado, o Cadastro corrige. Depois o robô envia a NF sozinho", "msg"),
    "SEM_CADASTRO": (CADASTRO, "Item não cadastrado na Unilog; o pedido não foi enviado.",
                     "Logística: pedir à Unilog o cadastro do item (EAN). Depois o robô envia a NF sozinho", "msg"),
    "CADASTRO_PENDENTE": (CADASTRO, "Cadastro do item ainda não aprovado pela Unilog; o pedido não foi enviado.",
                          "Logística: cobrar da Unilog a aprovação do cadastro do item. Depois o robô envia a NF sozinho", "msg"),
    # --- faturamento / financeiro (arquivos da nota na pasta NF-SAP)
    "PEDIDO_SEM_ARQUIVO": (FATURAMENTO, "Pedido não enviado à Unilog: falta arquivo da nota na pasta NF-SAP.",
                           "Faturamento: salvar o que falta na pasta NF-SAP (a automação que grava pode ter parado). O pedido "
                           "só sobe para a Unilog com os arquivos; depois disso vai sozinho", "falta"),
    "BILLING_SEM_ARQUIVO": (FATURAMENTO, "A fatura não foi para a Unilog: falta arquivo da nota na pasta NF-SAP.",
                            "Faturamento: salvar na pasta NF-SAP o XML, a DANFE ou o boleto que falta. Depois o robô manda a "
                            "fatura sozinho na rodada seguinte", "falta"),
    "SEM_VOLUMES": (FATURAMENTO, "Nota sem a quantidade de volumes (embalagens) no SAP: o pedido foi com 1 volume.",
                    "Faturamento: conferir a quantidade de embalagens da nota no SAP; a Logística confere os volumes com a "
                    "Unilog", None),
    "SHARE_NF_SEM_ARQUIVOS": (FATURAMENTO, "Várias notas sem XML ou DANFE na pasta NF-SAP: a gravação dos arquivos parece "
                              "parada.", "Faturamento: verificar a automação que grava na pasta NF-SAP. O pedido e a fatura "
                              "saem sozinhos quando os arquivos voltarem", "texto"),
    # --- cancelamento
    "NF_CANCELADA_SAP": (CANCELAMENTO, "Nota cancelada no SAP com pedido na Unilog.",
                         "Logística: falar com a Unilog. Pedido que não saiu: pedir o cancelamento; pedido que já saiu: "
                         "tratar a devolução", "msg"),
    "CANCELAMENTO_SEM_ACAO": (CANCELAMENTO, "Nota cancelada no SAP, mas o robô ainda não conseguiu cancelar o pedido na Unilog.",
                              "Logística: se o aviso continuar, pedir o cancelamento à Unilog (o robô tenta de novo a cada "
                              "rodada)", None),
    "CANCELAMENTO_MANUAL_PENDENTE": (CANCELAMENTO, "O robô cancelou o pedido pela API, mas a operação da Unilog ainda não "
                                     "cancelou.", "Logística: pedir à Unilog o cancelamento manual no sistema da operação", None),
    "CANCELADA_NA_UNILOG": (CANCELAMENTO, "Nota cancelada no SAP: o robô cancelou o pedido no estoque da Unilog.",
                            "Logística: pedir à Unilog o cancelamento manual no sistema da operação (a API ainda não chega "
                            "lá)", None),
    "CANCELADA_SO_NA_UNILOG": (CANCELAMENTO, "A Unilog cancelou o pedido, mas a nota continua válida no SAP: a mercadoria não "
                               "vai sair.", "Logística: perguntar à Unilog o motivo antes de mexer na nota. Ela pode pedir o "
                               "reenvio, e aí a nota não pode ser cancelada", None),
    "ENTRADA_DE_NF_CANCELADA": (CANCELAMENTO, "Transferência cancelada no SAP, mas a entrada no destino já foi enviada à Unilog.",
                                "Logística: pedir à Unilog para cancelar essa entrada", None),
    "ENTRADA_MATRIZ_NF_CANCELADA": (CANCELAMENTO, "Nota da Matriz cancelada no SAP depois de a entrada ir para a Unilog.",
                                    "Logística: pedir à Unilog para cancelar a entrada (o robô não confirma)", None),
    # --- entrada e transferência
    "TRANSF_PROPRIA_FILIAL": (ENTRADA, "Nota para a própria filial: a mercadoria entra na Unilog, não sai. O robô não enviou.",
                              "Logística não precisa agir: avisar o Marcelo ou o Vitor para enviar a entrada", None),
    "ENTRADA_DIVERGENTE": (ENTRADA, "A conferência da entrada na Unilog deu diferente da nota; o robô não confirmou a entrada.",
                           _DIVERGENTE.format(o_que="falta, avaria, lote ou classe"), "divergencias"),
    "ENTRADA_PARADA": (ENTRADA, "Entrada enviada à Unilog e ainda não conferida: a mercadoria não entrou no estoque.",
                       "Logística: perguntar à Unilog se a carga chegou e quando fazem a conferência; se a mercadoria não "
                       "foi para a Unilog, avisar o Marcelo ou o Vitor", "dias"),
    "ENTRADA_CANCELADA": (ENTRADA, "A Unilog cancelou a entrada: a mercadoria não entra no estoque.",
                          "Logística: perguntar à Unilog por que a entrada foi cancelada e avisar o Marcelo ou o Vitor", None),
    "ENTRADA_MATRIZ_PENDENTE": (ENTRADA, "Nota da Matriz sem entrada na Unilog: o envio automático está desligado.",
                                "Logística não precisa agir: avisar o Marcelo ou o Vitor para ligar o envio automático; não "
                                "mandar à mão", None),
    "ENTRADA_MATRIZ_RECUSADA": (ENTRADA, "A Unilog recusou a entrada da nota da Matriz.",
                                "Logística: ver o motivo. Dado da NF ou cadastro: Faturamento ou Cadastro corrigem; problema "
                                "da Unilog: falar com ela. O robô tenta de novo a cada rodada", "recusa"),
    "ENTRADA_MATRIZ_DIVERGENTE": (ENTRADA, "A conferência da entrada da Matriz deu diferente da nota; o robô não confirmou.",
                                  _DIVERGENTE.format(o_que="falta, avaria, lote ou classe"), "divergencias"),
    "ENTRADA_MATRIZ_PARADA": (ENTRADA, "Entrada da Matriz enviada e a Unilog ainda não conferiu a carga.",
                              "Logística: perguntar à Unilog se a carga chegou; se a mercadoria não foi para a Unilog, avisar o "
                              "Marcelo ou o Vitor", "dias"),
    "ENTRADA_MATRIZ_CANCELADA": (ENTRADA, "A Unilog cancelou a entrada da nota da Matriz: a mercadoria não entra no estoque.",
                                 "Logística: perguntar à Unilog por que a entrada foi cancelada e avisar o Marcelo ou o Vitor",
                                 None),
    "ENTRADA_IMPORTACAO_BLOQUEADA": (ENTRADA, "Entrada da importação não enviada à Unilog.",
                                     "Logística: ver o motivo. XML na pasta errada: mover para a pasta da filial do "
                                     "destinatário; item sem cadastro: Cadastro; validade diferente: conferir com a trading. "
                                     "Depois o robô envia sozinho", "depois_dos_dois_pontos"),
    "ENTRADA_IMPORTACAO_XML": (ENTRADA, "O XML da importação salvo na pasta não abre como NF-e.",
                               "Logística: salvar de novo o XML da nota. Depois o robô envia sozinho", None),
    "ENTRADA_IMPORTACAO_RECUSADA": (ENTRADA, "A Unilog recusou a entrada da importação.",
                                    "Logística não precisa agir: avisar o Marcelo ou o Vitor (a Unilog recusou a entrada pela "
                                    "API)", "recusa"),
    "ENTRADA_IMPORTACAO_PENDENTE": (ENTRADA, "Nota de importação pronta, mas o envio automático da entrada está desligado.",
                                    "Logística não precisa agir: avisar o Marcelo ou o Vitor para ligar o envio automático",
                                    None),
    "ENTRADA_IMPORTACAO_DIVERGENTE": (ENTRADA, "A conferência da entrada da importação deu diferente da nota; o robô não "
                                      "confirmou.", _DIVERGENTE.format(o_que="falta, avaria, lote ou validade"),
                                      "divergencias"),
    "ENTRADA_IMPORTACAO_PARADA": (ENTRADA, "Entrada da importação enviada e a Unilog ainda não conferiu a carga.",
                                  "Logística: perguntar à Unilog se a carga chegou e se o recebimento foi agendado no Fretefy",
                                  "dias"),
    "ENTRADA_IMPORTACAO_CANCELADA": (ENTRADA, "A Unilog cancelou a entrada da importação: a mercadoria não entra no estoque.",
                                     "Logística: perguntar à Unilog por que a entrada foi cancelada e avisar o Marcelo ou o "
                                     "Vitor", None),
    # --- pontos de atenção: o pedido não travou, está mais demorado que o normal (12/11/2026; antes em Separação e embarque,
    # como travada, mandando "perguntar à Unilog")
    "PARADO_EM_2": (ATENCAO, "Pedido recebido pela Unilog e ainda não separado.",
                    f"Só acompanhar: o pedido não travou, a separação está demorando. Se passar de {DIAS_PERGUNTAR_UNILOG} "
                    "dias, a Logística pergunta à Unilog por que não separou (falta de estoque, lote ou classe diferente; "
                    "a Unilog só avisa isso por e-mail)", "horas"),
    "PARADO": (ATENCAO, "Pedido demorando na mesma etapa da Unilog.",
               f"Só acompanhar: o pedido não travou, está mais demorado que o normal. Se passar de {DIAS_PERGUNTAR_UNILOG} "
               "dias, a Logística pergunta à Unilog o que falta para o pedido andar", "msg"),
    "AGUARDA_EMBARQUE": (ATENCAO, "Pedido separado na Unilog e ainda não embarcado.",
                         f"Só acompanhar: o pedido não travou, a coleta está demorando. Se passar de "
                         f"{DIAS_PERGUNTAR_UNILOG} dias, a Logística pergunta à Unilog quando sai a coleta (ou se a "
                         "transportadora já levou)", "msg"),
    # --- separação e embarque
    "SEPARACAO_DIVERGENTE": (EXPEDICAO, "A Unilog separou diferente da nota; o robô não liberou a saída.",
                             "Logística: conferir com a Unilog o que foi separado; se estiver errado, a Unilog refaz a "
                             "separação. Avisar o Marcelo ou o Vitor", "divergencias"),
    "EMBARCADO_FORA_DE_4": (EXPEDICAO, "A planilha de expedição da Unilog diz que a nota saiu, mas o pedido ainda não estava "
                            "pronto para sair na Unilog.", "Logística: com o pedido em andamento, nada a fazer (o robô marca "
                            "como embarcado quando a Unilog concluir a separação). Pedido recusado ou cancelado: conferir com a "
                            "Unilog o que saiu", "msg"),
    "EMBARCADO_NF_DESCONHECIDA": (EXPEDICAO, "A planilha de expedição da Unilog cita uma nota que o robô não mandou.",
                                  "Logística: conferir com a Unilog que nota é essa (pode ser de antes da virada ou digitada "
                                  "errada)", "msg"),
    "EMBARCADO_ARQUIVO": (EXPEDICAO, "A planilha de expedição da Unilog não pôde ser lida.",
                          "Logística: conferir o arquivo na pasta (nome, colunas, data); se não achar o problema, avisar o "
                          "Marcelo ou o Vitor", "msg"),
    "FORA_DO_ROBO": (EXPEDICAO, "Nota de um tipo que o robô não manda à Unilog.",
                     "Logística: combinar com a Unilog o envio desta nota à mão", "msg"),
    # --- Correios
    "ETIQUETA_PENDENTE": (CORREIOS, "Pedido não enviado: a etiqueta dos Correios ainda não foi gerada.",
                          "Logística: ver o erro da etiqueta na seção Correios do e-mail (em geral, o cadastro do cliente no "
                          "SAP). O robô envia a NF quando a etiqueta existir", None),
    "ETIQUETA_FALHOU": (CORREIOS, "O robô não conseguiu gerar a etiqueta dos Correios.", _AVISAR, "ti"),
    # --- integração (envio e leitura pela API)
    # 12/11/2026: NF de Varejo/Atacado do corte em diante que o robô ainda não mandou e sobre a qual ele não avisou nada.
    # Montada pelo Portal (feed.py), não pelo robô. Antes aparecia como "Falha no envio da NF para a B4You".
    "NAO_ENVIADA": (INTEGRACAO, "Ainda não enviada à Unilog.",
                    "Logística não precisa agir: o robô envia a nota sozinho na rodada seguinte (a cada 15 min, das 7h às "
                    "23h). Se ela continuar aqui depois de duas rodadas, avisar o Marcelo ou o Vitor", None),
    "POST_INCERTO": (INTEGRACAO, "O envio à Unilog ficou sem resposta: o pedido pode ter entrado.",
                     "Logística: perguntar à Unilog se a NF entrou e, se entrou, o número do pedido (requestId); não reenviar "
                     "nem cancelar antes da resposta. Depois avisar o Marcelo ou o Vitor", None),
    "POST_INCERTO_SEM_DOC": (INTEGRACAO, "O envio à Unilog ficou sem resposta e a busca não achou o pedido (a busca falha até "
                             "para pedido que existe).", "Logística: perguntar à Unilog se a NF entrou e, se entrou, o número "
                             "do pedido (requestId); não reenviar nem cancelar antes da resposta. Depois avisar o Marcelo ou o "
                             "Vitor", "horas"),
    "POST_INCERTO_SEM_PEDIDO": (INTEGRACAO, "O envio ficou sem resposta e a Unilog diz que o pedido não existe: a nota não "
                                "entrou.", "Logística não precisa agir: avisar o Marcelo ou o Vitor para reenviar a NF", None),
    "POST_RECUSADO": (INTEGRACAO, "A Unilog recusou o pedido.",
                      "Logística: ver o motivo. Dado da NF: o Faturamento corrige; problema da Unilog: falar com ela. O robô "
                      "tenta de novo a cada rodada", "recusa"),
    "INTEGRADO_COM_ERRO": (INTEGRACAO, "A Unilog recebeu o pedido com erro.", _AVISAR, "ti"),
    "SITUACAO_DESCONHECIDA": (INTEGRACAO, "A Unilog devolveu uma situação que o robô não conhece.", _AVISAR, "ti"),
    "SEM_STATUS": (INTEGRACAO, "Pedido enviado, mas o robô não consegue ler a situação dele na Unilog.", _AVISAR, "ti"),
    "DOC_SEM_REGISTRO": (INTEGRACAO, "A nota já tem pedido na Unilog, mas o robô não o acompanha.", _AVISAR, "ti"),
    "CADASTRO_ERRO": (INTEGRACAO, "O robô não conseguiu ler o cadastro do item na Unilog.", _AVISAR, "ti"),
    "CONFIRMACAO_SEM_ID": (INTEGRACAO, "O robô não conseguiu liberar a saída do pedido na Unilog.", _AVISAR, "ti"),
    "CONFIRMACAO_FALHOU": (INTEGRACAO, "O robô não conseguiu liberar a saída do pedido na Unilog.", _AVISAR, "ti"),
    "BILLING_ERRO": (INTEGRACAO, "A Unilog recusou a fatura enviada pelo robô.", _AVISAR, "ti"),
    "CLASSE_PELA_REGRA": (INTEGRACAO, "Item de kit fora do padrão na nota: foi pedido como avulso.",
                          "Logística: conferir na Unilog se o pedido foi separado certo", "ti"),
    "REENVIO_NAO_LIBERADO": (INTEGRACAO, "A lista de reenvio cita esta nota, mas a Unilog ainda mostra o pedido.", _AVISAR, "ti"),
    "REQUEST_ID_DIVERGENTE": (INTEGRACAO, "O número de pedido (requestId) informado é de outra nota.", _AVISAR, "ti"),
    "ENTRADA_COM_ERRO": (INTEGRACAO, "A Unilog recebeu a entrada com erro.", _AVISAR, "ti"),
    "ENTRADA_CONFIRMACAO_FALHOU": (INTEGRACAO, "O robô não conseguiu confirmar a entrada na Unilog.", _AVISAR, "ti"),
    "ENTRADA_SEM_NF": (INTEGRACAO, "O robô não achou no SAP a nota de entrada desta transferência.", _AVISAR, "ti"),
    "ENTRADA_CLASSE_DESCONHECIDA": (INTEGRACAO, "O robô não sabe em que classe dar a entrada desta transferência.", _AVISAR,
                                    "ti"),
    "ENTRADA_POST_FALHOU": (INTEGRACAO, "O envio da entrada desta transferência à Unilog falhou.", _AVISAR, "ti"),
    "ENTRADA_INCERTA": (INTEGRACAO, "O envio da entrada ficou sem resposta: pode ter entrado na Unilog.", _AVISAR, "ti"),
    "RETORNO_CONFIRMACAO_FALHOU": (INTEGRACAO, "O robô não conseguiu confirmar na Unilog a volta da mercadoria do cancelamento.",
                                   _AVISAR, "ti"),
    "ENTRADA_MATRIZ_INCERTA": (INTEGRACAO, "O envio da entrada da Matriz ficou sem resposta: pode ter entrado na Unilog.",
                               _AVISAR, "ti"),
    "ENTRADA_MATRIZ_COM_ERRO": (INTEGRACAO, "A Unilog recebeu a entrada da Matriz com erro.", _AVISAR, "ti"),
    "ENTRADA_MATRIZ_CONFIRMACAO_FALHOU": (INTEGRACAO, "O robô não conseguiu confirmar a entrada da Matriz na Unilog.", _AVISAR,
                                          "ti"),
    "ENTRADA_MATRIZ_SEM_NF": (INTEGRACAO, "O robô não conseguiu montar a nota da Matriz a partir do SAP: entrada não enviada.",
                              _AVISAR, "ti"),
    "ENTRADA_IMPORTACAO_INCERTA": (INTEGRACAO, "O envio da entrada da importação ficou sem resposta: pode ter entrado na Unilog.",
                                   _AVISAR, "ti"),
    "ENTRADA_IMPORTACAO_COM_ERRO": (INTEGRACAO, "A Unilog recebeu a entrada da importação com erro.", _AVISAR, "ti"),
    "ENTRADA_IMPORTACAO_CONFIRMACAO_FALHOU": (INTEGRACAO, "O robô não conseguiu confirmar a entrada da importação na Unilog.",
                                              _AVISAR, "ti"),
    "SEM_ESTADO": (INTEGRACAO, "O Portal não consegue ler o estado do robô da Unilog: os envios não aparecem aqui.", _AVISAR,
                   "ti"),
    "ESTADO_VELHO": (INTEGRACAO, "O robô da Unilog parou de atualizar.",
                     "Logística não precisa agir: avisar o Marcelo ou o Vitor para conferir a tarefa no servidor", "horas"),
    # 12/11/2026: alerta da filial (NF "ENVIO"), repetido enquanto o envio estiver parado (robo_saida.enviar_novas)
    "ENVIO_PARADO": (INTEGRACAO, "O envio de pedidos à Unilog está parado nesta filial: a Unilog não respondeu.",
                     "Logística: avisar o Marcelo ou o Vitor e perguntar à Unilog se a API está fora do ar ou lenta. O "
                     "robô tenta de novo a cada rodada e envia sozinho quando a Unilog responder; não mandar pedido à mão",
                     "msg"),
    # 12/11/2026: alerta da filial (NF "FATURA"), repetido enquanto o disjuntor da fatura estiver aberto (robo_saida.faturar)
    "FATURA_PARADA": (INTEGRACAO, "A fatura das notas não está indo para a Unilog nesta filial: a Unilog não respondeu.",
                      "Logística: avisar o Marcelo ou o Vitor e perguntar à Unilog se a API está fora do ar ou lenta. Sem a "
                      "fatura a mercadoria não sai; o robô manda sozinho quando a Unilog responder, não mandar à mão",
                      "msg"),
    "FATURA_SEM_RESPOSTA": (INTEGRACAO, "A Unilog não respondeu à fatura desta nota em mais de uma rodada.",
                            "Logística não precisa agir: avisar o Marcelo ou o Vitor (pode ser algo desta nota na Unilog). O "
                            "robô tenta de novo a cada rodada", "ti"),
}
_DESCONHECIDO = (INTEGRACAO, "Aviso do robô da Unilog.", _AVISAR, "msg")

# Situações que o Portal monta do estado (sem alerta do robô) -> tipo do catálogo. O problema_codigo não muda.
_APELIDOS = {"RECUSADO": "POST_RECUSADO", "ERRO_INTEGRACAO": "INTEGRADO_COM_ERRO"}

_RE_TAGS = re.compile(r"\s*\[(?:FATURAMENTO|FINANCEIRO|CRÍTICO|CRITICO)\]\s*")
_RE_HORAS = re.compile(r"\s*\(?\bh[aá] (\d+) ?h\)?")
_RE_DIAS = re.compile(r"\bh[aá] (\d+) dia")
_RE_CODIGO = re.compile(r'"code"\s*:\s*"([A-Z0-9_]+)"')
_RE_TIMESTAMP = re.compile(r'"timestamp"\s*:\s*"[^"]*",?')
_RE_CLASSE = re.compile(r"\b(na classe |classe |cl)(00|12|93|A2)\b")
_RE_SEPARADO = re.compile(r"^(\d+) (.+) cl(\w+): (.+)$")      # robo_saida.divergencias_separacao
_RE_CONFERIDO = re.compile(r"^(EAN \S+: )([\d.]+) na classe")    # entradas_avulsas.divergencias
_MAX_TOPICOS = 8


def tipos() -> dict:
    """Cópia do catálogo (testes e conferência)."""
    return dict(_TIPOS)


def canonico(tipo) -> str:
    tipo = str(tipo or "")
    return _APELIDOS.get(tipo, tipo)


def _cat(tipo):
    return _TIPOS.get(canonico(tipo), _DESCONHECIDO)


_RE_FALTA = re.compile(r"(?:esperando|falta) (.+?) no share", re.I)


def detalhe_do_texto(tipo, mensagem) -> str:
    """O que falta ("DANFE,boleto") lido do texto do robô, para quem não recebeu o `detalhe` do alerta."""
    if canonico(tipo) not in ("BILLING_SEM_ARQUIVO", "PEDIDO_SEM_ARQUIVO"):
        return ""
    achado = _RE_FALTA.search(str(mensagem or ""))
    return ",".join(x.strip() for x in achado.group(1).split(",")) if achado else ""


def so_boleto(detalhe) -> bool:
    """O alerta de arquivo faltando é só do boleto? (detalhe = "XML,DANFE,boleto")"""
    return {x.strip().lower() for x in str(detalhe or "").split(",") if x.strip()} == {"boleto"}


# 12/11/2026: a NF 19444 saía no Portal com "Falta a DANFE" do log mestre e, logo abaixo, "Pedido não enviado à Unilog:
# falta arquivo... • Falta: DANFE" do robô -- a mesma coisa duas vezes. O coletor (coletor_azure._juntar_mesma_nf) usa
# esta leitura para tirar o parágrafo do log quando o do robô já cobra os mesmos arquivos.
_ARQUIVOS_LOG = {"FALTA_XML_DANFE": {"xml", "danfe"}, "FALTA_XML": {"xml"}, "FALTA_DANFE": {"danfe"},
                 "BOLETO_AUSENTE": {"boleto"}}
_TIPOS_ARQUIVO = ("PEDIDO_SEM_ARQUIVO", "BILLING_SEM_ARQUIVO")
_RE_TEMPO = re.compile(r"\s*\(há \d+ (?:h|dias)\)")


def arquivos_faltando(paragrafo) -> tuple:
    """(origem, arquivos) de um parágrafo do Portal que cobra arquivo da nota na pasta NF-SAP. origem = "log" (frase do
    log mestre, texto_log) ou "unilog" (bloco PEDIDO_SEM_ARQUIVO / BILLING_SEM_ARQUIVO do robô, montado por descricao);
    arquivos em minúsculas ({"danfe", "boleto"}). Outro assunto: ("", set())."""
    p = str(paragrafo or "").strip()
    for chave, arquivos in _ARQUIVOS_LOG.items():
        if p == texto_log(chave):
            return "log", set(arquivos)
    linhas = p.split("\n")
    if not any(linhas[0].startswith(titulo(t).rstrip(".")) for t in _TIPOS_ARQUIVO):
        return "", set()
    arquivos = set()
    for linha in linhas[1:]:
        linha = _RE_TEMPO.sub("", linha).strip()
        if linha == "• Falta o boleto":
            arquivos.add("boleto")
        elif linha.startswith("• Falta: "):
            arquivos |= {x.strip().lower() for x in re.split(r", | e ", linha[len("• Falta: "):]) if x.strip()}
    return "unilog", arquivos


# 13/11/2026 (Leo, Marcelo: "O filtro transferência deveria falar mais alto do que o estoque"): NF de transferência
# (uso 106-109; o robô lê nf["tipo"] == "TRANSFERENCIA" do SAP) com aviso de Estoque fica em Entrada e transferência, no
# Portal e no e-mail. O texto segue dizendo a causa (falta de estoque); só muda a categoria. Só o Estoque, por ora.
NF_TRANSFERENCIA = "TRANSFERENCIA"
SOBEM_PARA_TRANSFERENCIA = frozenset({ESTOQUE})


def categoria(tipo, detalhe="", nf_tipo="") -> str:
    """Categoria do Portal. Arquivo faltando: só o boleto = Financeiro; XML/DANFE = Faturamento. `nf_tipo` = o tipo da NF
    que o robô gravou no alerta (ou o do registro da NF): transferência com aviso de Estoque = Entrada e transferência."""
    if canonico(tipo) == "BILLING_SEM_ARQUIVO" and so_boleto(detalhe):
        return FINANCEIRO
    cat = _cat(tipo)[0]
    if nf_tipo == NF_TRANSFERENCIA and cat in SOBEM_PARA_TRANSFERENCIA:
        return ENTRADA
    return cat


def rotulo(cat) -> str:
    return ROTULOS.get(cat, str(cat or "").title())


def titulo(tipo) -> str:
    """O que aconteceu, numa frase."""
    return _cat(tipo)[1]


def acao(tipo, detalhe="") -> str:
    """O que fazer, começando por quem faz."""
    if canonico(tipo) == "BILLING_SEM_ARQUIVO" and so_boleto(detalhe):
        return SOLUCAO_SO_BOLETO
    return _cat(tipo)[2]


def nome_classe(c) -> str:
    c = str(c or "")
    return f"{c} ({CLASSES[c]})" if c in CLASSES else c


def _classes_por_nome(texto):
    """'EAN X: 1 na classe 12' -> '... na classe 12 (kit)'; a linha da separação vira 'EAN X, lote L (kit): ...'."""
    sep = _RE_SEPARADO.match(texto)
    if sep:
        ean, lote, cl, resto = sep.groups()
        lote = "sem lote" if lote == "*" else f"lote {lote}"
        return f"EAN {ean}, {lote} ({CLASSES.get(cl, 'classe ' + cl)}): {resto}"
    texto = _RE_CONFERIDO.sub(r"\1a Unilog conferiu \2 na classe", texto)   # entradas_avulsas.divergencias
    return _RE_CLASSE.sub(lambda m: (m.group(1) if m.group(1) != "cl" else "classe ") + nome_classe(m.group(2)), texto)


def _juntar(nomes):
    nomes = [n for n in nomes if n]
    if len(nomes) <= 1:
        return "".join(nomes)
    return ", ".join(nomes[:-1]) + " e " + nomes[-1]


def _limpo(texto, limite=300):
    t = _RE_TAGS.sub(" ", str(texto or "")).strip()
    return t[:limite].rstrip() + ("…" if len(t) > limite else "")


def motivo_recusa(texto) -> str:
    """Motivo da recusa da Unilog sem o JSON: o código explicado quando a gente o conhece, senão o texto curto."""
    texto = str(texto or "")
    codigos = list(dict.fromkeys(_RE_CODIGO.findall(texto)))
    if codigos:
        return ", ".join(f"{RECUSAS[c]} ({c})" if c in RECUSAS else c for c in codigos)
    texto = _RE_TIMESTAMP.sub("", texto)
    texto = re.sub(r"^.*?(?:recusou[^:]*?\(HTTP \d+\)|HTTP \d+)\s*:\s*", "", texto, count=1)
    return _limpo(texto, 200) or "a Unilog não disse o motivo"


def topicos(tipo, mensagem="", detalhe=""):
    """(tópicos, horas): os itens do alerta para a Logística e, se o texto do robô diz há quantas horas, esse número."""
    modo = _cat(tipo)[3]
    msg = str(mensagem or "").strip()
    horas = None
    achado = _RE_HORAS.search(msg)
    if achado and modo in ("falta", "msg", "horas"):
        horas = int(achado.group(1))
    if modo == "falta":
        falta = [x.strip() for x in str(detalhe or detalhe_do_texto(tipo, msg)).split(",") if x.strip()]
        if not falta:
            return [], horas
        if falta == ["boleto"]:
            return ["Falta o boleto"], horas
        return [f"Falta: {_juntar(falta)}"], horas
    if modo == "recusa":         # sem texto (ex.: NF liberada para reenvio) não há motivo a mostrar
        return ([f"Motivo: {motivo_recusa(msg)}"] if msg else []), None
    if modo == "dias":
        dias = _RE_DIAS.search(msg)
        return ([f"Enviada há {dias.group(1)} dia(s)"] if dias else []), None
    if modo == "divergencias":
        corpo = msg.split(": ", 1)[1] if ": " in msg else msg
        corpo = re.split(r"\.\s+Conferir", corpo)[0]
        return [_classes_por_nome(d.strip()) for d in corpo.split("; ") if d.strip()], None
    if modo == "depois_dos_dois_pontos":
        corpo = msg.split(": ", 1)[1] if ": " in msg else msg
        return [_limpo(d) for d in corpo.split("; ") if d.strip()], None
    if modo == "ti":
        return ([f"Para a TI: {_limpo(msg, 200)}"] if msg else []), None
    if modo == "msg":
        return ([_limpo(_RE_HORAS.sub("", msg) if horas is not None else msg)] if msg else []), horas
    if modo == "texto":
        return ([_limpo(msg, 400)] if msg else []), None
    return [], horas


def _tempo(horas):
    if horas is None:
        return ""
    return f" (há {horas // 24} dias)" if horas >= 72 else f" (há {horas} h)"


def descricao(blocos) -> str:
    """Texto do Portal para uma NF. `blocos` = [(tipo, [(mensagem, detalhe), ...])], na ordem das causas. Por tipo:

        O que aconteceu.
        • tópico
        O que fazer: quem faz o quê.

    Mais de um tipo na mesma NF: um bloco por tipo, separados por uma linha em branco."""
    partes = []
    for tipo, alertas in blocos:
        itens, maior = [], None
        detalhe = alertas[0][1] if alertas else ""
        for msg, det in alertas:
            tops, horas = topicos(tipo, msg, det)
            if horas is not None:
                maior = max(maior or 0, horas)
            for t in tops:
                if t not in itens:
                    itens.append(t)
        linhas = [titulo(tipo)]
        mostra = itens[:_MAX_TOPICOS]
        if maior is not None:       # um "há N h" só por bloco: no 1º tópico ou, sem tópico, no fim da frase
            if mostra:
                mostra[0] += _tempo(maior)
            else:
                linhas[0] = linhas[0].rstrip(".") + _tempo(maior) + "."
        linhas += [f"• {t}" for t in mostra]
        if len(itens) > len(mostra):
            linhas.append(f"• e mais {len(itens) - len(mostra)}")
        linhas.append(f"O que fazer: {acao(tipo, detalhe)}")
        partes.append("\n".join(linhas))
    return "\n\n".join(partes)


# ------------------------------------------------------------------ log mestre (feed.py): frase + o que fazer
# 12/11/2026: o Portal mostrava "PDF não encontrado na pasta de rede (2ª tentativa)" -- "2ª tentativa" é coisa do robô e
# "PDF" é a DANFE. Mesmo padrão dos alertas da Unilog: a frase diz o que falta, o "O que fazer" diz quem age.
# {detalhe} = situação do log, código ou nome da transportadora.
_AVISAR_TI = "Logística não precisa agir: avisar o Marcelo ou o Vitor"
_DEPOIS = "Depois o robô sobe a nota sozinho na rodada seguinte"
_LOG = {
    "FALTA_XML_DANFE": ("Faltam o XML e a DANFE (PDF da nota) na pasta NF-SAP.",
                        f"Faturamento: salvar o XML e a DANFE da nota na pasta NF-SAP da filial. {_DEPOIS}"),
    "FALTA_XML": ("Falta o XML da nota na pasta NF-SAP.",
                  f"Faturamento: salvar o XML da nota na pasta NF-SAP da filial. {_DEPOIS}"),
    "FALTA_DANFE": ("Falta a DANFE (PDF da nota) na pasta NF-SAP.",
                    f"Faturamento: salvar a DANFE em PDF na pasta NF-SAP da filial. {_DEPOIS}"),
    "ARQUIVO_IO": ("O robô não conseguiu copiar os arquivos da nota ({detalhe}).",
                   f"{_AVISAR_TI} se continuar na rodada seguinte"),
    "ETIQUETA_CORREIOS": ("A etiqueta dos Correios não foi gerada.",
                          "Logística: conferir o cadastro do cliente no SAP (endereço e CEP) e corrigir; se estiver certo, "
                          "avisar o Marcelo ou o Vitor. O robô gera a etiqueta sozinho na rodada seguinte"),
    "BOLETO_AUSENTE": ("Falta o boleto na pasta NF-SAP.",
                       "Financeiro: emitir o boleto no SAP e salvar na pasta NF-SAP da filial; se a nota não tem boleto, "
                       f"usar \"Ignorar boleto\" no Portal. {_DEPOIS}"),
    "B4YOU_SALDO": ("Sem saldo na B4You: o pedido sobe quando o estoque entrar.", "Logística: conferir o estoque com a B4You"),
    "B4YOU_CADASTRO": ("Item sem cadastro no catálogo da B4You.", "Logística: pedir à B4You o cadastro do item"),
    "B4YOU_DUPLICIDADE": ("A B4You disse que o pedido já existe, mas ele não foi encontrado.", _AVISAR_TI),
    "B4YOU_FALHA": ("A nota não foi enviada à B4You (situação: {detalhe}).", _AVISAR_TI),
    "B4YOU_ANEXO_BOLETO": ("O boleto não foi enviado à B4You (situação: {detalhe}).", _AVISAR_TI),
    "B4YOU_ANEXO_ETIQUETA": ("A etiqueta não foi enviada à B4You (situação: {detalhe}).", _AVISAR_TI),
    "TRANSP_NAO_INFORMADA": ("A nota está sem a transportadora no SAP.",
                             "Logística: pedir ao Faturamento para informar a transportadora na nota no SAP. Depois o robô "
                             "manda o e-mail sozinho"),
    "TRANSP_INVALIDA": ("O código de transportadora {detalhe} não existe (provável erro de digitação no SAP).",
                        "Logística: pedir ao Faturamento para corrigir a transportadora na nota no SAP. Depois o robô manda "
                        "o e-mail sozinho"),
    "EMAIL_TRANSP_FALHA": ("O e-mail para a {detalhe} não saiu.",
                           "Logística não precisa agir: o robô tenta de novo; se continuar, avisar o Marcelo ou o Vitor"),
}
# começo do parágrafo B4YOU_FALHA: o coletor tira este parágrafo quando o robô da Unilog explica a NF
INICIO_B4YOU_FALHA = _LOG["B4YOU_FALHA"][0].split(" (")[0]


def textos_log() -> dict:
    return dict(_LOG)


def texto_log(chave, detalhe="") -> str:
    """Texto do Portal para uma causa do log mestre: "frase\\nO que fazer: ..." (feed.classificar)."""
    frase, quem = _LOG[chave]
    return f"{frase.format(detalhe=detalhe)}\nO que fazer: {quem}"


# ------------------------------------------------------------------ nome curto (etiqueta do card no Portal)
# 12/11/2026 (Marcelo: "O que é esse PDF2Strike? não tem um nome melhor não?"): o card mostrava o problema_codigo. Agora
# mostra um nome curto em português; o código fica no tooltip, no painel da nota e no Excel. A Azure descarta campo novo
# (NotaPortal ignora extras), então o nome não viaja: o front lê static/nomes-alertas.js, gerado de nomes_js().
_NOMES_TIPO = {   # alertas do robô da Unilog (problema_codigo UNILOG_<tipo>)
    "SEM_SALDO": "Sem saldo na Unilog", "PEDIDO_SEM_SALDO": "Sem estoque para separar",
    "SEM_EAN": "Item sem EAN no SAP", "EAN_ALTERADO": "EAN mudou no SAP", "SEM_CADASTRO": "Item sem cadastro na Unilog",
    "CADASTRO_PENDENTE": "Cadastro aguardando a Unilog",
    "PEDIDO_SEM_ARQUIVO": "Falta arquivo da nota", "BILLING_SEM_ARQUIVO": "Falta arquivo da nota",
    "SEM_VOLUMES": "Sem volumes no SAP", "SHARE_NF_SEM_ARQUIVOS": "Pasta NF-SAP parada",
    "NF_CANCELADA_SAP": "Cancelada no SAP", "CANCELAMENTO_SEM_ACAO": "Cancelamento pendente",
    "CANCELAMENTO_MANUAL_PENDENTE": "Cancelar à mão na Unilog", "CANCELADA_NA_UNILOG": "Cancelar à mão na Unilog",
    "CANCELADA_SO_NA_UNILOG": "Cancelada só na Unilog", "ENTRADA_DE_NF_CANCELADA": "Entrada de nota cancelada",
    "ENTRADA_MATRIZ_NF_CANCELADA": "Entrada de nota cancelada",
    "TRANSF_PROPRIA_FILIAL": "Nota para a própria filial",
    "ENTRADA_DIVERGENTE": "Entrada diferente da nota", "ENTRADA_MATRIZ_DIVERGENTE": "Entrada diferente da nota",
    "ENTRADA_IMPORTACAO_DIVERGENTE": "Entrada diferente da nota",
    "ENTRADA_PARADA": "Entrada parada", "ENTRADA_MATRIZ_PARADA": "Entrada parada", "ENTRADA_IMPORTACAO_PARADA": "Entrada parada",
    "ENTRADA_CANCELADA": "Entrada cancelada", "ENTRADA_MATRIZ_CANCELADA": "Entrada cancelada",
    "ENTRADA_IMPORTACAO_CANCELADA": "Entrada cancelada",
    "ENTRADA_MATRIZ_PENDENTE": "Entrada da Matriz pendente", "ENTRADA_IMPORTACAO_PENDENTE": "Entrada de importação pendente",
    "ENTRADA_MATRIZ_RECUSADA": "Entrada recusada", "ENTRADA_IMPORTACAO_RECUSADA": "Entrada recusada",
    "ENTRADA_IMPORTACAO_BLOQUEADA": "Entrada não enviada", "ENTRADA_IMPORTACAO_XML": "XML ilegível",
    "PARADO_EM_2": "Demorando para separar", "PARADO": "Demorando na Unilog", "AGUARDA_EMBARQUE": "Demorando para embarcar",
    "SEPARACAO_DIVERGENTE": "Separação diferente da nota", "EMBARCADO_FORA_DE_4": "Saiu sem liberação",
    "EMBARCADO_NF_DESCONHECIDA": "Nota desconhecida na planilha", "EMBARCADO_ARQUIVO": "Planilha ilegível",
    "FORA_DO_ROBO": "Fora do robô",
    "ETIQUETA_PENDENTE": "Sem etiqueta dos Correios", "ETIQUETA_FALHOU": "Etiqueta dos Correios falhou",
    "NAO_ENVIADA": "Ainda não enviada", "POST_INCERTO": "Envio sem resposta", "POST_INCERTO_SEM_DOC": "Envio sem resposta",
    "POST_INCERTO_SEM_PEDIDO": "Envio não chegou", "POST_RECUSADO": "Recusada pela Unilog",
    "INTEGRADO_COM_ERRO": "Erro na Unilog", "SITUACAO_DESCONHECIDA": "Situação desconhecida",
    "SEM_STATUS": "Sem leitura da Unilog", "DOC_SEM_REGISTRO": "Pedido fora do robô", "CADASTRO_ERRO": "Erro ao ler cadastro",
    "CONFIRMACAO_SEM_ID": "Liberação falhou", "CONFIRMACAO_FALHOU": "Liberação falhou", "BILLING_ERRO": "Fatura recusada",
    "CLASSE_PELA_REGRA": "Kit fora do padrão", "REENVIO_NAO_LIBERADO": "Reenvio não liberado",
    "REQUEST_ID_DIVERGENTE": "Pedido de outra nota",
    "ENTRADA_COM_ERRO": "Entrada com erro", "ENTRADA_MATRIZ_COM_ERRO": "Entrada com erro",
    "ENTRADA_IMPORTACAO_COM_ERRO": "Entrada com erro",
    "ENTRADA_CONFIRMACAO_FALHOU": "Entrada não confirmada", "ENTRADA_MATRIZ_CONFIRMACAO_FALHOU": "Entrada não confirmada",
    "ENTRADA_IMPORTACAO_CONFIRMACAO_FALHOU": "Entrada não confirmada",
    "ENTRADA_SEM_NF": "Entrada sem nota no SAP", "ENTRADA_CLASSE_DESCONHECIDA": "Entrada sem classe",
    "ENTRADA_POST_FALHOU": "Envio da entrada falhou",
    "ENTRADA_INCERTA": "Entrada sem resposta", "ENTRADA_MATRIZ_INCERTA": "Entrada sem resposta",
    "ENTRADA_IMPORTACAO_INCERTA": "Entrada sem resposta",
    "RETORNO_CONFIRMACAO_FALHOU": "Retorno não confirmado", "ENTRADA_MATRIZ_SEM_NF": "Nota da Matriz incompleta",
    "SEM_ESTADO": "Portal sem dados do robô", "ESTADO_VELHO": "Robô parado", "ENVIO_PARADO": "Envio parado",
    "FATURA_PARADA": "Fatura parada", "FATURA_SEM_RESPOSTA": "Fatura sem resposta",
}
NOMES = {   # os outros motores do Portal: log mestre (feed.py), SAP (sap_feed), cancelamento (canc_feed), marketing
    "XML_2STRIKE": "Falta XML", "PDF_2STRIKE": "Falta DANFE", "ARQUIVO_IO": "Erro ao copiar arquivos",
    "ETIQUETA_CORREIOS": "Sem etiqueta dos Correios", "BOLETO_AUSENTE": "Falta boleto",
    "B4YOU_SALDO": "Sem saldo na B4You", "B4YOU_CADASTRO": "Sem cadastro na B4You", "B4YOU_DUPLICIDADE": "Duplicada na B4You",
    "B4YOU_FALHA": "Não enviada à B4You", "B4YOU_ANEXO_BOLETO": "Boleto não foi à B4You",
    "B4YOU_ANEXO_ETIQUETA": "Etiqueta não foi à B4You",
    "TRANSP_NAO_INFORMADA": "Sem transportadora", "TRANSP_INVALIDA": "Transportadora inválida",
    "EMAIL_TRANSP_FALHA": "E-mail à transportadora falhou",
    "TRANSFERENCIA_ATRASADA": "Transferência atrasada", "FALTA_CHAVE": "Sem chave de acesso", "SEFAZ_BARRADA": "Barrada na SEFAZ",
    "USO_IGNORADO": "Utilização fora do robô", "DEPOSITO_BLOQUEADO": "Depósito bloqueado",
    "CANC_ENVIADA_NAO_LOCALIZADA": "Cancelada, não achada na B4You", "CANC_JA_EXPEDIDA": "Cancelada, mas já saiu",
    "CANC_PENDENTE_B4YOU": "Cancelar na B4You", "MARKETING_ETIQUETA": "Etiqueta de marketing",
}
# O mesmo código com nome mais preciso conforme o 1º parágrafo do texto (a causa principal da NF)
VARIANTES = {
    "XML_2STRIKE": [("DANFE", "Falta XML e DANFE")],
    "UNILOG_BILLING_SEM_ARQUIVO": [("Falta o boleto", "Falta boleto")],
    "UNILOG_PEDIDO_SEM_ARQUIVO": [("Falta o boleto", "Falta boleto")],
}


def nomes() -> dict:
    """{problema_codigo: nome curto} de todos os códigos conhecidos (UNILOG_<tipo> + os outros motores)."""
    out = {f"UNILOG_{t}": n for t, n in _NOMES_TIPO.items()}
    out.update({"UNILOG_RECUSADO": _NOMES_TIPO["POST_RECUSADO"], "UNILOG_ERRO_INTEGRACAO": _NOMES_TIPO["INTEGRADO_COM_ERRO"]})
    out.update(NOMES)
    return out


def nome_codigo(codigo, descricao="") -> str:
    """Nome curto da etiqueta. Código desconhecido volta como veio (o Portal mostra o código, como antes)."""
    codigo = str(codigo or "")
    principal = str(descricao or "").split("\n\n")[0]
    for trecho, nome in VARIANTES.get(codigo, []):
        if trecho in principal:
            return nome
    return nomes().get(codigo, codigo)


def nomes_js() -> str:
    """static/nomes-alertas.js do Portal (gerado por tools/gerar_nomes_alertas.py do front; não editar à mão)."""
    import json
    return ("// Gerado de alertas_texto.py (logistica_pharma) por tools/gerar_nomes_alertas.py. Não editar à mão.\n"
            "// Nome curto da etiqueta do card no lugar do problema_codigo (12/11/2026).\n"
            f"window.NOMES_ALERTA = {json.dumps(nomes(), ensure_ascii=False, indent=1, sort_keys=True)};\n"
            f"window.NOMES_ALERTA_VARIANTES = {json.dumps(VARIANTES, ensure_ascii=False, indent=1, sort_keys=True)};\n"
            "// Pontos de atenção (12/11/2026): a categoria que fica fora das Travadas e a frase do bloco (a mesma do e-mail).\n"
            f"window.ALERTA_ATENCAO = {json.dumps({'categoria': ATENCAO, 'texto': TEXTO_ATENCAO}, ensure_ascii=False)};\n")
