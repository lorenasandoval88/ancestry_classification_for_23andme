import csv,json,hashlib
from pathlib import Path
SECOND_DEGREE_CUTOFF=0.0884
FIRST_DEGREE_CUTOFF=0.177
PAIR_COLUMNS=['ID1','ID2','KINSHIP','RT']
def read_ids(path):
    ids = []
    for number, raw in enumerate(Path(path).read_text(encoding="utf-8-sig").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        fields = line.split()
        if fields == ["IID"] or fields == ["FID", "IID"]:
            continue
        if len(fields) not in (1, 2):
            raise ValueError(f"{path}:{number}: expected IID or FID IID")
        ids.append(fields[-1])
    if not ids or len(ids) != len(set(ids)):
        raise ValueError(f"{path}: empty or duplicate sample IDs")
    return set(ids)

def sha256(path):
    digest = hashlib.sha256()
    with open(path, "rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

def check(train_file, test_file, kin_file):
    train, test = read_ids(train_file), read_ids(test_file)
    if len(train) != 2003 or len(test) != 501:
        raise ValueError(f"Expected 2003 train and 501 test IDs; got {len(train)} and {len(test)}")
    if train & test:
        raise ValueError(f"Train and test overlap: {sorted(train & test)[:5]}")

    rows = []
    unmatched = []
    seen = set()
    total_report_pairs = 0
    with open(kin_file, encoding="utf-8-sig") as source:
        header = None
        for number, raw in enumerate(source, 1):
            line = raw.strip()
            if not line:
                continue
            if header is None:
                header = line.removeprefix("#").split()
                if len(header) != len(set(header)) or any(key not in header for key in PAIR_COLUMNS[:3]):
                    raise ValueError(f"{kin_file}: missing ID1, ID2 or KINSHIP header; check download")
                if header == ["html"] or "<html" in line.lower():
                    raise ValueError(f"{kin_file}: received HTML instead of a PLINK .kin0 table")
                continue
            if line.startswith("#"):
                continue
            fields = line.split()
            if len(fields) != len(header):
                raise ValueError(f"{kin_file}:{number}: expected {len(header)} columns; got {len(fields)}")
            row = dict(zip(header, fields))
            id1, id2 = row["ID1"], row["ID2"]
            try:
                kinship = float(row["KINSHIP"])
            except ValueError as exc:
                raise ValueError(f"{kin_file}:{number}: invalid KINSHIP") from exc
            if not (-1 <= kinship <= 1):
                raise ValueError(f"{kin_file}:{number}: invalid KINSHIP range")
            if id1 == id2 or tuple(sorted((id1, id2))) in seen:
                raise ValueError(f"{kin_file}:{number}: duplicate or self-pair")
            seen.add(tuple(sorted((id1, id2))))
            total_report_pairs += 1
            if kinship < SECOND_DEGREE_CUTOFF:
                # A separately produced .kin0 may contain additional, weaker pairs.
                continue
            if id1 not in train | test or id2 not in train | test:
                unmatched.append({"id1": id1, "id2": id2, "kinship": kinship})
                continue
            set1 = "train" if id1 in train else "test"
            set2 = "train" if id2 in train else "test"
            rows.append({
                "id1": id1, "id2": id2, "kinship": kinship,
                "king_range": "first_degree_range" if kinship >= FIRST_DEGREE_CUTOFF else "second_degree_range",
                "reported_relationship": row.get("RT", ""), "set1": set1, "set2": set2,
            })

    if total_report_pairs == 0 or not rows:
        raise ValueError("No close relative pairs matched the split; verify this is the original Phase 3 PLINK report")
    rows.sort(key=lambda r: (min(r["id1"], r["id2"]), max(r["id1"], r["id2"])))
    crossed = [row for row in rows if row["set1"] != row["set2"]]
    summary = {
        "source": "PLINK 2 resources: original 1000 Genomes Phase 3 deg2_phase3.kin0",
        "source_url": "https://www.cog-genomics.org/plink/2.0/resources",
        "train_samples": len(train), "test_samples": len(test),
        "all_sample_ids": len(train | test), "train_test_overlap": 0,
        "source_rows": total_report_pairs,
        "close_pairs_with_both_people_in_split": len(rows),
        "close_pairs_with_one_or_both_people_outside_split": len(unmatched),
        "train_train_pairs": sum(r["set1"] == r["set2"] == "train" for r in rows),
        "test_test_pairs": sum(r["set1"] == r["set2"] == "test" for r in rows),
        "cross_split_pairs": len(crossed),
        "cross_split_people": len({id_ for r in crossed for id_ in (r["id1"], r["id2"])}),
        "review_needed": bool(crossed or unmatched),
        "note": "KINSHIP ranges use PLINK cutoffs 0.177 and 0.0884; check pairs before changing the saved split.",
        "input_sha256": {Path(p).name: sha256(p) for p in (train_file, test_file, kin_file)},
    }
    return rows, crossed, unmatched, summary
