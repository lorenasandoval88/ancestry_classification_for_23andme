"""Build genotype matrices with the same SNP order and counted REF alleles."""
import csv
import json
from pathlib import Path
import shutil
import numpy as np
from common import get, ids, psam, run, sha
from ml_helpers import parse_raw


def selected_markers(ctx, tmp):
    markers = []
    for n in range(1, 23):
        path = get(ctx.result(4, f'chromosomes/chr{n}/selected_markers.txt'), tmp/f'chr{n}.ids')
        values = path.read_text().split()
        if not values or any(not v.startswith(f'{n}:') for v in values):
            raise ValueError('Invalid chromosome marker list')
        markers.extend((v, v.split(':')[2]) for v in values)
    if len({v for v,a in markers}) != len(markers):
        raise ValueError('Repeated marker IDs')
    return markers


def matrix(ctx, people, keep_file, markers, tmp):
    x = np.memmap(tmp/'genotypes.float32.dat', mode='w+', dtype=np.float32,
                  shape=(len(people), len(markers)))
    x[:] = np.nan
    offset = 0
    row = {s: i for i,s in enumerate(people)}
    for n in range(1, 23):
        folder = tmp/f'chr{n}'
        folder.mkdir()
        source = folder/f'chr{n}'
        for ext in ['pgen', 'pvar.zst', 'psam']:
            get(ctx.result(1, f'chromosomes/chr{n}/chr{n}.{ext}'), Path(f'{source}.{ext}'))
        if len(psam(Path(f'{source}.psam'))) != 2504 or not set(people) <= set(psam(Path(f'{source}.psam'))):
            raise ValueError(f'chr{n} reference sample identities changed')
        expected = [(v,a) for v,a in markers if v.startswith(f'{n}:')]
        if not expected:
            raise ValueError(f'No selected SNPs on chr{n}')
        extract, alleles = folder/'selected.txt', folder/'counted_alleles.tsv'
        extract.write_text('\n'.join(v for v,a in expected)+'\n')
        alleles.write_text('\n'.join(f'{v}\t{a}' for v,a in expected)+'\n')
        out = folder/'dosages'
        run(['plink2', '--pfile', source, 'vzs', '--keep', keep_file, '--extract', extract,
             '--export', 'A', '--export-allele', alleles, '--threads', ctx.cfg['threads'],
             '--memory', ctx.cfg['plink_memory_mb'], '--out', out])
        parse_raw(Path(f'{out}.raw'), expected, row, x, offset)
        offset += len(expected)
        shutil.rmtree(folder)
        print(f'Loaded chr{n}: {offset}/{len(markers)} SNPs for {len(people)} people', flush=True)
    if offset != len(markers):
        raise ValueError('Incomplete genotype matrix')
    x.flush()
    return x


def save_markers(path, markers):
    with Path(path).open('w', newline='') as f:
        w = csv.writer(f, delimiter='\t', lineterminator='\n')
        w.writerow(['variant_id','counted_allele'])
        w.writerows(markers)


def load_bundle(ctx, tmp):
    import joblib
    import sklearn
    done = json.loads(get(ctx.result(5, 'model_checksums.json'), tmp/'checksums.json').read_text())
    model_path = get(ctx.result(5, 'model.joblib'), tmp/'model.joblib')
    if sha(model_path) != done['model_sha256']:
        raise ValueError('Frozen model checksum mismatch')
    report = json.loads(get(ctx.result(5, 'training_summary.json'), tmp/'training_summary.json').read_text())
    if report['sklearn_version'] != sklearn.__version__ or report['training_people'] != 2003 or report['test_people_used'] != 0:
        raise ValueError('Wrong model or incompatible Python environment')
    bundle = joblib.load(model_path)  # Only this run's authenticated training artifact.
    if (bundle['model_name'] != 'my23_v5_ancestry_model' or bundle['training_people'] != 2003
            or len(bundle['markers']) != report['selected_markers']
            or list(bundle['pipeline'].classes_) != bundle['classes']
            or bundle['pipeline'].n_features_in_ != len(bundle['markers'])):
        raise ValueError('Frozen model and metadata disagree')
    marker_file = get(ctx.result(5, 'selected_markers.tsv'), tmp/'selected_markers.tsv')
    if sha(marker_file) != done['markers_sha256']:
        raise ValueError('Frozen marker list changed')
    from raw_parser import load_markers
    if load_markers(marker_file)[0] != bundle['markers']:
        raise ValueError('Ordered marker list disagrees with the model')
    return bundle, done

