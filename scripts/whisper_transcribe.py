#!/usr/bin/env python3
"""
Transcribe un audio con faster-whisper y emite JSON {segments:[{start,end,text}]} por stdout.
Diseñado para CPU (VPS 4 vCPU, sin GPU). Modelo por defecto: large-v3-turbo int8.

Uso:
  python3 whisper_transcribe.py audio.mp3 --model large-v3-turbo --compute int8 --lang es --threads 3
"""
import argparse
import json
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("audio")
    ap.add_argument("--model", default="large-v3-turbo")
    ap.add_argument("--compute", default="int8")
    ap.add_argument("--lang", default="es")
    ap.add_argument("--threads", type=int, default=3)
    args = ap.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print("ERROR: faster-whisper no instalado. pip install faster-whisper", file=sys.stderr)
        return 2

    model = WhisperModel(
        args.model,
        device="cpu",
        compute_type=args.compute,
        cpu_threads=args.threads,
    )

    segments, info = model.transcribe(
        args.audio,
        language=args.lang,
        vad_filter=True,
        vad_parameters={"min_silence_duration_ms": 500},
        beam_size=5,
    )

    out = {
        "language": info.language,
        "duration": info.duration,
        "segments": [
            {"start": round(s.start, 3), "end": round(s.end, 3), "text": s.text.strip()}
            for s in segments
        ],
    }
    # JSON al final del stdout (el runner busca el primer '{')
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
