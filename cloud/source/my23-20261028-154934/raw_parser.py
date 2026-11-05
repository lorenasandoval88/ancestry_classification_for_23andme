import csv,gzip,re
from pathlib import Path
import numpy as np
BASES=set('ACGT')
COMP=str.maketrans('ACGT','TGCA')
BUILD_RE=re.compile(r'(?:\bbuild\s*[:=]?\s*|\bgrch\s*)(3[678])\b',re.I)
def load_markers(path):
    with Path(path).open(newline="") as f:
        records = list(csv.DictReader(f, delimiter="\t"))
    if not records or set(records[0]) != {"variant_id", "counted_allele"}:
        raise ValueError("Invalid Step 5 selected_markers.tsv")
    markers, sites = [], {}
    for i, row in enumerate(records):
        fields = row["variant_id"].split(":")
        if (len(fields) != 4 or not fields[0].isdigit() or not fields[1].isdigit()
                or not 1 <= int(fields[0]) <= 22 or int(fields[1]) < 1
                or fields[2] not in BASES or fields[3] not in BASES
                or fields[2] == fields[3] or row["counted_allele"] != fields[2]):
            raise ValueError(f"Invalid Step 5 marker at row {i + 2}")
        key = int(fields[0]), int(fields[1])
        markers.append((row["variant_id"], row["counted_allele"]))
        sites.setdefault(key, []).append((i, fields[2], fields[3]))
    if len({v for v, _ in markers}) != len(markers):
        raise ValueError("Duplicate selected model marker IDs")
    # Multiple reference alleles at the same coordinate cannot be assigned
    # confidently from one chip genotype; leave those model entries missing.
    unique = {key: entries[0] for key, entries in sites.items() if len(entries) == 1}
    return markers, unique, len(markers) - len(unique)

def parse_genotypes(path, sites, marker_count):
    vector = np.full(marker_count, np.nan, dtype=np.float32)
    seen = {}
    builds = set()
    counts = {"rows": 0, "matched_coordinates": 0, "no_calls": 0,
              "incompatible_alleles": 0, "possible_opposite_strand": 0,
              "duplicate_rows": 0, "conflicting_duplicates": 0, "malformed_rows": 0}
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "rt", encoding="utf-8-sig", errors="replace") as source:
        for line in source:
            line = line.strip()
            if not line:
                continue
            if line.startswith("#"):
                builds.update(BUILD_RE.findall(line))
                continue
            columns = line.split()
            if len(columns) >= 4 and columns[0].lower() == "rsid":
                continue
            counts["rows"] += 1
            if len(columns) != 4:
                counts["malformed_rows"] += 1
                continue
            chrom = columns[1].removeprefix("chr")
            if not chrom.isdigit() or not columns[2].isdigit():
                continue
            key = int(chrom), int(columns[2])
            if key not in sites:
                continue
            genotype = columns[3].upper()
            if key in seen:
                counts["duplicate_rows"] += 1
                if genotype != seen[key] and seen[key] != "CONFLICT":
                    counts["conflicting_duplicates"] += 1
                    seen[key] = "CONFLICT"
                continue
            seen[key] = genotype
    counts["matched_coordinates"] = len(seen)
    for key, genotype in seen.items():
        i, ref, alt = sites[key]
        if genotype in {"--", "NN", "00", "CONFLICT"}:
            counts["no_calls"] += 1
        elif len(genotype) == 2 and set(genotype) <= {ref, alt}:
            vector[i] = genotype.count(ref)  # Same REF dosage as PLINK --export A.
        elif (len(genotype) == 2 and set(genotype) <= BASES
              and set(genotype.translate(COMP)) <= {ref, alt}):
            counts["possible_opposite_strand"] += 1
            counts["incompatible_alleles"] += 1  # Do not silently flip raw calls.
        else:
            counts["incompatible_alleles"] += 1
    counts["called_model_markers"] = int(np.isfinite(vector).sum())
    counts["called_fraction"] = counts["called_model_markers"] / marker_count
    counts["incompatible_fraction_of_matched_coordinates"] = (
        counts["incompatible_alleles"] / len(seen) if seen else 0.0
    )
    return vector, sorted(builds), counts
