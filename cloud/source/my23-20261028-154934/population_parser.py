from pathlib import Path
def read_panel(path):
    """Parse the 1000 Genomes Phase 3 sample/pop/super_pop panel."""
    lines = [(number, line.strip()) for number, line in enumerate(
        Path(path).read_text(encoding="utf-8-sig").splitlines(), 1) if line.strip()]
    if not lines:
        raise ValueError(f"{path}: empty population panel")
    header = [item.lower().lstrip("#") for item in lines[0][1].split()]
    columns = {name: index for index, name in enumerate(header)}
    if not {"sample", "pop", "super_pop"}.issubset(columns):
        raise ValueError(f"{path}: expected sample pop super_pop columns, got: {header}")
    panel = {}
    for number, line in lines[1:]:
        if line.startswith("#"):
            continue
        fields = line.split()
        if len(fields) != len(header):
            raise ValueError(f"{path}:{number}: expected {len(header)} columns, got {len(fields)}")
        sample, pop, broad = (fields[columns[key]] for key in ("sample", "pop", "super_pop"))
        if not all((sample, pop, broad)) or sample in panel:
            raise ValueError(f"{path}:{number}: blank label or duplicate sample ID")
        panel[sample] = (pop, broad)
    if not panel:
        raise ValueError(f"{path}: no population rows")
    pop_broad = {}
    for pop, broad in panel.values():
        if pop in pop_broad and pop_broad[pop] != broad:
            raise ValueError(f"Population {pop} has inconsistent broad groups")
        pop_broad[pop] = broad
    return panel
