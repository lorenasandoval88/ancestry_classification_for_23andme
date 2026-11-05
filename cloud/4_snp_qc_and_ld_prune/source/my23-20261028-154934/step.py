import json
import os
from pathlib import Path
import tempfile
from common import get, identity, info, json_file, pvar, psam, run, ids, sha, put


def execute(ctx):
    cfg = ctx.cfg
    summaries = []
    for n in range(1, 23):
        sub = f'chromosomes/chr{n}'
        checkpoint = f'{ctx.dest}/{sub}/_SUCCESS.json'
        if info(checkpoint, False):
            with tempfile.TemporaryDirectory() as d:
                done = json.loads(get(checkpoint, Path(d)/'done.json').read_text())
            if done['config_sha256'] != ctx.signature:
                raise ValueError('Chromosome checkpoint used different settings')
            for uri, expected in done['objects'].items():
                if identity(info(uri)) != expected:
                    raise ValueError(f'Changed chromosome output: {uri}')
                ctx.outputs[uri] = expected
            ctx.outputs[checkpoint] = identity(info(checkpoint))
            summaries.append(done['summary'])
            continue
        with tempfile.TemporaryDirectory(prefix=f'qc-chr{n}-') as d:
            tmp = Path(d)
            source = tmp/f'chr{n}'
            for ext in ['pgen','pvar.zst','psam']:
                get(ctx.result(1, f'chromosomes/chr{n}/chr{n}.{ext}'), Path(f'{source}.{ext}'))
            keep = get(ctx.result(2, 'train2003.keep'), tmp/'train.keep')
            if len(psam(Path(f'{source}.psam'))) != 2504:
                raise ValueError('Wrong reference sample count')
            initial = pvar(Path(f'{source}.pvar.zst'))
            qc = tmp/'qc'
            common = ['--threads', cfg['threads'], '--memory', cfg['plink_memory_mb']]
            run(['plink2', '--pfile', source, 'vzs', '--keep', keep,
                 '--geno', cfg['qc']['max_missing_fraction'], '--maf', cfg['qc']['min_maf'],
                 *common, '--make-pgen', 'vzs', '--out', qc])
            retained = pvar(Path(f'{qc}.pvar.zst'))
            if set(psam(Path(f'{qc}.psam'))) != set(ids(keep)):
                raise ValueError('QC did not use the exact training set')
            ld = tmp/'ld'
            run(['plink2', '--pfile', qc, 'vzs', '--indep-pairwise', cfg['qc']['ld_window'],
                 cfg['qc']['ld_r2'], *common, '--out', ld])
            selected_set = set(Path(f'{ld}.prune.in').read_text().split())
            selected = [v for v in initial if v in selected_set]
            if not selected or not selected_set <= set(retained):
                raise ValueError('Invalid LD-pruned marker set')
            (tmp/'selected_markers.txt').write_text('\n'.join(selected)+'\n')
            retained_set = set(retained)
            (tmp/'qc_removed.txt').write_text('\n'.join(v for v in initial if v not in retained_set)+'\n')
            summary = {'chromosome': n, 'training_people': 2003, 'test_people_used': 0,
                       'initial_snps': len(initial), 'after_qc': len(retained), 'after_pruning': len(selected),
                       'selected_markers_sha256': sha(tmp/'selected_markers.txt')}
            json_file(summary, tmp/'summary.json')
            objects = {}
            attempt = os.environ.get('CLOUD_RUN_EXECUTION',tmp.name) + '-' + os.environ.get('CLOUD_RUN_TASK_ATTEMPT','0')
            for filename, path in [('selected_markers.txt',tmp/'selected_markers.txt'),
                                   ('qc_removed.txt',tmp/'qc_removed.txt'), ('ld_pruned_out.txt', Path(f'{ld}.prune.out')),
                                   ('summary.json', tmp/'summary.json'), ('qc.log', Path(f'{qc}.log')),
                                   ('ld.log', Path(f'{ld}.log'))]:
                uri = ctx.publish(path, f'{sub}/attempts/{attempt}/{filename}' if filename.endswith('.log') else f'{sub}/{filename}')
                objects[uri] = ctx.outputs[uri]
            done = json_file({'complete': True, 'config_sha256': ctx.signature, 'summary': summary,
                              'objects': objects}, tmp/'done.json')
            ctx.publish(done, f'{sub}/_SUCCESS.json')
            summaries.append(summary)
            print(f"chr{n}: {len(initial)} -> {len(retained)} QC -> {len(selected)} pruned SNPs", flush=True)
    with tempfile.TemporaryDirectory() as d:
        totals = {k: sum(s[k] for s in summaries) for k in ['initial_snps','after_qc','after_pruning']}
        ctx.publish(json_file({'training_people': 2003, 'test_people_used': 0, 'settings': cfg['qc'],
                               'counts': totals, 'chromosomes': summaries}, Path(d)/'marker_summary.json'))
