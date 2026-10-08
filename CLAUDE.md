# auuii-core

Stack de casa (PC Kali, por Tailscale): Evolution (WhatsApp), n8n (IAs Duda e Nina) e a ponte.
Documentação técnica em `docs/` (WhatsApp/IA: `docs/ATENDIMENTO.md`).

## Nina (IA do WhatsApp da Goby) — regras do dono

- **O fluxo da Nina só muda pelo gerador.** Edite `n8n/geradores/nina_goby.py` e rode
  `python n8n/geradores/nina_goby.py`. Não edite `n8n/workflows/atendimento-goby-nina.json` à
  mão nem só no editor do n8n: o próximo que rodar o gerador apaga a mudança. O gerador para
  antes de gravar se a integridade quebrar.
- **Toda função da Nina tem uma nota no Obsidian** (`C:\Users\LENOVO\Documents\Celebro 2\nina\`):
  a nota central `Nina.md` (tabela de funções) e uma nota por função em `Funções/`, com o campo
  `ferramentas:` no topo. Criou ou mudou uma função (ferramenta, regra, texto fixo, fluxo novo),
  atualize a nota dela no mesmo trabalho. O gerador roda `n8n/geradores/checa_obsidian_nina.py`
  no fim e avisa o que ficou pra trás; rode também à mão.
- O JS do nó "Monta contexto" vive num f-string do Python: `\n` no JS é `\\n` no gerador e
  `{ }` viram `{{ }}`. Teste o JS gerado com `node` antes de publicar.
- Trava do financeiro: nenhuma resposta da Nina tem valor em R$.
- Chaves só no `.env` do Kali (com `read -rs`), nunca em chat, compose ou nota.
- Publicar no Kali e testar sem mandar WhatsApp: ver `Celebro 2/nina/Como mudar e publicar a Nina.md`.
