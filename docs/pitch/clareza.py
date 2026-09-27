"""Checkpoint de clareza do pitch (regra do Guilherme, 26/09): a banca não é técnica,
então todo texto visível precisa ser entendido por pessoas de qualquer idade, setor e experiência.

Uso: python3 clareza.py wattsteer-pitch-final-vN.html
Aponta, por slide: jargão técnico, siglas sem explicação no próprio slide e frases longas.
Sai com código 1 se houver pendência (a versão não vai para o time assim).
O rodapé de fontes (.fontes) fica fora da checagem: ali a sigla é referência, não mensagem.
"""
import re
import sys
from html.parser import HTMLParser

# Termos que um leigo não entende. Valor = sugestão de troca.
JARGAO = {
    'lightgbm': 'modelo de previsão', 'shap': 'explicação do porquê', 'milp': 'cálculo de otimização',
    'relaxação lp': 'versão simplificada do cálculo', 'hurdle': '(tirar)', 'quantis': 'faixa de valores',
    'conformaliz': 'faixa com margem de erro medida', 'p10': 'cenário otimista/pessimista',
    'p50': 'valor mais provável', 'p90': 'cenário pessimista', 'features': 'sinais usados pelo modelo',
    'dessem': 'programa de despacho do ONS (explicar)', 'json': 'registro completo', 'api': 'integração',
    'mwmed': 'MW médios (explicar)', 'cust': 'contrato de conexão', 'expne': 'limite de exportação',
    'constrained-off': 'corte com direito a compensação', 'lrcap': 'leilão de baterias',
    'bess': 'baterias', 'eust': 'tarifa que paga o ONS', 'rol': 'receita', 'safra do dado': 'data do dado',
    'limiar': 'valor mínimo', 'intercâmbio': 'troca de energia entre regiões', 'subsistema': 'região',
    'submercado': 'região', 'replay': 'simulação com dias reais', 'fora da amostra': 'dias que o modelo não viu',
    'rastreabil': 'dá para conferir a origem', 'hedge': 'proteção', 'rating': 'nota de risco',
    'covenant': 'cláusula do contrato', 'mmgd': 'painéis solares em casas e empresas', 'pld': 'preço da energia',
    'cmo': 'custo da energia', 'p&d': 'programa de pesquisa', 'ena': '', 'semi-hor': 'a cada meia hora',
    'despacho': 'ordem de produzir energia', 'carga deslocável': 'consumo que pode mudar de horário',
    'carga flexível': 'consumo que pode mudar de horário', 'curtailment': 'corte de geração',
    'mw médios': 'explicar com comparação', 'mvp': 'protótipo funcionando', 'twh': 'bilhões de kWh (dar escala)',
}
# Siglas aceitas sem explicação (público geral conhece ou o slide já nomeia a instituição).
SIGLAS_OK = {'EQUIPE', 'SITE', 'ESTÁGIO', 'ONS', 'ANEEL', 'MW', 'GW', 'IA', 'R$', 'NE', 'RN', 'CE', 'BA', 'PI', 'BNDES', 'BNB', 'COPPE', 'TAESA', 'EPE', 'CCEE', 'MME', 'SP', 'RJ', 'PT'}
MAX_PALAVRAS_FRASE = 16  # frases curtas (João Vitor e Guilherme, 26/09 23:10)
# 3 minutos, uma ideia por slide: o slide complementa quem apresenta ("não compramos ingresso para o filme")
MAX_PALAVRAS_SLIDE = 60  # v27 (26/09 23:10): menos texto; o slide continua funcionando sozinho, o excedente vai para a fala


class Slides(HTMLParser):
    def __init__(self):
        super().__init__()
        self.slides, self.depth_skip, self.stack = [], 0, []

    def handle_starttag(self, tag, attrs):
        cls = dict(attrs).get('class', '') or ''
        if tag == 'section' and 'slide' in cls.split():
            self.slides.append([])
        # fontes e mapa são referência; os cards .tm são as bios escritas por cada integrante (não reescrever)
        skip = tag in ('style', 'script', 'svg') or bool({'fontes', 'capamapa', 'tm'} & set(cls.split()))
        self.stack.append(skip)
        if skip:
            self.depth_skip += 1

    def handle_endtag(self, tag):
        if self.stack and self.stack.pop():
            self.depth_skip -= 1

    def handle_data(self, data):
        if self.slides and not self.depth_skip and data.strip():
            self.slides[-1].append(data.strip())


def checar(texto):
    achados = []
    baixo = texto.lower()
    for termo, troca in JARGAO.items():
        # termo explicado logo em seguida entre parênteses, ex.: "35 TWh (bilhões de kWh)", passa
        fim = r'(?![a-zà-ú])' if len(termo) <= 5 else ''  # termo curto só vale como palavra inteira ("cust" não pega "custa")
        if termo and re.search(r'(?<![a-zà-ú])' + re.escape(termo) + fim + r'(?![a-zà-ú]*\s*\()', baixo):
            achados.append(f'jargão "{termo}"' + (f' → {troca}' if troca else ''))
    for sigla in sorted(set(re.findall(r'\b[A-Z][A-Z0-9&]{1,}\b', texto)) - SIGLAS_OK):
        if not re.search(re.escape(sigla) + r'\s*\(', texto) and not re.search(r'\(\s*' + re.escape(sigla), texto):
            achados.append(f'sigla sem explicação "{sigla}"')
    return achados


def frases_longas(partes):
    achados = []
    for parte in partes:
        for frase in re.split(r'(?<=[.!?:;])\s+', parte):
            n = len(frase.split())
            if n > MAX_PALAVRAS_FRASE:
                achados.append(f'frase com {n} palavras: "{frase[:70]}..."')
    return achados


def main():
    p = Slides()
    p.feed(open(sys.argv[1], encoding='utf-8').read())
    total = 0
    for i, partes in enumerate(p.slides, 1):
        achados = checar(' '.join(partes)) + frases_longas(partes)
        n = len(' '.join(partes).split())
        if n > MAX_PALAVRAS_SLIDE * 1.10:  # tolerância de 10% (Guilherme, 26/09 23:16)
            achados.append(f'{n} palavras no slide (máximo {MAX_PALAVRAS_SLIDE}): uma ideia por slide, o resto vai para o roteiro')
        total += len(achados)
        print(f'\nSlide {i}: ' + ('ok' if not achados else f'{len(achados)} pendência(s)'))
        for a in achados:
            print('  -', a)
    print(f'\nTOTAL: {total} pendência(s)' + ('' if total else ' · passou na varredura automática'))
    sys.exit(1 if total else 0)


if __name__ == '__main__':
    main()
