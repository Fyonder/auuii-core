# -*- coding: utf-8 -*-
"""
Monta os GUIAS DA NINA por público (motoboy, restaurante, suporte) a partir das notas de função
do Obsidian (Celebro 2/nina/Funções). Pedido do dono (10/10/2026): "um padrão das funções da
Nina, detalhado, pra explicar pra cada um — motoboys, suportes — e ir atualizando de acordo
que as novas ferramentas vão surgindo".

O PADRÃO (ver `Celebro 2/nina/Modelo - nota de função.md`): toda nota de função tem
  - no topo, `publico: [motoboy, restaurante, suporte]` (só quem usa ou precisa saber);
  - a seção `## 📣 Como explicar`, com um `### 🛵 Pro motoboy`, `### 🏪 Pro restaurante` e/ou
    `### 🎧 Pro suporte` pra cada público listado. Linguagem de quem vai ler: motoboy e loja sem
    termo técnico; suporte com o que fazer.

Os guias saem em `Celebro 2/nina/Guias/` e NÃO se editam à mão: mude a nota e rode
    python n8n/geradores/guias_nina.py
O gerador da Nina (nina_goby.py) roda este script no fim, e o checa_obsidian_nina.py acusa nota
sem a seção ou guia desatualizado.

Ordem das funções = ordem da tabela de Nina.md. Status da nota:
  no-ar, parcial, desligada → entram no guia; pronto, pronto-falta-publicar → "Em breve";
  substituido → fora.
"""
import os
import re
import sys
from pathlib import Path

COFRE = Path(os.environ.get('NINA_OBSIDIAN', r'C:\Users\LENOVO\Documents\Celebro 2\nina'))
SECAO = '## 📣 Como explicar'

PUBLICOS = {
    'motoboy': {
        'titulo': '### 🛵 Pro motoboy',
        'arquivo': 'Guia da Nina - Motoboy.md',
        'cabeca': (
            '# 🛵 Guia da Nina — pro motoboy\n\n'
            'A **Nina** é a assistente da Goby no WhatsApp. Ela te reconhece pelo número do seu cadastro e '
            'responde na hora, de dia e de noite, com os **seus** dados (nunca os de outro motoboy).\n\n'
            '> [!tip] Como falar com ela\n'
            '> - Escreva como fala com alguém da equipe: "quais corridas estão comigo?", "tenho vaga hoje?".\n'
            '> - Pode mandar em várias mensagens: ela espera uns segundos e responde tudo junto.\n'
            '> - Ela só entende **texto** (áudio e foto ela não abre).\n'
            '> - Valores e pagamentos são sempre com a equipe: ela não fala de dinheiro.\n'
            '> - Precisa de gente? Diga "quero falar com um atendente". A resposta vem por aqui mesmo.\n'
        ),
    },
    'restaurante': {
        'titulo': '### 🏪 Pro restaurante',
        'arquivo': 'Guia da Nina - Restaurante.md',
        'cabeca': (
            '# 🏪 Guia da Nina — pro restaurante\n\n'
            'A **Nina** é a assistente da Goby no WhatsApp e no chat do site. Ela reconhece a loja (pelo CNPJ '
            'ou pelo email do login) e mostra **só os pedidos da sua loja**.\n\n'
            '> [!tip] Como falar com ela\n'
            '> - Escreva normal: "quais pedidos estão em andamento?", "cadê o pedido 1234?".\n'
            '> - Ela só entende **texto**.\n'
            '> - Valores, taxas e cobrança são com a equipe: ela não fala de dinheiro.\n'
            '> - Precisa de gente? Diga "quero falar com um atendente".\n'
        ),
    },
    'suporte': {
        'titulo': '### 🎧 Pro suporte',
        'arquivo': 'Guia da Nina - Suporte.md',
        'cabeca': (
            '# 🎧 Guia da Nina — pro suporte\n\n'
            'O que a Nina faz sozinha, o que ela passa pra vocês e como usar ela como **ferramenta de consulta** '
            '(WhatsApp do suporte ou botão **Nina** no Goby Suporte, com as suas permissões).\n\n'
            '> [!tip] O básico\n'
            '> - Quando ela chama gente, a conversa acende **"Precisa de humano"** na aba Atendimento, os números '
            'da equipe recebem o aviso com o **RESUMO**, e ela fica **pausada 20 min** naquela conversa.\n'
            '> - Respondeu pelo painel, ela pausa de novo (20 min, renova a cada mensagem).\n'
            '> - Ela nunca fala de dinheiro, nem com vocês.\n'
            '> - O detalhe técnico de cada função está na nota dela, em `Celebro 2/nina/Funções`.\n'
        ),
    },
}
NO_GUIA = {'no-ar', 'parcial', 'desligada'}
EM_BREVE = {'pronto', 'pronto-falta-publicar'}
FORA = {'substituido'}


def frontmatter(texto):
    m = re.match(r'^---\n(.*?)\n---\n', texto, re.S)
    if not m:
        return {}
    campos = {}
    for linha in m.group(1).splitlines():
        if ':' in linha:
            k, v = linha.split(':', 1)
            campos[k.strip()] = v.strip()
    return campos


def lista(valor):
    valor = (valor or '').strip()
    if not (valor.startswith('[') and valor.endswith(']')):
        return []
    return [x.strip().strip('"\'') for x in valor[1:-1].split(',') if x.strip()]


def blocos(texto):
    """A seção Como explicar → { publico: texto do bloco } (sem o título do bloco)."""
    if SECAO not in texto:
        return {}
    corpo = texto.split(SECAO, 1)[1]
    corpo = re.split(r'^## ', corpo, maxsplit=1, flags=re.M)[0]
    saida = {}
    for pub, cfg in PUBLICOS.items():
        if cfg['titulo'] in corpo:
            b = corpo.split(cfg['titulo'], 1)[1]
            b = re.split(r'^### ', b, maxsplit=1, flags=re.M)[0]
            saida[pub] = b.strip()
    return saida


def titulo_da_nota(texto, nome):
    m = re.search(r'^# (.+)$', texto, re.M)
    return m.group(1).strip() if m else nome


def ordem_da_tabela():
    central = (COFRE / 'Nina.md').read_text(encoding='utf-8')
    return re.findall(r'^\| \[\[([^\]|]+)', central, re.M)


def ler_funcoes():
    funcoes = {}
    for p in sorted((COFRE / 'Funções').glob('*.md')):
        texto = p.read_text(encoding='utf-8')
        fm = frontmatter(texto)
        funcoes[p.stem] = {
            'status': fm.get('status', ''),
            'publico': lista(fm.get('publico')),
            'titulo': titulo_da_nota(texto, p.stem),
            'blocos': blocos(texto),
        }
    return funcoes


def problemas_do_padrao(funcoes):
    """Notas fora do padrão (o checa_obsidian_nina.py usa)."""
    saida = []
    for nome, f in funcoes.items():
        if f['status'] in FORA:
            continue
        if not f['publico']:
            saida.append(f'nota "{nome}" sem `publico:` no topo (motoboy, restaurante, suporte)')
            continue
        for pub in f['publico']:
            if pub not in PUBLICOS:
                saida.append(f'nota "{nome}": público desconhecido "{pub}"')
            elif not f['blocos'].get(pub):
                saida.append(f'nota "{nome}" sem "{PUBLICOS[pub]["titulo"]}" em "{SECAO}"')
    return saida


def montar(funcoes):
    """{ arquivo: texto } dos três guias."""
    ordem = [n for n in ordem_da_tabela() if n in funcoes] + sorted(n for n in funcoes if n not in ordem_da_tabela())
    guias = {}
    for pub, cfg in PUBLICOS.items():
        no_ar, breve = [], []
        for nome in ordem:
            f = funcoes[nome]
            bloco = f['blocos'].get(pub)
            if f['status'] in FORA or pub not in f['publico'] or not bloco:
                continue
            item = f'## {f["titulo"]}\n\n{bloco}\n'
            (breve if f['status'] in EM_BREVE else no_ar).append(item)
        partes = [
            '---\n'
            f'tags: [nina, guia, {pub}]\n'
            'gerado: n8n/geradores/guias_nina.py\n'
            '---\n\n'
            '> [!warning] Gerado automaticamente\n'
            '> Não edite aqui: mude a seção "📣 Como explicar" da nota da função (pasta `Funções`) e rode '
            '`python n8n/geradores/guias_nina.py` no auuii-core.\n\n',
            cfg['cabeca'],
            '\n---\n\n',
            '\n'.join(no_ar) if no_ar else '_Nada ainda._\n',
        ]
        if breve:
            partes += ['\n---\n\n# 🔜 Em breve\n\n> [!note] Pronto, falta publicar. Ainda **não** funciona.\n\n', '\n'.join(breve)]
        guias[cfg['arquivo']] = ''.join(partes)
    return guias


def guias_desatualizados(funcoes):
    pasta = COFRE / 'Guias'
    return [arq for arq, texto in montar(funcoes).items()
            if not (pasta / arq).exists() or (pasta / arq).read_text(encoding='utf-8') != texto]


def main():
    if not COFRE.exists():
        print(f'cofre não encontrado: {COFRE}')
        return 1
    funcoes = ler_funcoes()
    pasta = COFRE / 'Guias'
    pasta.mkdir(exist_ok=True)
    for arq, texto in montar(funcoes).items():
        (pasta / arq).write_text(texto, encoding='utf-8')
    fora = problemas_do_padrao(funcoes)
    contagem = {pub: sum(1 for f in funcoes.values() if f['status'] not in FORA and pub in f['publico']) for pub in PUBLICOS}
    print(f'guias da Nina: ' + ', '.join(f'{pub} {n} funções' for pub, n in contagem.items()) + f' → {pasta}')
    if fora:
        print('Notas fora do padrão "Como explicar":')
        for p in fora:
            print('  -', p)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
