# -*- coding: utf-8 -*-
"""
Confere se o Obsidian da Nina (Celebro 2/nina) acompanha o fluxo do n8n.

Regra do dono (04/10/2026): toda função da Nina tem uma nota; mudou ou criou função, atualiza
a nota. Este script acusa:
  - ferramenta do fluxo que não aparece no campo `ferramentas:` de nenhuma nota;
  - nota que cita ferramenta que não existe mais no fluxo;
  - nota de função que não está na tabela da nota central (Nina.md);
  - fluxo da Nina (ex.: aviso de vaga) sem nota que cite o arquivo.

Uso:  python n8n/geradores/checa_obsidian_nina.py
      NINA_OBSIDIAN=<pasta> pra outro cofre. Sai com código 1 se faltar algo.
"""
import json
import os
import re
import sys
from pathlib import Path

RAIZ = Path(__file__).resolve().parents[2]
COFRE = Path(os.environ.get('NINA_OBSIDIAN', r'C:\Users\LENOVO\Documents\Celebro 2\nina'))
FLUXO = RAIZ / 'n8n' / 'workflows' / 'atendimento-goby-nina.json'
OUTROS_FLUXOS = ['goby-vez-na-fila.json']


def ferramentas_do_fluxo():
    f = json.loads(FLUXO.read_text(encoding='utf-8'))
    return sorted(n['name'] for n in f['nodes'] if n['type'].endswith('httpRequestTool') or n['type'].endswith('Tool'))


def notas():
    saida = {}
    for p in sorted((COFRE / 'Funções').glob('*.md')):
        texto = p.read_text(encoding='utf-8')
        m = re.search(r'^ferramentas:\s*\[(.*?)\]\s*$', texto, re.M)
        lista = [x.strip().strip('"\'') for x in m.group(1).split(',')] if m and m.group(1).strip() else []
        saida[p.stem] = {'ferramentas': lista, 'texto': texto}
    return saida


def main():
    if not COFRE.exists():
        print(f'cofre não encontrado: {COFRE}')
        return 1
    problemas = []
    tools = ferramentas_do_fluxo()
    ns = notas()
    citadas = {t: nome for nome, n in ns.items() for t in n['ferramentas']}
    for t in tools:
        if t not in citadas:
            problemas.append(f'ferramenta sem nota: "{t}" (ponha em `ferramentas:` da nota da função)')
    for t, nome in citadas.items():
        if t not in tools:
            problemas.append(f'nota "{nome}" cita "{t}", que não existe mais no fluxo')
    central = (COFRE / 'Nina.md').read_text(encoding='utf-8')
    for nome in ns:
        if f'[[{nome}]]' not in central and f'[[{nome}|' not in central:
            problemas.append(f'função "{nome}" não está na tabela de Nina.md')
    todas = '\n'.join(n['texto'] for n in ns.values())
    for arq in OUTROS_FLUXOS:
        if (RAIZ / 'n8n' / 'workflows' / arq).exists() and arq not in todas and arq.replace('.json', '') not in todas:
            problemas.append(f'fluxo {arq} sem nota que o cite')
    if problemas:
        print('Obsidian da Nina DESATUALIZADO:')
        for p in problemas:
            print('  -', p)
        return 1
    print(f'ok: {len(tools)} ferramentas e {len(ns)} funções documentadas em {COFRE}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
