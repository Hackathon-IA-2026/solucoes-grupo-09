"""Encaixa o vídeo do time (reel) no lugar do slide de demonstração dentro do .mp4 do deck.

Uso: python3 mp4_com_reel.py <deck.mp4> <reel.mp4> <roteiro.md> <numero_do_slide> <saida.mp4>

O deck é 3840x1080 sem áudio e o reel é 1920x1080 com áudio: o reel entra centralizado, com o mesmo
tamanho de tela, e os trechos do deck recebem uma faixa de áudio silenciosa para a junção ficar contínua.
"""
import re
import subprocess
import sys

W, H, FPS = 3840, 1080, 30


def segundos_do_roteiro(caminho):
    texto = open(caminho, encoding='utf-8').read()
    return [int(x) for x in re.findall(r'^## Slide \d+ · .*\((\d+) s\)$', texto, re.M)]


def main():
    deck, reel, roteiro, slide, saida = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]
    segundos = segundos_do_roteiro(roteiro)
    if not 1 <= slide <= len(segundos):
        sys.exit(f'slide {slide} fora do roteiro (1 a {len(segundos)})')
    inicio = sum(segundos[:slide - 1])
    fim = inicio + segundos[slide - 1]

    escala = f'scale={W}:{H}:force_original_aspect_ratio=decrease,pad={W}:{H}:(ow-iw)/2:(oh-ih)/2:black,fps={FPS},format=yuv420p'
    filtros = [
        f'[0:v]trim=0:{inicio},setpts=PTS-STARTPTS,{escala}[a]',
        f'[1:v]{escala}[v]',
        f'[0:v]trim={fim},setpts=PTS-STARTPTS,{escala}[b]',
        'anullsrc=channel_layout=stereo:sample_rate=48000[sa0]',
        f'[sa0]atrim=0:{inicio},asetpts=PTS-STARTPTS[sa]',
        'anullsrc=channel_layout=stereo:sample_rate=48000[sb0]',
        f'[sb0]atrim=0:{sum(segundos) - fim},asetpts=PTS-STARTPTS[sb]',
        '[a][sa][v][1:a][b][sb]concat=n=3:v=1:a=1[vo][ao]',
    ]
    subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-i', deck, '-i', reel,
                    '-filter_complex', ';'.join(filtros), '-map', '[vo]', '-map', '[ao]',
                    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-c:a', 'aac', '-b:a', '160k', saida], check=True)
    print(f'ok {saida}: deck 0-{inicio} s + reel + deck {fim}-{sum(segundos)} s')


if __name__ == '__main__':
    main()
