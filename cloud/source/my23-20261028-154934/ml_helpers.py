import csv,json,tempfile
from pathlib import Path
import numpy as np
from sklearn.model_selection import StratifiedGroupKFold
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler
from sklearn.decomposition import PCA
from sklearn.linear_model import LogisticRegression
from sklearn.pipeline import Pipeline
from sklearn.metrics import accuracy_score,balanced_accuracy_score
def make_folds(y, groups, n=3):
    folds = list(StratifiedGroupKFold(n_splits=n, shuffle=True, random_state=2026).split(
        np.zeros(len(y)), y, groups))
    for training, validation in folds:
        if set(np.asarray(groups)[training]) & set(np.asarray(groups)[validation]):
            raise ValueError("A related training group crosses CV folds")
        if set(y[training]) != set(y):
            raise ValueError("A CV training fold lacks a broad population group")
    return folds

def cross_validate(X, y, groups):
    folds = make_folds(y, groups)
    choices = [(k, c) for k in (10, 20) for c in (0.1, 1.0)]
    results = {(k, c): [] for k, c in choices}
    for fold, (training, validation) in enumerate(folds, 1):
        imputer = SimpleImputer(strategy="mean", keep_empty_features=True)
        a = imputer.fit_transform(np.array(X[training], dtype=np.float32))
        b = imputer.transform(np.array(X[validation], dtype=np.float32))
        scale = StandardScaler()
        a = scale.fit_transform(a)
        b = scale.transform(b)
        pca = PCA(n_components=20, svd_solver="randomized", random_state=2026)
        a = pca.fit_transform(a)
        b = pca.transform(b)
        for k, c in choices:
            clf = LogisticRegression(C=c, max_iter=1000)
            clf.fit(a[:, :k], y[training])
            predicted = clf.predict(b[:, :k])
            results[(k, c)].append({"fold": fold, "components": k, "C": c,
                                    "accuracy": float(accuracy_score(y[validation], predicted)),
                                    "balanced_accuracy": float(balanced_accuracy_score(y[validation], predicted)),
                                    "validation_samples": len(validation)})
        print(f"CV fold {fold}/{len(folds)} completed", flush=True)
    scores = []
    for (k, c), values in results.items():
        scores.append({"components": k, "C": c,
                       "mean_balanced_accuracy": float(np.mean([v["balanced_accuracy"] for v in values])),
                       "mean_accuracy": float(np.mean([v["accuracy"] for v in values])),
                       "folds": values})
    best = max(scores, key=lambda r: (r["mean_balanced_accuracy"], r["mean_accuracy"],
                                      -r["components"], -r["C"]))
    return best, scores

def fit_model(X, y, k, c):
    pipe = Pipeline([
        ("imputer", SimpleImputer(strategy="mean", keep_empty_features=True)),
        ("scale", StandardScaler()),
        ("pca", PCA(n_components=k, svd_solver="randomized", random_state=2026)),
        ("classifier", LogisticRegression(C=c, max_iter=1000)),
    ])
    pipe.fit(X, y)
    return pipe
def parse_raw(path, expected, id_to_row, matrix, offset):
    with Path(path).open(encoding="ascii") as f:
        header = f.readline().split()
        if header[:2] != ["FID", "IID"] or len(header) != len(expected) + 6:
            raise ValueError("Unexpected PLINK exported genotype columns")
        observed = []
        for entry in header[6:]:
            variant, sep, allele = entry.rpartition("_")
            if not sep or len(variant.split(":")) != 4 or allele != variant.split(":")[2]:
                raise ValueError("PLINK exported a different counted allele")
            observed.append((variant, allele))
        if len(set(observed)) != len(observed) or set(observed) != set(expected):
            raise ValueError("PLINK exported different test marker IDs")
        order = {variant: offset + i for i, (variant, _) in enumerate(expected)}
        cols = np.array([order[v] for v, _ in observed])
        seen = set()
        for line in f:
            parts = line.rstrip("\n").split(maxsplit=6)
            if len(parts) != 7 or parts[1] not in id_to_row or parts[1] in seen:
                raise ValueError("Missing, extra, or repeated test sample")
            seen.add(parts[1])
            values = np.fromstring(parts[6].replace("NA", "nan"), sep=" ", dtype=np.float32)
            if len(values) != len(cols) or np.isinf(values).any() or np.any((values < 0) | (values > 2)):
                raise ValueError("Unexpected test genotype value")
            matrix[id_to_row[parts[1]], cols] = values
        if seen != set(id_to_row):
            raise ValueError("Not all expected test people were exported")
