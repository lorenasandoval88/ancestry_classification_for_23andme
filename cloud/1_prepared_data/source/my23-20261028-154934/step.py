import json
import os
from pathlib import Path
import tempfile
from common import HERE, STEPS, get, identity, info, json_file, run


def execute(ctx):
    cfg = ctx.cfg
    source = HERE/STEPS[0]/'source'
    for uri, expected in cfg['reference_objects'].items():
        if identity(info(uri)) != expected:
            raise ValueError(f'Reference object changed after staging: {uri}')
    with tempfile.TemporaryDirectory() as d:
        expected = json_file(cfg['reference_objects'], Path(d)/'references.json')
        old = os.environ.get('EXPECTED_REFERENCES_PATH')
        os.environ['EXPECTED_REFERENCES_PATH'] = str(expected)
        try:
            run(['node', source/'prepare.js', '--input-prefix', cfg['reference_root'],
                 '--manifest', cfg['staged_inputs']['manifest']['uri'], '--output-prefix', ctx.dest,
                 '--train-ids', cfg['staged_inputs']['train']['uri'],
                 '--test-ids', cfg['staged_inputs']['test']['uri'], '--threads', cfg['threads']])
        finally:
            if old is None:
                os.environ.pop('EXPECTED_REFERENCES_PATH', None)
            else:
                os.environ['EXPECTED_REFERENCES_PATH'] = old
        # Register the existing preparation outputs without making more copies.
        names = ['reports/prepare_summary.json', '_PREPARED.json']
        for n in range(1, 23):
            names += [f'chromosomes/chr{n}/{name}' for name in
                      [f'chr{n}.pgen', f'chr{n}.pvar.zst', f'chr{n}.psam',
                       'variant_map.tsv.gz', 'summary.json', '_SUCCESS.json']]
        for name in names:
            uri = f'{ctx.dest}/{name}'
            ctx.outputs[uri] = identity(info(uri))
        for n in range(1,23):
            done=json.loads(get(f'{ctx.dest}/chromosomes/chr{n}/_SUCCESS.json',Path(d)/'done.json').read_text())
            for uri,expected in done['objects'].items():
                actual=info(uri)
                if any(str(actual.get(k))!=str(expected.get(k)) for k in ['generation','size','md5Hash']):
                    raise ValueError(f'Prepared chromosome output changed: {uri}')

