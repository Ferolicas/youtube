#!/usr/bin/env python3
"""
Clustering temático de vídeos por TF-IDF + KMeans (scikit-learn).
Entrada: JSON {videos:[{id,text,format,views,retention,rpm}]} (ruta como arg).
Salida (stdout): JSON {clusters:[{label,keywords,members:[{video_id,distance}]}]}.

Es ligero (sin modelos grandes) y corre en CPU. Si prefieres embeddings semánticos,
sustituye TfidfVectorizer por sentence-transformers (multilingüe).
"""
import json
import math
import sys

SPANISH_STOP = [
    "de", "la", "que", "el", "en", "y", "a", "los", "del", "se", "las", "por",
    "un", "para", "con", "no", "una", "su", "al", "lo", "como", "mas", "más",
    "pero", "sus", "le", "ya", "o", "este", "si", "porque", "esta", "entre",
    "cuando", "muy", "sin", "sobre", "tambien", "también", "me", "hasta", "hay",
    "donde", "quien", "desde", "todo", "nos", "durante", "uno", "ni", "contra",
    "ese", "eso", "ante", "ellos", "e", "esto", "mi", "antes", "algunos", "que",
    "es", "son", "fue", "ser", "vamos", "voy", "aqui", "aquí", "asi", "así",
    "bueno", "hola", "video", "vídeo", "canal", "hoy", "vez", "va", "ver",
]


def main() -> int:
    if len(sys.argv) < 2:
        print("uso: cluster_videos.py input.json", file=sys.stderr)
        return 2
    try:
        from sklearn.feature_extraction.text import TfidfVectorizer
        from sklearn.cluster import KMeans
        import numpy as np
    except ImportError:
        print("ERROR: scikit-learn/numpy no instalados.", file=sys.stderr)
        return 3

    with open(sys.argv[1], "r", encoding="utf-8") as f:
        data = json.load(f)
    videos = data["videos"]
    texts = [v["text"] for v in videos]
    ids = [v["id"] for v in videos]

    vec = TfidfVectorizer(
        stop_words=SPANISH_STOP, max_features=4000, ngram_range=(1, 2), min_df=2
    )
    try:
        X = vec.fit_transform(texts)
    except ValueError:
        # vocabulario vacío
        print(json.dumps({"clusters": []}))
        return 0

    n = len(videos)
    k = max(2, min(12, int(math.sqrt(n / 2))))
    km = KMeans(n_clusters=k, random_state=42, n_init=10)
    labels = km.fit_predict(X)
    centers = km.cluster_centers_
    terms = vec.get_feature_names_out()

    clusters = []
    for c in range(k):
        idxs = [i for i in range(n) if labels[i] == c]
        if not idxs:
            continue
        top_idx = centers[c].argsort()[::-1][:6]
        keywords = [terms[t] for t in top_idx]
        members = []
        for i in idxs:
            dist = float(np.linalg.norm(X[i].toarray()[0] - centers[c]))
            members.append({"video_id": ids[i], "distance": round(dist, 4)})
        clusters.append({
            "label": ", ".join(keywords[:3]),
            "keywords": keywords,
            "members": members,
        })

    print(json.dumps({"clusters": clusters}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
