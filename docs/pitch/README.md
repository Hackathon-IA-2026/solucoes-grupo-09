# Pitch do WattSteer

Esta pasta tem o deck do pitch e tudo que o produz: o build que gera os slides e a fala juntos, os
checkpoints, a montagem do `.pptx` e do `.mp4`, as personas da banca simulada e o estado do ciclo com o
time no Discord.

**O guia de uso é a skill `wattsteer-pitch`** (em `tools/skill/wattsteer-pitch/SKILL.md`). Ela explica o
processo inteiro: como nasce uma versão nova, o que cada script faz, as regras que não se negociam e as
armadilhas que já custaram tempo. Para ler e escrever no Discord, a skill é a `discord-chrome`.

## Começando do zero em outra máquina

```bash
# tudo de uma vez (sobe o daemon, gera, confere e monta a entrega)
cd docs/pitch && ./gerar.sh 37
```

Ou passo a passo:

```bash
# 1. daemon do Chrome (precisa do Chrome aberto e logado no Discord)
curl -s -m 3 127.0.0.1:9333/list >/dev/null || (nohup node tools/cdpd.mjs > /tmp/cdpd.log 2>&1 &)

# 2. gerar o deck da versão atual
cd docs/pitch
python3 build_2026_v37.py

# 3. checkpoints
python3 clareza.py wattsteer-pitch-2026-v37.html
python3 legibilidade.py wattsteer-pitch-2026-v37.html

# 4. prints (é o que a banca simulada lê) e entrega
python3 shots_wide.py wattsteer-pitch-2026-v37.html /tmp/v37png
python3 layers.py wattsteer-pitch-2026-v37.html /tmp/v37lay
python3 build_entrega.py /tmp/v37lay roteiro-pitch-2026-v37.md WattSteer-Pitch-v37
python3 render.py wattsteer-pitch-2026-v37.html WattSteer-Pitch-v37.pdf
```

Precisa de Python 3, ffmpeg, Node e o Chrome logado. O `build_2026_vNN.py` é a fonte de verdade: o HTML e
o roteiro são gerados, então **editar o HTML à mão não adianta**.

## Onde está o resto

| O quê | Onde |
|---|---|
| Estado do ciclo com o time | `pitch_estado.md` |
| Personas da banca simulada | `jurados/` |
| Regras de clareza e o protocolo da banca | `CHECKPOINT-CLAREZA.md` |
| Último resultado da banca | `banca-v37.md` |
| Fala independente dos slides | `narrativa-apresentacao-v1.md` |
| O que compõe a nota da banca real | `rubrica-nota-10.md` |
