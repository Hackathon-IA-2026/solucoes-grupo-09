#!/bin/bash
# Gera uma versão do pitch do começo ao fim: deck, checkpoints, prints, animação, .pptx, .mp4 e .pdf.
#
# Uso, de dentro de docs/pitch:   ./gerar.sh 38
#
# Para no primeiro erro. Os prints ficam em /tmp/vNNpng: olhe slide por slide antes de mandar para o time,
# porque nenhum checkpoint pega texto que vaza para fora do slide ou coluna desequilibrada.
set -euo pipefail

V="${1:-}"
[ -z "$V" ] && { echo "uso: ./gerar.sh <número da versão>   (exemplo: ./gerar.sh 38)"; exit 1; }

BUILD="build_2026_v$V.py"
HTML="wattsteer-pitch-2026-v$V.html"
ROTEIRO="roteiro-pitch-2026-v$V.md"
SAIDA="WattSteer-Pitch-v$V"
PNG="/tmp/v${V}png"
LAY="/tmp/v${V}lay"

[ -f "$BUILD" ] || { echo "não achei $BUILD. Comece copiando a versão anterior: cp build_2026_v37.py $BUILD"; exit 1; }

echo "== daemon do Chrome =="
curl -s -m 3 127.0.0.1:9333/list >/dev/null || (nohup node ../../tools/cdpd.mjs > /tmp/cdpd.log 2>&1 & sleep 4)
curl -s -m 3 127.0.0.1:9333/list >/dev/null || {
  echo "daemon não subiu. No Chrome, abra chrome://inspect/#remote-debugging e marque 'Allow remote debugging'."; exit 1; }

echo "== deck e roteiro =="
python3 "$BUILD"

echo "== checkpoints =="
python3 clareza.py "$HTML"
python3 legibilidade.py "$HTML"

echo "== prints (olhe um por um antes de publicar) =="
python3 shots_wide.py "$HTML" "$PNG"

echo "== camadas e entrega =="
python3 layers.py "$HTML" "$LAY"
python3 build_entrega.py "$LAY" "$ROTEIRO" "$SAIDA"
python3 render.py "$HTML" "$SAIDA.pdf"

echo
echo "pronto:"
echo "  prints  $PNG"
echo "  deck    $SAIDA.pptx · $SAIDA.mp4 · $SAIDA.pdf"
echo "  fala    $ROTEIRO"
echo
echo "antes de publicar: olhe os prints, rode a banca simulada (jurados/banca-simulada.md) e publique o resultado."
