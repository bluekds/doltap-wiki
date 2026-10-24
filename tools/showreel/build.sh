#!/usr/bin/env bash
# Build the Doltap Wiki showreels end to end.
#   ./build.sh             everything: v1 (original), music, v1 + music, v2 (+ music)
#   ./build.sh v1|music|v1m|v2|v3|v3en
#   ./build.sh sparse [page.html]   every 10th frame into out/sparse (composition check)
# Pages: showreel.html (v1, SFX-only bed), showreel-v1m.html (v1 with <=3-frame beat nudges, for the
# music mix), showreel-v2.html (dynamic cut, 120 BPM grid). Music: music.py; SFX + mix: sfx.py, mix.py.
set -euo pipefail
cd "$(dirname "$0")"
FF=/opt/homebrew/bin/ffmpeg; FP=/opt/homebrew/bin/ffprobe
mkdir -p out
[ -f logo.js ] || python3 -c "import base64;open('logo.js','w').write('window.LOGO_SRC=\"data:image/png;base64,'+base64.b64encode(open('../../static/logo-512.png','rb').read()).decode()+'\";\n')"

encode() {   # frames_dir out.mp4 [nframes]  (H.264 yuv420p crf 17 +faststart, temporal luma grain ~2 %)
  $FF -y -loglevel error -framerate 30 -i "$1/%04d.png" -vf "noise=c0s=5:c0f=t+u" \
      -c:v libx264 -preset slow -pix_fmt yuv420p -crf 17 -movflags +faststart -r 30 -frames:v "${3:-450}" "$2"
}
mux() {      # video.mp4 audio.wav out.mp4
  $FF -y -loglevel error -i "$1" -i "$2" -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "$3"
}
gif() {      # frames_dir out.gif  (960x540 @ 15 fps, <= 8 MB)
  $FF -y -loglevel error -framerate 30 -i "$1/%04d.png" \
      -vf "fps=15,scale=960:540:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" "$2"
}
gif_v2() {   # v2 moves every pixel every frame (drift + dolly), so: 0.8 px pre-blur, 72 colours, no dither
  $FF -y -loglevel error -framerate 30 -i "$1/%04d.png" \
      -vf "fps=15,scale=960:540:flags=lanczos,gblur=sigma=0.8,split[a][b];[a]palettegen=max_colors=72:stats_mode=diff[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" "$2"
}
probe() { for f in "$@"; do echo "== $f"; $FP -v error -show_entries stream=codec_type,codec_name,width,height,pix_fmt,r_frame_rate,nb_frames,duration:format=duration,size -of compact=p=0:nk=0 "$f"; done; }

build_v1() {
  rm -rf out/frames; python3 render.py --workers 6
  encode out/frames out/doltap-showreel.mp4
  python3 audio.py; mux out/doltap-showreel.mp4 out/sound.wav out/doltap-showreel-audio.mp4
  gif out/frames out/preview.gif; python3 contact.py out/frames out/contact-sheet.png
  probe out/doltap-showreel.mp4 out/doltap-showreel-audio.mp4
}
build_music() { python3 music.py; python3 spectro.py out/music.wav out/music-spectro.png; }
build_v1m() {
  [ -f out/music.wav ] || build_music
  rm -rf out/frames-v1m; python3 render.py --html showreel-v1m.html --out out/frames-v1m --workers 6
  encode out/frames-v1m out/v1m-silent.mp4
  python3 mix.py out/events-showreel-v1m.json out/mix-v1m.wav
  mux out/v1m-silent.mp4 out/mix-v1m.wav out/doltap-showreel-v1-music.mp4
  probe out/doltap-showreel-v1-music.mp4
}
build_v2() {
  [ -f out/music.wav ] || build_music
  rm -rf out/frames-v2; python3 render.py --html showreel-v2.html --out out/frames-v2 --workers 6
  encode out/frames-v2 out/doltap-showreel-v2.mp4
  python3 mix.py out/events-showreel-v2.json out/mix-v2.wav
  mux out/doltap-showreel-v2.mp4 out/mix-v2.wav out/doltap-showreel-v2-music.mp4
  gif_v2 out/frames-v2 out/preview-v2.gif; python3 contact.py out/frames-v2 out/contact-sheet-v2.png "Doltap Wiki showreel v2" 20
  probe out/doltap-showreel-v2.mp4 out/doltap-showreel-v2-music.mp4; ls -la out/preview-v2.gif out/contact-sheet-v2.png
}
build_v3() {   # v1m + 45-frame opening title card: 495 frames = 16.5 s; music shifted by 3 beats + pre-intro
  MUSIC_OFFSET=1.5 MUSIC_OUT=music-v3.wav python3 music.py
  rm -rf out/frames-v3; python3 render.py --html showreel-v3.html --out out/frames-v3 --end 495 --workers 6
  encode out/frames-v3 out/doltap-showreel-v3.mp4 495
  python3 mix.py out/events-showreel-v3.json out/mix-v3.wav out/music-v3.wav
  mux out/doltap-showreel-v3.mp4 out/mix-v3.wav out/doltap-showreel-v3-music.mp4
  gif out/frames-v3 out/preview-v3.gif; python3 contact.py out/frames-v3 out/contact-sheet-v3.png "Doltap Wiki showreel v3"
  probe out/doltap-showreel-v3.mp4 out/doltap-showreel-v3-music.mp4; ls -la out/preview-v3.gif out/contact-sheet-v3.png
}
build_v3en() {   # v3 with English on-screen copy; identical timeline, so it reuses v3's music + SFX mix
  [ -f out/mix-v3.wav ] || build_v3
  rm -rf out/frames-v3-en; python3 render.py --html showreel-v3-en.html --out out/frames-v3-en --end 495 --workers 6
  python3 -c "import json,sys; a=json.load(open('out/events-showreel-v3.json')); b=json.load(open('out/events-showreel-v3-en.json')); sys.exit(0 if a==b else 'v3-en events differ from v3')"
  encode out/frames-v3-en out/doltap-showreel-v3-en.mp4 495
  mux out/doltap-showreel-v3-en.mp4 out/mix-v3.wav out/doltap-showreel-v3-en-music.mp4
  $FF -y -loglevel error -framerate 30 -i out/frames-v3-en/%04d.png \
      -vf "fps=12,scale=800:450:flags=lanczos,split[a][b];[a]palettegen=max_colors=96:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" out/readme-showreel-en.gif
  python3 contact.py out/frames-v3-en out/contact-sheet-v3-en.png "Doltap Wiki showreel v3 (English)"
  probe out/doltap-showreel-v3-en.mp4 out/doltap-showreel-v3-en-music.mp4; ls -la out/readme-showreel-en.gif out/contact-sheet-v3-en.png
}
case "${1:-all}" in
  sparse) python3 render.py --html "${2:-showreel.html}" --step 10 --out out/sparse ;;
  v1) build_v1 ;; music) build_music ;; v1m) build_v1m ;; v2) build_v2 ;; v3) build_v3 ;; v3en) build_v3en ;;
  all) build_v1; build_music; build_v1m; build_v2; build_v3; build_v3en ;;
  *) echo "unknown target $1"; exit 1 ;;
esac
